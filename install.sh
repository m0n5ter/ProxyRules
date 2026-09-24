#!/bin/sh
# Installs and updates proxyrules on an OpenWrt router.
#
#   wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh
#
#   sh install.sh                the latest release
#   sh install.sh v1.2.0         a specific release
#   sh install.sh --file X.tar.gz  an archive from tools/build.sh (this is how router.sh update installs)
#   --no-restart                 do not restart a running service after the update
#   --lang en|ru                 interface language; without it the installer asks on the
#                                first interactive install and keeps the saved choice after that
#
#   sh install.sh uninstall      stop and remove proxyrules; the config is kept
#   sh install.sh uninstall --purge   also remove /etc/proxyrules.conf and /etc/proxyrules/
#
# A copy of this script is installed as /usr/share/proxyrules/install.sh,
# so removal works without internet access.
#
# Installs missing packages (sing-box etc.), the proxyrules files and the LuCI page.
# Leaves /etc/proxyrules.conf alone; if it is missing, puts the example there (except with --file).

REPO=m0n5ter/ProxyRules
LANG_FILE=/etc/proxyrules/lang
TAG=
FILE=
RESTART=1
UNINSTALL=
PURGE=
LNG=

while [ $# -gt 0 ]; do
	case "$1" in
	--file) FILE=$2; shift ;;
	--no-restart) RESTART= ;;
	--lang) LNG=$2; shift ;;
	uninstall|--uninstall) UNINSTALL=1 ;;
	--purge) PURGE=1 ;;
	v[0-9]*) TAG=$1 ;;
	*) echo "unknown argument: $1" >&2; exit 1 ;;
	esac
	shift
done

case "$LNG" in
''|en|ru) ;;
*) echo "--lang: en or ru" >&2; exit 1 ;;
esac

# ── Language ────────────────────────────────────────────────────────────────
# The choice is saved in $LANG_FILE: the LuCI page and the error messages use it.
SAVE_LANG=$LNG
[ -n "$LNG" ] || LNG=$(cat "$LANG_FILE" 2>/dev/null)
# ask only in a terminal: "wget … | sh" over SSH has one (/dev/tty), while updates
# from LuCI and router.sh update run without it
if [ -z "$LNG" ] && [ -z "$UNINSTALL" ] && (exec </dev/tty) 2>/dev/null; then
	printf 'Interface language / Язык интерфейса:\n  1) English\n  2) Русский\n[1/2]: ' >/dev/tty
	read -r answer </dev/tty
	case "$answer" in
	2|ru|RU|р*|Р*) LNG=ru ;;
	*) LNG=en ;;
	esac
	SAVE_LANG=$LNG
fi
[ "$LNG" = ru ] || LNG=en

