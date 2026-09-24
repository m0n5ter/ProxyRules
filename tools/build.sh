#!/usr/bin/env bash
# Сборка архива для установки: tools/build.sh OUT.tar.gz [ВЕРСИЯ]
#
# В архиве дерево от корня роутера (etc, usr, www) — его распаковывает install.sh.
# ВЕРСИЯ по умолчанию — из git (git describe: 1.2.0, 1.2.0-3-gabc1234, …-dirty),
# записывается в /usr/share/proxyrules/version.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=$(realpath -m "${1:?нужен путь к архиву}")
VERSION=${2:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
VERSION=${VERSION#v}

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

if grep -lI $'\r' "${FILES[@]/#/files/}" install.sh; then echo "в файлах выше CRLF" >&2; exit 1; fi

# LuCI грузит страницу как view/<путь>.js?v=<версия LuCI>, и браузер держит старую
# копию, пока не обновится сам LuCI. Поэтому страница ставится под именем с хешем
# содержимого (view/proxyrules/<хеш>.js), а путь в меню переписывается на него.
hash=$(md5sum "files/$VIEW" | cut -c1-8)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -C files -cf - "${FILES[@]}" | tar -C "$stage" -xf -
mkdir -p "$stage/${VIEW%.js}"
mv "$stage/$VIEW" "$stage/${VIEW%.js}/$hash.js"
sed -i 's|"path": "proxyrules"|"path": "proxyrules/'"$hash"'"|' "$stage/$MENU"
grep -q "proxyrules/$hash" "$stage/$MENU" || { echo "не удалось переписать путь в $MENU" >&2; exit 1; }
chmod 755 "$stage/etc/init.d/proxyrules"
echo "$VERSION" > "$stage/usr/share/proxyrules/version"

# только файлы, без каталогов: иначе распаковка в / поменяет права /etc, /usr…
(cd "$stage" && find etc usr www -type f | sort) |
	tar -C "$stage" -czf "$OUT" --owner=0 --group=0 --no-recursion -T -
echo "$OUT: версия $VERSION, страница $hash"
