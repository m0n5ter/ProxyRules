#!/usr/bin/env bash
# Manage proxyrules on the router from this machine.
#
#   ./router.sh install DE='vless://…' NL='vless://…'
#                                        copy the files, build /etc/proxyrules.conf from the
#                                        example with the connection links filled in. Starts nothing.
#   ./router.sh update                   install the files from the working copy (leaves the
#                                        config and the service alone; version from git describe)
#   ./router.sh start                    (re)start proxyrules and check it; if the check
#                                        fails — stop it (direct internet)
#   ./router.sh stop                     stop proxyrules (direct internet)
#   ./router.sh uninstall                stop and remove proxyrules
#
# HOST can be overridden: HOST=root@10.0.0.1 ./router.sh …
set -euo pipefail

HOST=${HOST:-root@192.168.1.1}
cd "$(dirname "$0")"

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

# An archive of the working copy (tools/build.sh) is installed by the same install.sh as releases.
# A running service is not restarted.
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

# The checked start is done by tools/start.sh on the router itself. It is uploaded
# and checked with `sh -n` there, BEFORE anything is restarted.
run_start() {
	if grep -qI $'\r' tools/start.sh; then echo "tools/start.sh has CRLF" >&2; exit 1; fi
	remote 'cat > /tmp/proxyrules-start.sh && sh -n /tmp/proxyrules-start.sh' < tools/start.sh
	remote 'sh /tmp/proxyrules-start.sh'
}

stop_service() {
	remote '/etc/init.d/proxyrules stop; /etc/init.d/proxyrules disable; echo "proxyrules stopped"'
}

case "${1:-}" in
install)
	shift
	(( $# )) || { echo "links needed: ./router.sh install DE='vless://…' NL='vless://…'" >&2; exit 1; }
	for a in "$@"; do
		[[ $a =~ ^[A-Za-z0-9-]+=(vless://|iface:). ]] || { echo "not NAME=vless://… or NAME=iface:…: ${a%%=*}" >&2; exit 1; }
	done
	install_files

	# The links go through stdin (NAME=link per line), not on the ssh command line.
	# Each one replaces the "NAME = …" line of the example.
	printf '%s\n' "$@" | remote '
		if [ -f /etc/proxyrules.conf ]; then echo "/etc/proxyrules.conf already exists — leaving it alone"; exit 0; fi
		umask 077
		cat > /tmp/proxyrules-links
		awk "
			NR == FNR { i = index(\$0, \"=\"); link[substr(\$0, 1, i - 1)] = substr(\$0, i + 1); next }
			match(\$0, /^[A-Za-z0-9-]+ *= */) {
				name = substr(\$0, 1, RLENGTH); sub(/ *= *\$/, \"\", name)
				if (name in link) { print substr(\$0, 1, RLENGTH) link[name]; used[name] = 1; next }
			}
			{ print }
			END { for (n in link) if (!(n in used)) { print \"no such connection in the example: \" n > \"/dev/stderr\"; bad = 1 }
			      exit bad }" /tmp/proxyrules-links /etc/proxyrules.conf.example > /tmp/proxyrules.conf.new
		rc=$?
		rm -f /tmp/proxyrules-links
		if [ $rc -ne 0 ]; then rm -f /tmp/proxyrules.conf.new; exit 1; fi
		mv /tmp/proxyrules.conf.new /etc/proxyrules.conf
		ucode /usr/share/proxyrules/gen.uc /etc/proxyrules.conf /tmp/proxyrules-check /tmp/proxyrules-check/lists \
			&& sing-box check -c /tmp/proxyrules-check/config.json && echo "/etc/proxyrules.conf built and checked"
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
	remote 'cat > /tmp/proxyrules-uninstall.sh && sh -n /tmp/proxyrules-uninstall.sh' < install.sh
	remote 'sh /tmp/proxyrules-uninstall.sh uninstall; rc=$?; rm -f /tmp/proxyrules-uninstall.sh; exit $rc'
	;;

*)
	sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
	;;
esac