# t "English" "Русский" — the text in the chosen language
t() { if [ "$LNG" = ru ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

say() { echo "proxyrules: $*"; logger -t proxyrules "install: $*" 2>/dev/null; }
die() { say "$(t ERROR ОШИБКА): $*"; exit 1; }

[ "$(id -u)" = 0 ] || die "$(t 'must be run as root' 'нужно запускать от root')"
[ -f /etc/openwrt_release ] || die "$(t 'this is not OpenWrt' 'это не OpenWrt')"

fetch() {
	if command -v curl >/dev/null; then curl -fsSL -m 120 -o "$2" "$1"
	else wget -q -T 120 -O "$2" "$1"; fi
}

# ── Removal ─────────────────────────────────────────────────────────────────
if [ -n "$UNINSTALL" ]; then
	# stop restores the original dnsmasq settings (saved in /etc/proxyrules)
	if [ -x /etc/init.d/proxyrules ]; then
		say "$(t 'stopping the service' 'останавливаю сервис')"
		/etc/init.d/proxyrules stop >/dev/null 2>&1
		/etc/init.d/proxyrules disable
	fi
	rm -f /etc/init.d/proxyrules /etc/proxyrules.conf.example /etc/proxyrules.conf.example.ru \
		/usr/share/rpcd/ucode/proxyrules.uc /usr/share/rpcd/acl.d/luci-app-proxyrules.json \
		/usr/share/luci/menu.d/luci-app-proxyrules.json /www/luci-static/resources/view/proxyrules.js \
		/tmp/proxyrules-upgrade.log /tmp/proxyrules-install.sh
	# only our own files: anything else in /usr/share/proxyrules (backups etc.) stays
	rm -f /usr/share/proxyrules/gen.uc /usr/share/proxyrules/watchdog.uc \
		/usr/share/proxyrules/version /usr/share/proxyrules/install.sh
	rmdir /usr/share/proxyrules 2>/dev/null
	rm -rf /var/run/proxyrules /www/luci-static/resources/view/proxyrules \
		/tmp/luci-indexcache* /tmp/luci-modulecache
	/etc/init.d/rpcd reload
	if [ -n "$PURGE" ]; then
		rm -rf /etc/proxyrules.conf /etc/proxyrules
		say "$(t 'removed, including /etc/proxyrules.conf' 'удалено, вместе с /etc/proxyrules.conf')"
	else
		say "$(t 'removed; /etc/proxyrules.conf and /etc/proxyrules/ are kept (uninstall --purge removes them)' \
			'удалено; /etc/proxyrules.conf и /etc/proxyrules/ оставлены (uninstall --purge удалит и их)')"
	fi
	say "$(t 'packages installed for proxyrules (sing-box etc.) are left in place' \
		'пакеты, поставленные для proxyrules (sing-box и др.), оставлены')"
	exit 0
fi

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
	say "$(t 'installing packages:' 'ставлю пакеты:')$missing"
	if command -v apk >/dev/null; then
		apk update >/dev/null && apk add $missing || die "$(t 'failed to install packages' 'не удалось поставить пакеты')"
	elif command -v opkg >/dev/null; then
		opkg update >/dev/null && opkg install $missing || die "$(t 'failed to install packages' 'не удалось поставить пакеты')"
	else
		die "$(t 'neither opkg nor apk found' 'нет ни opkg, ни apk')"
	fi
fi

# ── Archive ─────────────────────────────────────────────────────────────────
TMP=/tmp/proxyrules-install
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$FILE" ]; then
	cp "$FILE" "$TMP/p.tar.gz" || die "$(t 'no such file:' 'нет файла') $FILE"
else
	if [ -n "$TAG" ]; then URL=https://github.com/$REPO/releases/download/$TAG/proxyrules.tar.gz
	else URL=https://github.com/$REPO/releases/latest/download/proxyrules.tar.gz; fi
	say "$(t downloading скачиваю) $URL"
	fetch "$URL" "$TMP/p.tar.gz" || die "$(t 'failed to download' 'не удалось скачать') $URL"
fi
mkdir "$TMP/root"
tar -C "$TMP/root" -xzf "$TMP/p.tar.gz" || die "$(t 'the archive is damaged' 'архив повреждён')"
[ -f "$TMP/root/usr/share/proxyrules/version" ] || die "$(t 'the archive does not contain proxyrules' 'в архиве нет proxyrules')"
VERSION=$(cat "$TMP/root/usr/share/proxyrules/version")

# ── Install ─────────────────────────────────────────────────────────────────
OLD=$(cat /usr/share/proxyrules/version 2>/dev/null)
# the previous page (hashed name) is removed, otherwise old ones pile up in the directory
rm -rf /www/luci-static/resources/view/proxyrules /www/luci-static/resources/view/proxyrules.js
tar -C / -xzf "$TMP/p.tar.gz" || die "$(t 'failed to unpack the files' 'не удалось распаковать файлы')"
chmod 755 /etc/init.d/proxyrules
mkdir -p /etc/proxyrules && chmod 700 /etc/proxyrules
[ -n "$SAVE_LANG" ] && echo "$SAVE_LANG" > "$LANG_FILE"
# with --file the config is built by router.sh install from the example and the links
if [ ! -f /etc/proxyrules.conf ] && [ -z "$FILE" ]; then
	example=/etc/proxyrules.conf.example
	[ "$LNG" = ru ] && [ -f "$example.ru" ] && example=$example.ru
	(umask 077; cp "$example" /etc/proxyrules.conf)
	FRESH=1
fi
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
/etc/init.d/rpcd reload

if [ -n "$OLD" ]; then say "$(t updated: обновлено:) $OLD → $VERSION"
else say "$(t 'installed version' 'установлена версия') $VERSION"; fi

if [ -n "$RESTART" ] && /etc/init.d/proxyrules running; then
	say "$(t 'restarting the service' 'перезапускаю сервис')"
	/etc/init.d/proxyrules restart >/dev/null 2>&1
	sleep 3
	/etc/init.d/proxyrules running ||
		die "$(t 'the service did not come up after the update: logread -e proxyrules' 'сервис не поднялся после обновления: logread -e proxyrules')"
fi

if [ -n "$FRESH" ]; then
	say "$(t 'next: LuCI → Services → Proxy Rules — enter your connections and rules, then Start' \
		'дальше: LuCI → Службы → Proxy Rules — впишите свои соединения и правила, затем «Запустить»')"
fi
say "$(t done готово)"
