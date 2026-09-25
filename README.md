# ProxyRules

**English** | [Русский](README.ru.md)

Traffic routing on an OpenWrt router through [sing-box](https://sing-box.sagernet.org/), driven by a single rules file: which domains, addresses and devices go through which connection (VLESS/REALITY or an interface such as AmneziaWG/WireGuard), with automatic failover to a live connection and a LuCI page to manage it all.

```
DE   = vless://…
NL   = vless://…
AUTO = DE,NL                       # the first live one, in order

protocol:bittorrent                -> direct
domain:example.com                 -> NL
list:youtube, discord              -> AUTO
src:192.168.1.50                   -> AUTO
```

Everything not matched by a rule goes direct, so only the traffic you name is proxied.

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [First setup](#first-setup)
- [The LuCI page](#the-luci-page)
- [Configuration file](#configuration-file)
- [How it works](#how-it-works)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Features

- **One readable rules file** — `/etc/proxyrules.conf`; the LuCI page edits the same file and keeps your comments and formatting.
- **Rules by domain, domain list, IP/subnet, LAN device, port and protocol**, combined with `&` (and) and `!` (not); the first matching rule wins.
- **Ready-made domain lists** (YouTube, Discord, Meta, Telegram, …) from [itdoginfo/allow-domains](https://github.com/itdoginfo/allow-domains), updated daily.
- **Chains with failover** — `AUTO = DE,NL` uses the first live connection and switches back when a higher-priority one recovers.
- **Connections**: VLESS links (REALITY, TLS; tcp, ws, grpc, httpupgrade, http transports) as given by the server, or any OpenWrt interface (AmneziaWG, WireGuard, …).
- **Only matching traffic touches sing-box**; everything else goes direct at full speed.
- **Checked before applied** — the config is validated (including `sing-box check`) before it is saved; errors point at the line.
- **One-line install, updates from LuCI, one-line removal.**
- **English and Russian** interface.

## Requirements

- OpenWrt **24.10 or newer** (opkg or apk), with LuCI.
- Enough flash for `sing-box`: the binary is about 40 MB (it takes less on a compressed overlay). Check free space with `df -h /overlay`.
- Enough RAM: sing-box with the lists loaded takes about 70 MB. 256 MB or more is recommended; on 128 MB routers it will be tight.
- At least one proxy server: a VLESS link (e.g. from 3x-ui / x-ui / Xray) or a VPN interface already set up in OpenWrt.
- For VLESS REALITY, the server must run Xray-core **older than 26.9.8**. Newer versions reject REALITY connections from sing-box 1.12 (`reality verification failed`, see [SagerNet/sing-box#4520](https://github.com/SagerNet/sing-box/issues/4520)). 3x-ui ships a newer core, so replace `/usr/local/x-ui/bin/xray-linux-amd64` with an older release (e.g. v25.9.11) and restart x-ui — again after every `x-ui update`.

The installer adds the missing packages itself: `sing-box`, `ucode`, `ucode-mod-fs`, `rpcd-mod-ucode`, `jq`, `curl`, `ip-full`, `kmod-nft-tproxy`.

## Installation

Log in to the router over SSH (`ssh root@192.168.1.1`) and run:

```sh
wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh
```

The installer:

1. asks for the interface language (English or Russian) — only on the first install;
2. installs the missing packages (runs `opkg update` / `apk update` only if something is missing);
3. downloads the latest release and puts the files in place;
4. if there is no `/etc/proxyrules.conf` yet, copies the example there (with comments in the chosen language);
5. adds **Services → Proxy Rules** to LuCI.

Nothing is started yet: the service starts only when you press **Start**.

To choose the language without the question, add `--lang en` or `--lang ru`:

```sh
wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh -s -- --lang ru
```

To install a specific version, pass its tag:

```sh
wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh -s v1.1.0
```

## First setup

1. Open **LuCI → Services → Proxy Rules**. If the page doesn't appear, log out of LuCI and back in.
2. **Connections** tab: replace the example `DE` and `NL` with your own. Paste the whole `vless://…` link as the server gave it, or pick an interface (`iface:awg0`). Remove connections you don't have.
3. **Chains** tab: set the order in which connections are tried, e.g. `AUTO = DE,NL`.
4. **Rules** tab: remove the example rules you don't need and add your own. Put the IPs of your own servers in a `-> direct` rule at the top.
5. **Settings** tab: check `@interfaces` — the LAN interfaces whose traffic is intercepted (usually `br-lan`).
6. Press **Check** to validate, then **Save & Apply**.
7. **Status** tab: press **Start**. Within a few seconds the connections should show as up, and the chains show which connection is in use.

## The LuCI page

| Tab | What it does |
| --- | --- |
| **Status** | Version and update check, service state with Start / Stop / Restart, each connection's state and latency, which member of each chain is active, list update status. |
| **Diagnostics** | Where traffic to a site goes: what sing-box's DNS answers, whether nftables hands it to sing-box, which rule catches it, which chain and connection it goes through right now — for any device. Below that, the connections open at the moment with their real path. |
| **Rules** | The rules in order. Drag to reorder, group rules under headings, edit conditions and targets inline. |
| **Connections** | Add, rename (references are renamed too) and edit connections. Secrets in links are not shown in the list. |
| **Chains** | Named chains and their order. |
| **Settings** | The `@` settings and the interface language. |
| **Config file** | The raw file, for editing by hand. |

The interface language can be changed at any time on the **Settings** tab (**Interface language**); it also sets the language of error messages. It is stored in `/etc/proxyrules/lang`.

**Check** validates the file without saving it. **Save & Apply** validates, saves and restarts the service if it is running. **Revert** discards unsaved changes.

## Configuration file

`/etc/proxyrules.conf`. The full annotated example is [files/etc/proxyrules.conf.example](files/etc/proxyrules.conf.example) (it is also installed as `/etc/proxyrules.conf.example`; the Russian one is [proxyrules.conf.example.ru](files/etc/proxyrules.conf.example.ru)).

A comment is `#` at the start of a line or after a space. Names may contain Latin letters, digits and `-`; `direct` and `block` are reserved.

### Connections

```
NAME = vless://…            the whole link, as the server gave it
NAME = iface:awg0           an OpenWrt interface: AmneziaWG, WireGuard, …
```

Supported VLESS parameters: `security=reality|tls|none`, `type=tcp|ws|grpc|httpupgrade|http`, `flow`, `sni`, `fp`, `pbk`, `sid`, `alpn`, `path`, `host`, `serviceName`. VLESS Encryption (`encryption=mlkem768…`) is not supported by sing-box — set Decryption to `none` in the server's inbound.

### Chains

```
AUTO    = DE,NL             the first live connection, in order
NL-SAFE = NL,direct         if NL is down, go direct
```

The router checks every connection every `@check_interval` seconds. A chain uses the first live member; when a higher-priority member comes back, the chain switches back to it. A chain holds only connections and `direct` — chains don't nest. If all members are down, sing-box picks a live one by itself.

### Rules

```
condition [& condition…] -> TARGET
```

Rules are checked **top to bottom; the first match wins**. Anything not matched goes direct.

| Condition | Matches |
| --- | --- |
| `domain:example.com` | the domain and all its subdomains |
| `list:youtube` | a list from itdoginfo/allow-domains (domains and subnets): `anime block cloudflare cloudfront digitalocean discord geoblock google_ai google_meet google_play hdrezka hetzner hodca meta news ovh porn roblox russia_inside russia_outside telegram tiktok twitter ukraine_inside youtube` |
| `ip:203.0.113.0/24` | a destination address or subnet |
| `src:192.168.1.50` | a LAN device (or subnet) — all of its traffic |
| `port:443, 50000-65535` | a destination port or range (TCP and UDP) |
| `protocol:bittorrent` | detected from the first packets: `bittorrent tls http quic stun dtls ssh rdp ntp` |

- Several values separated by commas mean "or": `domain:a.com, b.com`.
- `&` means "and": `src:192.168.1.50 & domain:example.org -> DE` — only this device, only this site.
- `!` means "not": `!src:192.168.1.50 & domain:example.org -> block` — everyone except this device.
- At least one condition must be without `!` (except in rules with target `direct`).
- `protocol:` is seen only in traffic that already goes to sing-box, so on its own it works only with `-> direct` (put it above the rules it should override). With other targets, add another condition: `src:… & protocol:quic -> block`.

| Target | Meaning |
| --- | --- |
| `AUTO` | a chain |
| `NL` | a single connection, no fallback |
| `NL,DE` | an unnamed chain, right in the rule |
| `direct` | no proxy |
| `block` | drop the connection |

### Settings

| Setting | Default in the example | Meaning |
| --- | --- | --- |
| `@interfaces` | `br-lan` | LAN interfaces whose traffic is intercepted (space-separated) |
| `@dns` | `8.8.8.8` | DNS-over-HTTPS server (IP or hostname) |
| `@bootstrap` | `77.88.8.8` | plain DNS server used to resolve the DoH host (IPv4) |
| `@check_url` | `https://www.gstatic.com/generate_204` | URL used to test connections |
| `@check_interval` | `10` | seconds between connection checks (5–3600) |
| `@lists_via` | `AUTO` | the connection or chain `list:` lists are downloaded through |
| `@log` | `warn` | sing-box log level: `trace debug info warn error` |

## How it works

- **DNS.** dnsmasq forwards all queries to sing-box. Domains that match a rule get a *fake IP* from `198.18.0.0/15`; all other domains resolve normally over DoH. The original dnsmasq settings are saved and restored on stop.
- **Interception.** An nftables table (`inet proxyrules`) marks traffic to fake IPs, to subnets from `list:` lists, and traffic matching `src:`/`ip:`/`port:` rules, and hands it to sing-box via TPROXY. Everything else never reaches sing-box.
- **Routing.** sing-box applies the rules in the same order and sends each connection to its target.
- **Watchdog.** A small process checks the connections through the sing-box API, switches chains, updates the lists once a day and writes the status shown in LuCI.

Only IPv4 traffic is intercepted.

Files on the router:

| Path | Contents |
| --- | --- |
| `/etc/proxyrules.conf` | your rules |
| `/etc/proxyrules/` | downloaded lists, the saved dnsmasq settings and the interface language |
| `/var/run/proxyrules/` | the generated sing-box config, nftables rules and status (recreated on start) |
| `/usr/share/proxyrules/` | the generator, watchdog, installer and version |

## Updating

**From LuCI:** **Status** tab → **Check for updates**. If there is a newer release, press **Update**: it downloads the release, installs it, restarts the service if it was running, and reloads the page. `/etc/proxyrules.conf` is not changed.

**Over SSH:** run the install command again.

## Uninstalling

Over SSH on the router:

```sh
sh /usr/share/proxyrules/install.sh uninstall
```

This stops the service, restores the original dnsmasq settings and removes proxyrules and its LuCI page. Your `/etc/proxyrules.conf` and `/etc/proxyrules/` are kept, so a later reinstall picks up where you left off. To remove them too:

```sh
sh /usr/share/proxyrules/install.sh uninstall --purge
```

The same works without the local copy:

```sh
wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh -s uninstall
```

Packages installed for proxyrules (`sing-box` and others) are left in place; remove them with `opkg remove` / `apk del` if nothing else needs them.

## Troubleshooting

- **Something is wrong and you need the internet back now:** **Stop** on the Status tab, or `/etc/init.d/proxyrules stop` over SSH. Traffic goes direct and dnsmasq settings are restored.
- **Logs:** `logread -e proxyrules` (the service, watchdog and installer) and `logread -e sing-box`.
- **The service does not start:** the reason is shown on the Status tab; it is also in `/var/run/proxyrules/error`.
- **A connection is always down:** open the link in a desktop client to make sure the server works; check the time on the router (`date`) — REALITY fails when the clock is off.
- **A site still opens directly:** the device may be using its own DNS (DoH in the browser, or a hard-coded DNS server) and so never gets a fake IP. Turn off "secure DNS" in the browser, or add an `ip:`/`src:` rule.
- **A site goes the wrong way:** the **Diagnostics** tab shows the rule that catches it and the path. Over SSH: `ucode /usr/share/proxyrules/diag.uc /var/run/proxyrules example.com [device IP]`.
- **Status as JSON:** `ubus call proxyrules status`.

## Development

`router.sh` installs the working copy on a router over SSH (default `root@192.168.1.1`, override with `HOST=…`):

```sh
./router.sh update      # build from the working copy and install; the config and service are left alone
./router.sh start       # (re)start with a check; stops again if the check fails
./router.sh stop
./router.sh uninstall
```

`tools/build.sh OUT.tar.gz [VERSION]` builds the release archive; the version defaults to `git describe`.

To release: `git tag v1.2.0 && git push origin v1.2.0`. GitHub Actions builds `proxyrules.tar.gz` and publishes it together with `install.sh`.

## License

[MIT](LICENSE)
