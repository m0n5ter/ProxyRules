#!/bin/sh
# Запуск (или перезапуск) proxyrules с проверкой. Выполняется на роутере (его запускает router.sh).
#
# Страховка: перед запуском стартует отдельный процесс. Если за GUARD_SECONDS
# запуск не подтвердился (ошибка, скрипт упал, SSH оборвался), он останавливает
# proxyrules — роутер остаётся с прямым интернетом, без прокси.

GUARD_SECONDS=90
OK=/tmp/proxyrules-start.ok
SELF=/tmp/proxyrules-start.sh

say() {
	echo "$*"
	logger -t proxyrules "start: $*"
}

stop_all() {
	/etc/init.d/proxyrules stop
	/etc/init.d/proxyrules disable
}

if [ "$1" = guard ]; then
	sleep "$GUARD_SECONDS"
	[ -f "$OK" ] && exit 0
	say "запуск не подтверждён за $GUARD_SECONDS с — proxyrules остановлен, интернет напрямую"
	stop_all
	exit 0
fi

if [ ! -f /etc/proxyrules.conf ]; then
	say "нет /etc/proxyrules.conf — сначала ./router.sh install"
	exit 1
fi

rm -f "$OK"
cp "$0" "$SELF" 2>/dev/null
# setsid — своя сессия: закрытие SSH её не заденет (nohup в busybox роутера нет)
setsid sh "$SELF" guard </dev/null >/dev/null 2>&1 &
say "страховка запущена: остановка через $GUARD_SECONDS с, если не будет подтверждения"

fail_and_stop() {
	say "не получилось: $1 — proxyrules остановлен, интернет напрямую"
	logread -e proxyrules | tail -15
	stop_all
	touch "$OK"          # уже остановлено, страховке делать нечего
	exit 1
}

say "запускаю proxyrules"
/etc/init.d/proxyrules restart || fail_and_stop "сервис не запустился"

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

[ -z "$fail" ] || fail_and_stop "$fail"

/etc/init.d/proxyrules enable
touch "$OK"
say "proxyrules работает (github.com: HTTP $code)"
jq -c '.chains | map_values(.active)' /var/run/proxyrules/status.json
