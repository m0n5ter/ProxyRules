#!/usr/bin/env bash
# Build the install archive: tools/build.sh OUT.tar.gz [VERSION]
#
# The archive holds a tree from the router's root (etc, usr, www) — install.sh unpacks it.
# VERSION defaults to git (git describe: 1.2.0, 1.2.0-3-gabc1234, …-dirty)
# and is written to /usr/share/proxyrules/version.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=$(realpath -m "${1:?archive path needed}")
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

if grep -lI $'\r' "${FILES[@]/#/files/}" install.sh; then echo "the files above have CRLF" >&2; exit 1; fi

# LuCI loads the page as view/<path>.js?v=<LuCI version>, and the browser keeps the old
# copy until LuCI itself is updated. So the page is installed under a name with the
# content hash (view/proxyrules/<hash>.js), and the menu path is rewritten to it.
hash=$(md5sum "files/$VIEW" | cut -c1-8)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -C files -cf - "${FILES[@]}" | tar -C "$stage" -xf -
mkdir -p "$stage/${VIEW%.js}"
mv "$stage/$VIEW" "$stage/${VIEW%.js}/$hash.js"
sed -i 's|"path": "proxyrules"|"path": "proxyrules/'"$hash"'"|' "$stage/$MENU"
grep -q "proxyrules/$hash" "$stage/$MENU" || { echo "failed to rewrite the path in $MENU" >&2; exit 1; }
chmod 755 "$stage/etc/init.d/proxyrules"
echo "$VERSION" > "$stage/usr/share/proxyrules/version"
cp install.sh "$stage/usr/share/proxyrules/install.sh"

# files only, no directories: otherwise unpacking into / changes the modes of /etc, /usr…
(cd "$stage" && find etc usr www -type f | sort) |
	tar -C "$stage" -czf "$OUT" --owner=0 --group=0 --no-recursion -T -
echo "$OUT: version $VERSION, page $hash"
