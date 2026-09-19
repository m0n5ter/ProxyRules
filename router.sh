#!/usr/bin/env bash
# Управление proxyrules на роутере с этой машины.
#
#   ./router.sh install 'vless://…#DE'   скопировать файлы, собрать /etc/proxyrules.conf из
#                                        настроек Legacy (TR, UK) + ссылки DE. Ничего не запускает.
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

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

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
	if grep -lI $'\r' "${FILES[@]/#/files/}"; then echo "в файлах выше CRLF" >&2; exit 1; fi

	tar -C files -cf - "${FILES[@]}" | remote '
		set -e
		mkdir -p /usr/share/proxyrules /usr/share/rpcd/ucode /usr/share/rpcd/acl.d \
			/usr/share/luci/menu.d /www/luci-static/resources/view
		tar -C / -xf -
		chown root:root '"$(printf '/%s ' "${FILES[@]}")"'
		chmod 755 /etc/init.d/proxyrules
		mkdir -p /etc/proxyrules && chmod 700 /etc/proxyrules
		rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
		/etc/init.d/rpcd reload
		echo "файлы установлены"'

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
		rm -rf /usr/share/proxyrules /var/run/proxyrules /tmp/luci-indexcache* /tmp/luci-modulecache
		/etc/init.d/rpcd reload
		echo 'удалено; /etc/proxyrules.conf и /etc/proxyrules/ оставлены'"
	;;

*)
	sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
	;;
esac
