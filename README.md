# ProxyRules

Traffic routing on an OpenWrt router through [sing-box](https://sing-box.sagernet.org/), driven by a single rules file: which domains, addresses and devices go through which connection (VLESS/REALITY or an interface such as AmneziaWG/WireGuard), with automatic failover to a live connection and a LuCI page.

```
DE   = vless://…
NL   = vless://…
AUTO = DE,NL                       # the first live one, in order

protocol:bittorrent                -> direct
domain:example.com                 -> NL
list:youtube, discord              -> AUTO
src:192.168.1.50                   -> AUTO
```

The full format, with comments, is in [files/etc/proxyrules.conf.example](files/etc/proxyrules.conf.example).

## Installation

OpenWrt 24.10 or newer. Over SSH on the router:

```sh
wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh
```

The installer adds any missing packages (`sing-box`, `ucode`, `jq`, `curl`, `ip-full`, `kmod-nft-tproxy` and others) and the LuCI page. If there is no `/etc/proxyrules.conf` yet, the example is put there.

Next: **LuCI → Services → Proxy Rules** — enter your connections and rules, save, and press **Start**.

## Updating

The **Status** tab shows the installed version and a **Check for updates** button. If GitHub has a newer release, an **Update** button appears next to it — it downloads the release, installs it and restarts the service. Your settings (`/etc/proxyrules.conf`) are left unchanged.

Over SSH, just run the install command again. A specific version:

```sh
wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh -s v1.0.3
```

## Removal

```sh
/etc/init.d/proxyrules stop; /etc/init.d/proxyrules disable
rm -rf /etc/init.d/proxyrules /usr/share/proxyrules /usr/share/rpcd/ucode/proxyrules.uc \
  /usr/share/rpcd/acl.d/luci-app-proxyrules.json /usr/share/luci/menu.d/luci-app-proxyrules.json \
  /www/luci-static/resources/view/proxyrules /etc/proxyrules.conf.example /tmp/luci-*cache*
/etc/init.d/rpcd reload
```

`/etc/proxyrules.conf` and `/etc/proxyrules/` are kept — delete them by hand if you don't need them.

## Development

`router.sh` installs the working copy on the router over SSH (`./router.sh update`, `start`, `stop`, …) — see the top of the file.

Release: `git tag v1.2.0 && git push origin v1.2.0` — GitHub Actions builds `proxyrules.tar.gz` (`tools/build.sh`) and publishes it together with `install.sh`.
