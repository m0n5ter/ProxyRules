#!/bin/sh
# Start (or restart) proxyrules with a check. Runs on the router (router.sh launches it).
#
# Safety net: a separate process starts first. If the start is not confirmed
# within GUARD_SECONDS (an error, the script died, SSH dropped), it stops
# proxyrules — the router is left with direct internet, no proxy.

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
	say "start not confirmed within $GUARD_SECONDS s — proxyrules stopped, direct internet"
	stop_all
	exit 0
fi

if [ ! -f /etc/proxyrules.conf ]; then
	say "no /etc/proxyrules.conf — run ./router.sh install first"
	exit 1
fi

rm -f "$OK"
cp "$0" "$SELF" 2>/dev/null
# setsid — its own session: closing SSH won't touch it (the router's busybox has no nohup)
setsid sh "$SELF" guard </dev/null >/dev/null 2>&1 &
say "safety net started: stop in $GUARD_SECONDS s unless confirmed"

fail_and_stop() {
	say "failed: $1 — proxyrules stopped, direct internet"
	logread -e proxyrules | tail -15
	stop_all
	touch "$OK"          # already stopped, nothing left for the safety net
	exit 1
}

say "starting proxyrules"
/etc/init.d/proxyrules restart || fail_and_stop "the service did not start"

sleep 20

fail=""
/etc/init.d/proxyrules running || fail="$fail service;"
nft list table inet proxyrules >/dev/null 2>&1 || fail="$fail nftables;"
nslookup upwork.com 127.0.0.1 2>/dev/null | grep -q '198\.1[89]\.' || fail="$fail fake-ip;"
nslookup ya.ru 127.0.0.1 2>/dev/null | grep -q '^Name:' || fail="$fail DNS;"
jq -e '[.nodes[] | select(.up == true)] | length > 0' /var/run/proxyrules/status.json >/dev/null 2>&1 ||
	fail="$fail no connection responds;"
# the whole path: fake-ip -> nft -> tproxy -> sing-box -> proxy (github.com is in the rules)
code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' https://github.com/)
[ "$code" != "000" ] || fail="$fail github.com did not open through the proxy;"

[ -z "$fail" ] || fail_and_stop "$fail"

/etc/init.d/proxyrules enable
touch "$OK"
say "proxyrules is working (github.com: HTTP $code)"
jq -c '.chains | map_values(.active)' /var/run/proxyrules/status.json
