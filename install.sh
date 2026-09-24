#!/bin/sh
# Installs and updates proxyrules on an OpenWrt router.
#
#   wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh
#
#   sh install.sh                the latest release
#   sh install.sh v1.2.0         a specific release
#   sh install.sh --file X.tar.gz  an archive from tools/build.sh (this is how router.sh update installs)
#   --no-restart                 do not restart a running service after the update
#
# Installs missing packages (sing-box etc.), the proxyrules files and the LuCI page.
# Leaves /etc/proxyrules.conf alone; if it is missing, puts the example there (except with --file).

REPO=m0n5ter/ProxyRules
TAG=
FILE=
RESTART=1

while [ $# -gt 0 ]; do
	case "$1" in
	--file) FILE=$2; shift ;;
	--no-restart) RESTART= ;;
	v[0-9]*) TAG=$1 ;;
	*) echo "unknown argument: $1" >&2; exit 1 ;;
	esac
	shift
done

say() { echo "proxyrules: $*"; logger -t proxyrules "install: $*" 2>/dev/null; }
die() { say "ERROR: $*"; exit 1; }

[ "$(id -u)" = 0 ] || die "must be run as root"
[ -f /etc/openwrt_release ] || die "this is not OpenWrt"

fetch() {
	if command -v curl >/dev/null; then curl -fsSL -m 120 -o "$2" "$1"
	else wget -q -T 120 -O "$2" "$1"; fi
}

# ── Packages ────────────────────────────────────────────────────────────────
# package:what to check (a command or a file)
DEPS="
sing-box:sing-box
ucode:ucode
ucode-mod-fs:/usr/lib/ucode/fs.so
rpcd-mod-ucode:/usr/lib/rpcd/ucode.so
jq:jq
curl:curl
ip-full:/usr/libexec/ip-full
kmod-nft-tproxy:nft_tproxy
"

missing=
for d in $DEPS; do
	pkg=${d%%:*} what=${d#*:}
	case "$what" in
	/*) [ -e "$what" ] && continue ;;
	nft_tproxy) [ -n "$(find /lib/modules -name nft_tproxy.ko 2>/dev/null)" ] && continue ;;
	*) command -v "$what" >/dev/null && continue ;;
	esac
	missing="$missing $pkg"
done

if [ -n "$missing" ]; then
	say "installing packages:$missing"
	if command -v apk >/dev/null; then
		apk update >/dev/null && apk add $missing || die "failed to install packages"
	elif command -v opkg >/dev/null; then
		opkg update >/dev/null && opkg install $missing || die "failed to install packages"
	else
		die "neither opkg nor apk found"
	fi
fi

# ── Archive ─────────────────────────────────────────────────────────────────
TMP=/tmp/proxyrules-install
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$FILE" ]; then
	cp "$FILE" "$TMP/p.tar.gz" || die "no such file: $FILE"
else
	if [ -n "$TAG" ]; then URL=https://github.com/$REPO/releases/download/$TAG/proxyrules.tar.gz
	else URL=https://github.com/$REPO/releases/latest/download/proxyrules.tar.gz; fi
	say "downloading $URL"
	fetch "$URL" "$TMP/p.tar.gz" || die "failed to download $URL"
fi
mkdir "$TMP/root"
tar -C "$TMP/root" -xzf "$TMP/p.tar.gz" || die "the archive is damaged"
[ -f "$TMP/root/usr/share/proxyrules/version" ] || die "the archive does not contain proxyrules"
VERSION=$(cat "$TMP/root/usr/share/proxyrules/version")

# ── Install ─────────────────────────────────────────────────────────────────
OLD=$(cat /usr/share/proxyrules/version 2>/dev/null)
# the previous page (hashed name) is removed, otherwise old ones pile up in the directory
rm -rf /www/luci-static/resources/view/proxyrules /www/luci-static/resources/view/proxyrules.js
tar -C / -xzf "$TMP/p.tar.gz" || die "failed to unpack the files"
chmod 755 /etc/init.d/proxyrules
mkdir -p /etc/proxyrules && chmod 700 /etc/proxyrules
# with --file the config is built by router.sh install from the example and the links
if [ ! -f /etc/proxyrules.conf ] && [ -z "$FILE" ]; then
	(umask 077; cp /etc/proxyrules.conf.example /etc/proxyrules.conf)
	FRESH=1
fi
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
/etc/init.d/rpcd reload

if [ -n "$OLD" ]; then say "updated: $OLD → $VERSION"; else say "installed version $VERSION"; fi

if [ -n "$RESTART" ] && /etc/init.d/proxyrules running; then
	say "restarting the service"
	/etc/init.d/proxyrules restart >/dev/null 2>&1
	sleep 3
	/etc/init.d/proxyrules running || die "the service did not come up after the update: logread -e proxyrules"
fi

if [ -n "$FRESH" ]; then
	say "next: LuCI → Services → Proxy Rules — enter your connections and rules, then Start"
fi
say "done"
