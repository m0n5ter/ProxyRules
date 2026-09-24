# ProxyRules

Маршрутизация трафика на роутере OpenWrt через [sing-box](https://sing-box.sagernet.org/) по одному файлу правил: какие домены, адреса и устройства идут через какое соединение (VLESS/REALITY или интерфейс вроде AmneziaWG/WireGuard), с автоматическим переключением на живое соединение и страницей в LuCI.

```
TR   = vless://…
DE   = vless://…
AUTO = DE,TR                       # первое живое по порядку

protocol:bittorrent                -> direct
domain:upwork.com                  -> TR
list:youtube, discord              -> AUTO
src:192.168.1.15                   -> AUTO
```

Полный формат с комментариями — в [files/etc/proxyrules.conf.example](files/etc/proxyrules.conf.example).

## Установка

OpenWrt 24.10 или новее. В SSH на роутере:

```sh
wget -qO- https://github.com/m0n5ter/ProxyRules/releases/latest/download/install.sh | sh
```

Установщик сам ставит недостающие пакеты (`sing-box`, `ucode`, `jq`, `curl`, `ip-full`, `kmod-nft-tproxy` и др.) и страницу LuCI. Если `/etc/proxyrules.conf` ещё нет, туда кладётся пример.

Дальше: **LuCI → Services → Proxy Rules** — впишите свои соединения и правила, сохраните и нажмите **Start**.

## Обновление

На вкладке **Status** видна установленная версия. Когда выходит новый релиз, там же появляется кнопка **Update** — она скачивает релиз, ставит его и перезапускает сервис. Настройки (`/etc/proxyrules.conf`) не меняются.

То же из SSH — повторить команду установки. Конкретная версия: `sh install.sh v1.0.0`.

## Удаление

```sh
/etc/init.d/proxyrules stop; /etc/init.d/proxyrules disable
rm -rf /etc/init.d/proxyrules /usr/share/proxyrules /usr/share/rpcd/ucode/proxyrules.uc \
  /usr/share/rpcd/acl.d/luci-app-proxyrules.json /usr/share/luci/menu.d/luci-app-proxyrules.json \
  /www/luci-static/resources/view/proxyrules /etc/proxyrules.conf.example /tmp/luci-*cache*
/etc/init.d/rpcd reload
```

`/etc/proxyrules.conf` и `/etc/proxyrules/` остаются — удалите вручную, если не нужны.

## Разработка

`router.sh` ставит рабочую копию на роутер по SSH (`./router.sh update`, `start`, `stop`, …) — описание в начале файла.

Релиз: `git tag v1.2.0 && git push origin v1.2.0` — GitHub Actions соберёт `proxyrules.tar.gz` (`tools/build.sh`) и опубликует его вместе с `install.sh`.
