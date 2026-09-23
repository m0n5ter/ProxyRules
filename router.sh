#!/usr/bin/env bash
# Управление proxyrules на роутере с этой машины.
#
#   ./router.sh install TR='vless://…' UK='vless://…' DE='vless://…'
#                                        скопировать файлы, собрать /etc/proxyrules.conf из
#                                        примера, подставив ссылки соединений. Ничего не запускает.
#   ./router.sh update                   только обновить файлы (конфиг и сервис не трогает)
#   ./router.sh start                    (пере)запустить proxyrules и проверить; если проверка
#                                        не прошла — остановить его (интернет напрямую)
#   ./router.sh stop                     остановить proxyrules (интернет напрямую)
#   ./router.sh uninstall                остановить и удалить proxyrules
#
# HOST можно переопределить: HOST=root@10.0.0.1 ./router.sh …
set -euo pipefail

HOST=${HOST:-root@192.168.1.1}
cd "$(dirname "$0")"

FILES=(
	etc/init.d/proxyrules
	etc/proxyrules.conf.example
	usr/share/proxyrules/gen.uc
	usr/share/proxyrules/watchdog.uc
	usr/share/rpcd/ucode/proxyrules.uc
	usr/share/rpcd/acl.d/luci-app-proxyrules.json
	usr/share/luci/menu.d/luci-app-proxyrules.json
	www/luci-static/resources/view/proxyrules.js
)

VIEW=www/luci-static/resources/view/proxyrules.js
MENU=usr/share/luci/menu.d/luci-app-proxyrules.json

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

# LuCI грузит страницу как view/<путь>.js?v=<версия LuCI>, и браузер держит старую
# копию, пока не обновится сам LuCI. Поэтому страница ставится под именем с хешем
# содержимого (view/proxyrules/<хеш>.js), а путь в меню переписывается на него.
install_files() {
	if grep -lI $'\r' "${FILES[@]/#/files/}"; then echo "в файлах выше CRLF" >&2; exit 1; fi
	local hash stage
	hash=$(md5sum "files/$VIEW" | cut -c1-8)
	stage=$(mktemp -d)
	tar -C files -cf - "${FILES[@]}" | tar -C "$stage" -xf -
	mkdir -p "$stage/${VIEW%.js}"
	mv "$stage/$VIEW" "$stage/${VIEW%.js}/$hash.js"
	sed -i 's|"path": "proxyrules"|"path": "proxyrules/'"$hash"'"|' "$stage/$MENU"
	grep -q "proxyrules/$hash" "$stage/$MENU" || { echo "не удалось переписать путь в $MENU" >&2; exit 1; }

	tar -C "$stage" -cf - --owner=0 --group=0 etc usr www | remote '
		set -e
		rm -rf /'"$VIEW"' /'"${VIEW%.js}"'
		tar -C / -xf -
		chmod 755 /etc/init.d/proxyrules
		mkdir -p /etc/proxyrules && chmod 700 /etc/proxyrules
		rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
		/etc/init.d/rpcd reload
		echo "файлы установлены, страница '"$hash"'"'
	rm -rf "$stage"
}

# Запуск с проверкой делает tools/start.sh на самом роутере. Он загружается
# и проверяется `sh -n` там же, ДО того как что-либо будет перезапущено.
run_start() {
	if grep -qI $'\r' tools/start.sh; then echo "в tools/start.sh CRLF" >&2; exit 1; fi
	remote 'cat > /tmp/proxyrules-start.sh && sh -n /tmp/proxyrules-start.sh' < tools/start.sh
	remote 'sh /tmp/proxyrules-start.sh'
}

stop_service() {
	remote '/etc/init.d/proxyrules stop; /etc/init.d/proxyrules disable; echo "proxyrules остановлен"'
}

case "${1:-}" in
install)
	shift
	(( $# )) || { echo "нужны ссылки: ./router.sh install TR='vless://…' DE='vless://…'" >&2; exit 1; }
	for a in "$@"; do
		[[ $a =~ ^[A-Za-z0-9-]+=(vless://|iface:). ]] || { echo "не NAME=vless://… или NAME=iface:…: ${a%%=*}" >&2; exit 1; }
	done
	install_files

	# Ссылки идут через stdin (NAME=ссылка построчно), а не в командной строке ssh.
	# Каждая заменяет строку «NAME = …» из примера.
	printf '%s\n' "$@" | remote '
		if [ -f /etc/proxyrules.conf ]; then echo "/etc/proxyrules.conf уже есть — не трогаю"; exit 0; fi
		umask 077
		cat > /tmp/proxyrules-links
		awk "
			NR == FNR { i = index(\$0, \"=\"); link[substr(\$0, 1, i - 1)] = substr(\$0, i + 1); next }
			match(\$0, /^[A-Za-z0-9-]+ *= */) {
				name = substr(\$0, 1, RLENGTH); sub(/ *= *\$/, \"\", name)
				if (name in link) { print substr(\$0, 1, RLENGTH) link[name]; used[name] = 1; next }
			}
			{ print }
			END { for (n in link) if (!(n in used)) { print \"в примере нет соединения \" n > \"/dev/stderr\"; bad = 1 }
			      exit bad }" /tmp/proxyrules-links /etc/proxyrules.conf.example > /tmp/proxyrules.conf.new
		rc=$?
		rm -f /tmp/proxyrules-links
		if [ $rc -ne 0 ]; then rm -f /tmp/proxyrules.conf.new; exit 1; fi
		mv /tmp/proxyrules.conf.new /etc/proxyrules.conf
		ucode /usr/share/proxyrules/gen.uc /etc/proxyrules.conf /tmp/proxyrules-check /tmp/proxyrules-check/lists \
			&& sing-box check -c /tmp/proxyrules-check/config.json && echo "/etc/proxyrules.conf собран и проверен"
		rm -rf /tmp/proxyrules-check'
	;;

update)
	install_files
	;;

start)
	run_start
	;;

stop)
	stop_service
	;;

uninstall)
	stop_service
	remote "
		set -e
		rm -f /etc/init.d/proxyrules $(printf '/%s ' "${FILES[@]:2}")
		rm -rf /usr/share/proxyrules /var/run/proxyrules /${VIEW%.js} /tmp/luci-indexcache* /tmp/luci-modulecache
		/etc/init.d/rpcd reload
		echo 'удалено; /etc/proxyrules.conf и /etc/proxyrules/ оставлены'"
	;;

*)
	sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
	;;
esac
