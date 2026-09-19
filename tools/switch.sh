#!/bin/sh
# Переключение Legacy -> proxyrules. Выполняется на роутере (его запускает router.sh).
#
#   sh switch.sh            переключить
#   sh switch.sh rollback   вернуть Legacy
#
# Страховка: перед переключением запускается отдельный процесс. Если за
# GUARD_SECONDS переключение не подтвердилось (ошибка, скрипт упал, SSH оборвался),
# он сам возвращает Legacy.

GUARD_SECONDS=90
OK=/tmp/proxyrules-switch.ok
SELF=/tmp/proxyrules-switch.sh

say() {
	echo "$*"
	logger -t proxyrules "switch: $*"
}

rollback() {
	/etc/init.d/proxyrules stop
	/etc/init.d/proxyrules disable
	/etc/init.d/legacy enable
	/etc/init.d/legacy start
}

case "$1" in
rollback)
	rollback
	say "Legacy снова работает"
	exit 0
	;;
guard)
	sleep "$GUARD_SECONDS"
	[ -f "$OK" ] && exit 0
	say "переключение не подтверждено за $GUARD_SECONDS с — откат на Legacy"
	rollback
	exit 0
	;;
esac

if [ ! -f /etc/proxyrules.conf ]; then
	say "нет /etc/proxyrules.conf — сначала ./router.sh install"
	exit 1
fi

rm -f "$OK"
cp "$0" "$SELF" 2>/dev/null
# setsid — своя сессия: закрытие SSH её не заденет (nohup в busybox роутера нет)
setsid sh "$SELF" guard </dev/null >/dev/null 2>&1 &
say "страховка запущена: откат через $GUARD_SECONDS с, если не будет подтверждения"

fail_and_rollback() {
	say "не получилось: $1 — откат на Legacy"
	logread -e proxyrules | tail -15
	rollback
	touch "$OK"          # откат сделан, страховке делать нечего
	exit 1
}

say "останавливаю Legacy"
/etc/init.d/legacy stop
/etc/init.d/legacy disable

say "запускаю proxyrules"
/etc/init.d/proxyrules start || fail_and_rollback "сервис не запустился"

sleep 20

fail=""
/etc/init.d/proxyrules running || fail="$fail сервис;"
nft list table inet proxyrules >/dev/null 2>&1 || fail="$fail nftables;"
nslookup upwork.com 127.0.0.1 2>/dev/null | grep -q '198\.1[89]\.' || fail="$fail fake-ip;"
nslookup ya.ru 127.0.0.1 2>/dev/null | grep -q '^Name:' || fail="$fail DNS;"
jq -e '[.nodes[] | select(.up == true)] | length > 0' /var/run/proxyrules/status.json >/dev/null 2>&1 ||
	fail="$fail ни одно соединение не отвечает;"
# весь путь: fake-ip -> nft -> tproxy -> sing-box -> прокси (github.com в правилах)
code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' https://github.com/)
[ "$code" != "000" ] || fail="$fail github.com через прокси не открылся;"

[ -z "$fail" ] || fail_and_rollback "$fail"

/etc/init.d/proxyrules enable
touch "$OK"
say "proxyrules работает (github.com: HTTP $code)"
jq -c '.chains | map_values(.active)' /var/run/proxyrules/status.json
