#!/usr/bin/env bash
# Управление proxyrules на роутере с этой машины.
#
#   ./router.sh install 'vless://…#DE'   скопировать файлы, собрать /etc/proxyrules.conf из
#                                        настроек Legacy (TR, UK) + ссылки DE. Ничего не запускает.
#   ./router.sh update                   только обновить файлы (конфиг и сервис не трогает)
#   ./router.sh switch                   остановить Legacy, запустить proxyrules, проверить;
#                                        если проверка не прошла — сам откатывается на Legacy
#   ./router.sh rollback                 вернуть Legacy
#   ./router.sh uninstall                вернуть Legacy и удалить proxyrules
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

# Переключение и откат делает tools/switch.sh на самом роутере. Он загружается
# и проверяется `sh -n` там же, ДО того как что-либо будет остановлено.
run_switch() {
	if grep -qI $'\r' tools/switch.sh; then echo "в tools/switch.sh CRLF" >&2; exit 1; fi
	remote 'cat > /tmp/proxyrules-switch.sh && sh -n /tmp/proxyrules-switch.sh' < tools/switch.sh
	remote "sh /tmp/proxyrules-switch.sh ${1:-}"
}

case "${1:-}" in
install)
	de=${2:-}
	[[ $de == vless://* ]] || { echo "нужна ссылка DE: ./router.sh install 'vless://…'" >&2; exit 1; }
	install_files

	# Ссылки TR и UK берутся из Legacy прямо на роутере и сюда не передаются.
	remote 'DE=$(cat)
		if [ -f /etc/proxyrules.conf ]; then echo "/etc/proxyrules.conf уже есть — не трогаю"; exit 0; fi
		TR=$(uci get legacy.main.proxy_string) UK=$(uci get legacy.UK.proxy_string) DE="$DE" awk "
			/^TR  = /{print \"TR  = \" ENVIRON[\"TR\"]; next}
			/^UK  = /{print \"UK  = \" ENVIRON[\"UK\"]; next}
			/^DE  = /{print \"DE  = \" ENVIRON[\"DE\"]; next}
			{print}" /etc/proxyrules.conf.example > /etc/proxyrules.conf
		chmod 600 /etc/proxyrules.conf
		ucode /usr/share/proxyrules/gen.uc /etc/proxyrules.conf /tmp/proxyrules-check /tmp/proxyrules-check/lists \
			&& sing-box check -c /tmp/proxyrules-check/config.json && echo "/etc/proxyrules.conf собран и проверен"
		rm -rf /tmp/proxyrules-check' <<<"$de"
	;;

update)
	install_files
	;;

switch)
	run_switch
	;;

rollback)
	run_switch rollback
	;;

uninstall)
	run_switch rollback
	remote "
		set -e
		rm -f /etc/init.d/proxyrules $(printf '/%s ' "${FILES[@]:2}")
		rm -rf /usr/share/proxyrules /var/run/proxyrules /${VIEW%.js} /tmp/luci-indexcache* /tmp/luci-modulecache
		/etc/init.d/rpcd reload
		echo 'удалено; /etc/proxyrules.conf и /etc/proxyrules/ оставлены'"
	;;

*)
	sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
	;;
esac
