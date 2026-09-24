# ═══════════════════════════════════════════════════════════════════════════
#  proxyrules — какой трафик через какое соединение
#
#  СОЕДИНЕНИЯ           ИМЯ = vless://…            (ссылка целиком, как её выдал сервер)
#                       ИМЯ = iface:awg0           (интерфейс OpenWrt: AmneziaWG, WireGuard…)
#
#  ЦЕПОЧКИ              ИМЯ = DE,NL                первое живое соединение по порядку;
#                                                  когда более приоритетное оживает —
#                                                  возврат на него
#                       ИМЯ = NL,direct            если NL лежит — напрямую
#                       в цепочке только соединения и direct (цепочки не вкладываются)
#
#                       имена: латинские буквы, цифры, «-»; direct и block зарезервированы
#
#  ПРАВИЛА              условие [& условие…] -> ЦЕЛЬ
#                       проверяются СВЕРХУ ВНИЗ, срабатывает первое подходящее
#
#  УСЛОВИЯ              тип:значение[, значение…]      (запятая — «или»)
#
#    domain:example.com        домен и все его поддомены
#    list:discord              список itdoginfo/allow-domains (домены + подсети)
#                              есть: anime block cloudflare cloudfront digitalocean discord
#                              geoblock google_ai google_meet google_play hdrezka hetzner
#                              hodca meta news ovh porn roblox russia_inside russia_outside
#                              telegram tiktok twitter ukraine_inside youtube
#                              (актуальный набор — файлы *.srs в последнем релизе:
#                              github.com/itdoginfo/allow-domains/releases/latest)
#    ip:203.0.113.0/24         адрес или подсеть назначения
#    src:192.168.1.15          устройство в LAN (или подсеть) — весь его трафик
#    port:443, 50000-65535     порт назначения (TCP и UDP)
#    protocol:bittorrent       определяется по первым пакетам: bittorrent tls http quic
#                              stun dtls ssh rdp ntp. Виден только в трафике, который и так
#                              идёт через прокси, поэтому сам по себе — только -> direct
#                              (ставьте выше правил, которые он должен перебить); с другими
#                              целями добавьте ещё условие: src:… & protocol:quic -> block
#
#    &   — «и»:   src:192.168.1.15 & domain:aaa.com -> DE       только aaa.com с этого устройства
#    !   — «не»:  !src:192.168.1.15 & domain:bbb.com -> block   все, кроме этого устройства
#    хотя бы одно условие должно быть без «!» (кроме правил с целью direct)
#
#  ЦЕЛИ                 AUTO                цепочка
#                       NL                  одно соединение, без запасных
#                       direct              напрямую, без прокси
#                       block               заблокировать
#                       (или прямо в правиле: -> NL,DE — цепочка без имени)
#
#  Всё, что не подошло ни под одно правило, идёт напрямую.
#  Комментарий — «#» в начале строки или после пробела.
# ═══════════════════════════════════════════════════════════════════════════

# ── Настройки (можно оставить как есть) ─────────────────────────────────────
@interfaces     = br-lan            # откуда перехватывать трафик
@dns            = 8.8.8.8           # DoH-сервер
@bootstrap      = 77.88.8.8
@check_url      = https://www.gstatic.com/generate_204
@check_interval = 10                # секунд между проверками соединений
@lists_via      = AUTO              # через что качать списки list:
@log            = warn

# ── Соединения ──────────────────────────────────────────────────────────────
# Замените на свои ссылки (vless://… целиком, как её выдал сервер).
DE  = vless://UUID@203.0.113.10:443?type=tcp&security=reality&pbk=KEY&sid=SID&sni=www.microsoft.com&fp=chrome&flow=xtls-rprx-vision#DE
NL  = vless://UUID@203.0.113.20:443?type=tcp&security=reality&pbk=KEY&sid=SID&sni=www.microsoft.com&fp=chrome&flow=xtls-rprx-vision#NL
# AWG = iface:awg0

# ── Цепочки ─────────────────────────────────────────────────────────────────
AUTO     = DE,NL
NL-FIRST = NL,DE
NL-ONLY  = NL

# ── Правила ─────────────────────────────────────────────────────────────────

# Торренты — никогда через прокси, с любого устройства (даже с тех, что ниже идут через src:)
protocol:bittorrent                                                 -> direct

# Свои серверы — всегда напрямую, с любого устройства.
# Стоит первым, чтобы src: и list:hetzner/ovh/… ниже его не перехватили.
ip:203.0.113.10, 203.0.113.20                                       -> direct

# Сайт, который всегда должен открываться из одной страны, с любого устройства.
# Он выше src:, поэтому устройства ниже тоже получают для него только NL.
domain:example.com                                                  -> NL-ONLY

# Устройства целиком
src:192.168.1.50                                                    -> AUTO       # ноутбук
src:192.168.1.60                                                    -> NL-FIRST   # приставка

# Только это устройство ходит на сайт через прокси; остальные — напрямую
src:192.168.1.50 & domain:example.org                               -> DE

# Зарубежные и заблокированные сервисы
domain:anthropic.com, claude.ai, claude.com, claudeusercontent.com  -> AUTO
domain:openai.com, chatgpt.com, oaiusercontent.com                  -> AUTO
domain:ai.google, aistudio.google.com, gemini.google.com            -> AUTO
domain:github.com, githubusercontent.com, githubcopilot.com         -> AUTO
domain:linkedin.com, licdn.com, medium.com, spotify.com             -> AUTO

list:youtube, discord, meta, twitter, telegram, tiktok, news        -> AUTO
list:google_ai, cloudflare, cloudfront, hetzner, ovh, digitalocean  -> AUTO

# Реклама и трекеры — заблокировать
domain:doubleclick.net                                              -> block
