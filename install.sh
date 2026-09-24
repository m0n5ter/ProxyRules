#!/bin/sh
# Установка и обновление proxyrules на роутере OpenWrt.
#
#   wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh
#
#   sh install.sh                последний релиз
#   sh install.sh v1.2.0         конкретный релиз
#   sh install.sh --file X.tar.gz  архив из tools/build.sh (так ставит router.sh update)
#   --no-restart                 не перезапускать работающий сервис после обновления
#
# Ставит недостающие пакеты (sing-box и др.), файлы proxyrules и страницу LuCI.
# /etc/proxyrules.conf не трогает; если его нет — кладёт туда пример (кроме --file).

REPO=m0n5ter/ProxyRules
TAG=
FILE=
RESTART=1

while [ $# -gt 0 ]; do
	case "$1" in
	--file) FILE=$2; shift ;;
	--no-restart) RESTART= ;;
	v[0-9]*) TAG=$1 ;;
	*) echo "непонятный аргумент: $1" >&2; exit 1 ;;
	esac
	shift
done

say() { echo "proxyrules: $*"; logger -t proxyrules "install: $*" 2>/dev/null; }
die() { say "ОШИБКА: $*"; exit 1; }

[ "$(id -u)" = 0 ] || die "нужен root"
[ -f /etc/openwrt_release ] || die "это не OpenWrt"

fetch() {
	if command -v curl >/dev/null; then curl -fsSL -m 120 -o "$2" "$1"
	else wget -q -T 120 -O "$2" "$1"; fi
}

# ── Пакеты ──────────────────────────────────────────────────────────────────
# пакет:что проверить (команда или файл)
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
	say "ставлю пакеты:$missing"
	if command -v apk >/dev/null; then
		apk update >/dev/null && apk add $missing || die "не удалось поставить пакеты"
	elif command -v opkg >/dev/null; then
		opkg update >/dev/null && opkg install $missing || die "не удалось поставить пакеты"
	else
		die "нет ни opkg, ни apk"
	fi
fi

# ── Архив ───────────────────────────────────────────────────────────────────
TMP=/tmp/proxyrules-install
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$FILE" ]; then
	cp "$FILE" "$TMP/p.tar.gz" || die "нет файла $FILE"
else
	if [ -n "$TAG" ]; then URL=https://github.com/$REPO/releases/download/$TAG/proxyrules.tar.gz
	else URL=https://github.com/$REPO/releases/latest/download/proxyrules.tar.gz; fi
	say "скачиваю $URL"
	fetch "$URL" "$TMP/p.tar.gz" || die "не удалось скачать $URL"
fi
mkdir "$TMP/root"
tar -C "$TMP/root" -xzf "$TMP/p.tar.gz" || die "архив повреждён"
[ -f "$TMP/root/usr/share/proxyrules/version" ] || die "в архиве нет proxyrules"
VERSION=$(cat "$TMP/root/usr/share/proxyrules/version")

# ── Установка ───────────────────────────────────────────────────────────────
OLD=$(cat /usr/share/proxyrules/version 2>/dev/null)
# прежняя страница (имя с хешем) удаляется, иначе в каталоге копятся старые
rm -rf /www/luci-static/resources/view/proxyrules /www/luci-static/resources/view/proxyrules.js
tar -C / -xzf "$TMP/p.tar.gz" || die "не удалось распаковать файлы"
chmod 755 /etc/init.d/proxyrules
mkdir -p /etc/proxyrules && chmod 700 /etc/proxyrules
# с --file конфиг собирает router.sh install из примера и ссылок
if [ ! -f /etc/proxyrules.conf ] && [ -z "$FILE" ]; then
	(umask 077; cp /etc/proxyrules.conf.example /etc/proxyrules.conf)
	FRESH=1
fi
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
/etc/init.d/rpcd reload

if [ -n "$OLD" ]; then say "обновлено: $OLD → $VERSION"; else say "установлена версия $VERSION"; fi

if [ -n "$RESTART" ] && /etc/init.d/proxyrules running; then
	say "перезапускаю сервис"
	/etc/init.d/proxyrules restart
	sleep 3
	/etc/init.d/proxyrules running || die "сервис не поднялся после обновления: logread -e proxyrules"
fi

if [ -n "$FRESH" ]; then
	say "дальше: LuCI → Services → Proxy Rules — впишите свои соединения и правила, затем Start"
fi
say "готово"
