#!/usr/bin/env bash
# Управление proxyrules на роутере с этой машины.
#
#   ./router.sh install DE='vless://…' NL='vless://…'
#                                        скопировать файлы, собрать /etc/proxyrules.conf из
#                                        примера, подставив ссылки соединений. Ничего не запускает.
#   ./router.sh update                   поставить файлы из рабочей копии (конфиг и сервис
#                                        не трогает; версия — из git describe)
#   ./router.sh start                    (пере)запустить proxyrules и проверить; если проверка
#                                        не прошла — остановить его (интернет напрямую)
#   ./router.sh stop                     остановить proxyrules (интернет напрямую)
#   ./router.sh uninstall                остановить и удалить proxyrules
#
# HOST можно переопределить: HOST=root@10.0.0.1 ./router.sh …
set -euo pipefail

HOST=${HOST:-root@192.168.1.1}
cd "$(dirname "$0")"

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

# Архив из рабочей копии (tools/build.sh) ставится тем же install.sh, что и релизы.
# Работающий сервис не перезапускается.
install_files() {
	local tmp
	tmp=$(mktemp -d)
	tools/build.sh "$tmp/proxyrules.tar.gz"
	remote 'cat > /tmp/proxyrules.tar.gz' < "$tmp/proxyrules.tar.gz"
	remote 'cat > /tmp/proxyrules-install.sh && sh -n /tmp/proxyrules-install.sh' < install.sh
	rm -rf "$tmp"
	remote 'sh /tmp/proxyrules-install.sh --file /tmp/proxyrules.tar.gz --no-restart; rc=$?
		rm -f /tmp/proxyrules.tar.gz /tmp/proxyrules-install.sh; exit $rc'
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
	(( $# )) || { echo "нужны ссылки: ./router.sh install DE='vless://…' NL='vless://…'" >&2; exit 1; }
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
		rm -f /etc/init.d/proxyrules /etc/proxyrules.conf.example /usr/share/rpcd/ucode/proxyrules.uc \
			/usr/share/rpcd/acl.d/luci-app-proxyrules.json /usr/share/luci/menu.d/luci-app-proxyrules.json
		rm -rf /usr/share/proxyrules /var/run/proxyrules /www/luci-static/resources/view/proxyrules \
			/tmp/luci-indexcache* /tmp/luci-modulecache
		/etc/init.d/rpcd reload
		echo 'удалено; /etc/proxyrules.conf и /etc/proxyrules/ оставлены'"
	;;

*)
	sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
	;;
esac
