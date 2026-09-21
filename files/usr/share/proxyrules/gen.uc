// proxyrules: генератор конфигурации sing-box и nftables из /etc/proxyrules.conf
//
//   ucode gen.uc <rules.conf> <outdir> [listsdir]
//
// Пишет в <outdir>: config.json (sing-box), nft.conf (таблица inet proxyrules),
// state.json (для watchdog.uc), env.sh (константы для init-скрипта).
// Ошибки — в stderr с номером строки, код выхода 1.
'use strict';

import { readfile, writefile, mkdir, stat, open, rename } from 'fs';

// Все номера выбраны так, чтобы не пересекаться с Legacy (1602, 127.0.0.42,
// 0x00100000/0x00200000, table 105): оба можно держать установленными.
const C = {
	TPROXY_PORT: 1612,
	MIXED_PORT: 1613,
	DNS_ADDR: '127.0.0.43',
	API_ADDR: '127.0.0.1:9095',
	FAKEIP_RANGE: '198.18.0.0/15',
	MARK: 0x00400000,       // пакет нужно отдать в sing-box
	OUT_MARK: 0x00800000,   // собственный трафик sing-box
	ROUTE_TABLE: 106,
	NFT_TABLE: 'proxyrules',
	LISTS_DIR: '/etc/proxyrules/lists',
	LOCALV4: [
		'0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
		'172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
		'192.168.0.0/16', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3',
	],
};

const conf_path = ARGV[0], outdir = ARGV[1], lists_dir = ARGV[2] ?? C.LISTS_DIR;
if (!conf_path || !outdir) {
	warn('usage: ucode gen.uc <rules.conf> <outdir> [listsdir]\n');
	exit(2);
}

const RESERVED = { direct: true, block: true };
const RULE_TYPES = { domain: true, list: true, ip: true, src: true, port: true };

let errors = [];
function fail(ln, msg) { push(errors, [ ln, msg ]); }

function urldecode(s) {
	return replace(s, /%([0-9A-Fa-f]{2})/g, (m, h) => chr(hex(h)));
}

function is_ipv4(s) {
	let m = match(s, /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	for (let i = 1; i <= 4; i++)
		if (int(m[i]) > 255) return false;
	return true;
}

function is_cidr(s) {
	let p = split(s, '/');
	return length(p) <= 2 && is_ipv4(p[0]) &&
		(length(p) == 1 || !!match(p[1], /^([0-9]|[12][0-9]|3[0-2])$/));
}

function is_domain(s) {
	return !!match(s, /^([a-z0-9_]([a-z0-9_-]*[a-z0-9_])?\.)+[a-z0-9-]{2,}$/);
}

// ---------------------------------------------------------------- соединения

function parse_vless(url, name, ln) {
	let m = match(url, /^vless:\/\/([^@]+)@([^:/?#]+):([0-9]+)\/?(\?[^#]*)?(#.*)?$/);
	if (!m) return fail(ln, 'cannot parse the vless link');

	let q = {};
	for (let kv in split(substr(m[4] ?? '?', 1), '&')) {
		if (kv == '') continue;
		let i = index(kv, '=');
		if (i < 0) q[kv] = '';
		else q[substr(kv, 0, i)] = urldecode(substr(kv, i + 1));
	}

	let server = m[2];
	let ob = {
		type: 'vless', tag: name,
		server: server, server_port: int(m[3]),
		uuid: urldecode(m[1]),
	};
	if (!match(ob.uuid, /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/))
		fail(ln, 'invalid UUID in the vless link');
	if (q.flow) ob.flow = q.flow;

	// VLESS Encryption (Xray 25.8+: encryption=mlkem768x25519plus…) sing-box не умеет
	if (q.encryption && q.encryption != 'none')
		fail(ln, 'sing-box does not support VLESS Encryption (encryption=' + substr(q.encryption, 0, 20) +
			'…) — in x-ui set the inbound Decryption to none and take a new link');
	// pqv (ML-DSA-65 для REALITY) — необязательная проверка подписи; sing-box её не делает,
	// соединение работает и без неё, поэтому параметр просто пропускаем

	let sec = q.security ?? 'none';
	if (sec == 'tls' || sec == 'reality') {
		ob.tls = { enabled: true, server_name: q.sni || q.host || server };
		if (q.fp) ob.tls.utls = { enabled: true, fingerprint: q.fp };
		if (q.alpn) ob.tls.alpn = split(q.alpn, ',');
		if (q.allowInsecure == '1' || q.insecure == '1') ob.tls.insecure = true;
		if (sec == 'reality') {
			if (!q.pbk) fail(ln, 'security=reality, but pbk is missing');
			if (!q.sni) fail(ln, 'security=reality, but sni is missing — set SNI in the inbound Reality settings');
			ob.tls.reality = { enabled: true, public_key: q.pbk, short_id: q.sid ?? '' };
			// reality в sing-box работает только с uTLS
			ob.tls.utls ??= { enabled: true, fingerprint: 'chrome' };
		}
	}
	else if (sec != 'none')
		fail(ln, `unsupported security=${sec}`);

	let t = q.type ?? 'tcp';
	if (t == 'ws') {
		ob.transport = { type: 'ws', path: q.path || '/' };
		if (q.host) ob.transport.headers = { Host: q.host };
	}
	else if (t == 'grpc')
		ob.transport = { type: 'grpc', service_name: q.serviceName ?? '' };
	else if (t == 'httpupgrade') {
		ob.transport = { type: 'httpupgrade', path: q.path || '/' };
		if (q.host) ob.transport.host = q.host;
	}
	else if (t == 'http' || t == 'h2') {
		ob.transport = { type: 'http', path: q.path || '/' };
		if (q.host) ob.transport.host = split(q.host, ',');
	}
	else if (t != 'tcp' && t != 'raw')
		fail(ln, `unsupported transport type=${t}`);

	return ob;
}

function parse_connection(name, value, ln) {
	if (RESERVED[name]) return fail(ln, `name "${name}" is reserved`);
	if (!match(name, /^[A-Za-z0-9-]{1,32}$/))
		return fail(ln, `connection name "${name}": only Latin letters, digits and "-"`);

	if (match(value, /^vless:\/\//))
		return parse_vless(value, name, ln);

	let m = match(value, /^iface:([A-Za-z0-9_.-]{1,15})$/);
	if (m)
		return { type: 'direct', tag: name, bind_interface: m[1] };

	return fail(ln, 'a connection must be vless://… or iface:<interface>');
}

// ---------------------------------------------------------------- разбор файла

let settings = {
	interfaces: 'br-lan',
	dns: '8.8.8.8',
	bootstrap: '77.88.8.8',
	check_url: 'https://www.gstatic.com/generate_204',
	check_interval: '10',
	lists_via: 'direct',
	log: 'warn',
};
let settings_ln = {};
let connections = {}, conn_order = [];
let chain_defs = [];
let rules = [];

let text = readfile(conf_path);
if (text == null) {
	warn(`cannot read ${conf_path}\n`);
	exit(1);
}

let ln = 0;
for (let raw in split(text, '\n')) {
	ln++;
	// комментарий — «#» в начале строки или после пробела (в vless-ссылке «#имя» идёт без пробела)
	let line = trim(replace(raw, /(^|\s)#.*$/, ''));
	if (line == '') continue;

	let m = match(line, /^@([a-z_]+)\s*=\s*(.*)$/);
	if (m) {
		if (!exists(settings, m[1])) fail(ln, `unknown setting @${m[1]}`);
		else { settings[m[1]] = m[2]; settings_ln[m[1]] = ln; }
		continue;
	}

	m = match(line, /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
	if (m && match(m[2], /^(vless:\/\/|iface:)/)) {
		if (connections[m[1]]) { fail(ln, `connection ${m[1]} is already defined`); continue; }
		if (match(m[2], /\s/)) { fail(ln, 'a connection link must not contain spaces'); continue; }
		let ob = parse_connection(m[1], m[2], ln);
		if (ob) { connections[m[1]] = ob; push(conn_order, m[1]); }
		continue;
	}
	if (m) {
		// всё остальное вида ИМЯ = A,B,C — именованная цепочка
		push(chain_defs, { ln, name: m[1], members: filter(map(split(m[2], ','), (t) => trim(t)), (t) => t != '') });
		continue;
	}

	// регулярки в ucode — POSIX: без ленивых квантификаторов и без \s внутри [...]
	// правило: условие [& условие…] -> цель; условие: [!]тип:значение[, значение…]
	m = match(line, /^(!?[a-z]+:.+)->(.+)$/);
	if (m) {
		let conds = [];
		for (let part in split(m[1], '&')) {
			let c = match(trim(part), /^(!?)([a-z]+):(.*)$/);
			if (!c) { fail(ln, trim(part) == '' ? 'empty condition next to "&"' : `"${trim(part)}" — expected type:value`); continue; }
			if (!RULE_TYPES[c[2]]) { fail(ln, `unknown condition type "${c[2]}:" (available: domain, list, ip, src, port)`); continue; }
			let values = filter(split(trim(c[3]), /[[:space:],]+/), (v) => v != '');
			if (!length(values)) { fail(ln, `empty condition "${c[2]}:"`); continue; }
			push(conds, { type: c[2], neg: c[1] == '!', values });
		}
		push(rules, { ln, conds, targets: map(split(m[2], ','), (t) => trim(t)) });
		continue;
	}

	fail(ln, 'line is not a connection or chain (NAME = …), a rule (type:value -> TARGET) or a setting (@name = …)');
}

// ---------------------------------------------------------------- проверка правил

let chains = {};          // имя цепочки (или "TR_DE_UK" для заданной прямо в правиле) -> участники
let named = {};           // только именованные: AUTO -> ["DE","UK","TR"]
let used_lists = {}, list_order = [];

// сначала имена (участники могут ссылаться на цепочки, заданные ниже — это ошибка вложения)
for (let c in chain_defs) {
	if (RESERVED[c.name]) fail(c.ln, `name "${c.name}" is reserved`);
	else if (!match(c.name, /^[A-Za-z0-9-]{1,32}$/)) fail(c.ln, `chain name "${c.name}": only Latin letters, digits and "-"`);
	else if (connections[c.name]) fail(c.ln, `"${c.name}" is already defined as a connection`);
	else if (named[c.name]) fail(c.ln, `chain ${c.name} is already defined`);
	else { named[c.name] = true; c.ok = true; }
}

function check_members(members, ln) {
	if (!length(members)) return fail(ln, 'empty chain');
	let seen = {};
	for (let t in members) {
		if (t == 'block') return fail(ln, 'block cannot be part of a chain');
		if (named[t]) return fail(ln, `"${t}" is a chain; chains cannot be nested, list the connections instead`);
		if (t != 'direct' && !connections[t]) return fail(ln, `unknown connection "${t}"`);
		if (seen[t]) return fail(ln, `"${t}" appears twice in the same chain`);
		seen[t] = true;
	}
	return true;
}

for (let c in chain_defs)
	if (c.ok && check_members(c.members, c.ln)) chains[c.name] = c.members;

// Цель правила: соединение, именованная цепочка, direct, block или цепочка прямо в правиле (A,B,C)
function resolve_targets(targets, ln) {
	if (length(targets) == 0 || targets[0] == '') return fail(ln, 'no target after ->');
	if (length(targets) == 1) {
		let t = targets[0];
		if (t == 'direct' || t == 'block' || connections[t] || named[t]) return t;
		return fail(ln, `unknown connection or chain "${t}"`);
	}
	if (!check_members(targets, ln)) return null;
	let key = join('_', targets);
	chains[key] = targets;
	return key;
}

// порт: 443 или диапазон 50000-65535
function parse_port(v) {
	let m = match(v, /^([0-9]{1,5})(-([0-9]{1,5}))?$/);
	if (!m) return null;
	let a = int(m[1]), b = m[3] ? int(m[3]) : a;
	return (a >= 1 && b <= 65535 && a <= b) ? [ a, b ] : null;
}

for (let r in rules) {
	r.target = resolve_targets(r.targets, r.ln);
	if (!length(r.conds)) continue;

	let seen = {};
	for (let c in r.conds) {
		let key = (c.neg ? '!' : '') + c.type;
		if (seen[key]) fail(r.ln, `condition "${key}:" appears twice — list the values separated by commas`);
		seen[key] = true;

		if (c.type == 'domain')
			c.values = map(c.values, (v) => lc(replace(v, /^\*?\./, '')));
		for (let v in c.values) {
			if (c.type == 'domain') {
				if (!is_domain(v)) fail(r.ln, `"${v}" does not look like a domain`);
			}
			else if (c.type == 'list') {
				if (!match(v, /^[a-z0-9_]+$/)) fail(r.ln, `list name "${v}": only a-z, 0-9, _`);
				else if (!used_lists[v]) { used_lists[v] = true; push(list_order, v); }
			}
			else if (c.type == 'port') {
				if (!parse_port(v)) fail(r.ln, `"${v}": expected a port 1-65535 or a range like 50000-65535`);
			}
			else if (!is_cidr(v))
				fail(r.ln, `"${v}" is not an IPv4 address or subnet`);
		}
	}

	// Правило из одних отрицаний подходит почти всему — пришлось бы гнать через
	// sing-box весь трафик сети. Для direct это не нужно: direct и так по умолчанию.
	if (r.target != 'direct' && !length(filter(r.conds, (c) => !c.neg)))
		fail(r.ln, 'at least one condition without "!" is required — otherwise all traffic would have to go through sing-box');
}

// настройки
let ifaces = filter(split(settings.interfaces, /[[:space:],]+/), (v) => v != '');
if (!length(ifaces)) fail(settings_ln.interfaces ?? 0, '@interfaces is empty');
for (let i in ifaces)
	if (!match(i, /^[A-Za-z0-9_.-]{1,15}$/)) fail(settings_ln.interfaces, `@interfaces: "${i}" does not look like an interface name`);

let check_interval = int(settings.check_interval);
if (check_interval < 5 || check_interval > 3600) fail(settings_ln.check_interval, '@check_interval is in seconds, 5 to 3600');
if (!match(settings.check_url, /^https?:\/\/\S+$/)) fail(settings_ln.check_url, '@check_url must be an http(s) URL');
if (!(settings.log in ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic']))
	fail(settings_ln.log, '@log: trace, debug, info, warn or error');
if (!is_ipv4(settings.bootstrap)) fail(settings_ln.bootstrap, '@bootstrap must be an IPv4 address');
if (!is_ipv4(settings.dns) && !is_domain(settings.dns)) fail(settings_ln.dns, '@dns: IP or hostname of a DoH server');

let lists_via = resolve_targets(map(split(settings.lists_via, ','), (t) => trim(t)), settings_ln.lists_via ?? 0);
if (lists_via == 'block') fail(settings_ln.lists_via, '@lists_via cannot be block');

if (length(errors)) {
	errors = sort(errors, (a, b) => a[0] - b[0]);
	warn(join('\n', map(errors, (e) => e[0] ? sprintf('line %d: %s', e[0], e[1]) : e[1])), '\n');
	exit(1);
}

// ---------------------------------------------------------------- sing-box

let outbounds = [ { type: 'direct', tag: 'direct' } ];
for (let n in conn_order) push(outbounds, connections[n]);

for (let key, members in chains) {
	push(outbounds, {
		type: 'urltest', tag: key + '~auto', outbounds: members,
		url: settings.check_url, interval: '1m',
		tolerance: 65535,           // не прыгать по задержке: держаться текущего, пока он жив
		idle_timeout: '30m',
	});
	push(outbounds, {
		type: 'selector', tag: key,
		outbounds: [ key + '~auto', ...members ],
		default: key + '~auto',     // без watchdog цепочка всё равно переключается сама
		interrupt_exist_connections: false,
	});
}

// Через эту группу watchdog проверяет все соединения разом (GET /group/~probe/delay).
// Именно selector: у urltest групповой замер пропускает недавно проверенные узлы.
let probe = null;
if (length(conn_order)) {
	probe = '~probe';
	push(outbounds, { type: 'selector', tag: probe, outbounds: conn_order });
}

let rule_sets = [];
for (let name in list_order) {
	let path = `${lists_dir}/${name}.json`;
	if (!stat(path)) {
		system([ 'mkdir', '-p', lists_dir ]);
		writefile(path, '{"version":3,"rules":[]}\n');
	}
	push(rule_sets, { type: 'local', tag: 'list-' + name, format: 'source', path });
}

// одно условие -> поля правила sing-box
function cond_fields(c) {
	let o = {};
	if (c.type == 'domain') o.domain_suffix = c.values;
	else if (c.type == 'list') o.rule_set = map(c.values, (v) => 'list-' + v);
	else if (c.type == 'ip') o.ip_cidr = c.values;
	else if (c.type == 'src') o.source_ip_cidr = c.values;
	else if (c.type == 'port') {
		let ports = [], ranges = [];
		for (let v in c.values) {
			let p = parse_port(v);
			if (p[0] == p[1]) push(ports, p[0]);
			else push(ranges, `${p[0]}:${p[1]}`);
		}
		if (length(ports)) o.port = ports;
		if (length(ranges)) o.port_range = ranges;
	}
	if (c.neg) o.invert = true;
	return o;
}

function route_rule(r) {
	let o = length(r.conds) == 1
		? cond_fields(r.conds[0])
		: { type: 'logical', mode: 'and', rules: map(r.conds, cond_fields) };
	if (r.target == 'block') o.action = 'reject';
	else { o.action = 'route'; o.outbound = r.target; }
	return o;
}

// простое правило: одно условие без «!»
function simple(r) {
	return length(r.conds) == 1 && !r.conds[0].neg;
}

// соседние простые правила одного типа с одной целью склеиваем в одно
let merged = [];
for (let r in rules) {
	let last = length(merged) ? merged[length(merged) - 1] : null;
	if (last && simple(last) && simple(r) && last.conds[0].type == r.conds[0].type && last.target == r.target)
		last.conds[0].values = [ ...last.conds[0].values, ...r.conds[0].values ];
	else
		push(merged, { target: r.target, conds: map(r.conds, (c) => ({ type: c.type, neg: c.neg, values: [ ...c.values ] })) });
}

let route_rules = [
	{ inbound: [ 'tproxy-in', 'dns-in' ], action: 'sniff' },
	{ protocol: 'dns', action: 'hijack-dns' },
	{ inbound: 'mixed-in', action: 'route', outbound: lists_via },
];
for (let r in merged) push(route_rules, route_rule(r));

// ---------------------------------------------------------------- перехват
// Трафик должен дойти до sing-box, иначе правило не сработает. Правилу с целью
// direct перехват не нужен (напрямую — это и есть поведение по умолчанию).
// Остальным хватает перехвата по одному положительному условию — условия
// связаны «И», значит подходящий трафик под него точно попадёт:
//   domain, list -> fake-ip в DNS (подсети списков ставит в nft watchdog);
//   иначе src/ip/port -> одно nft-правило со всеми этими условиями сразу.
// DNS не знает, какое устройство спрашивает, поэтому fake-ip домен получает
// для всех; кому правило не подходит, пойдут дальше по правилам или напрямую.
//
// Исключение для direct: если оно стоит выше перехватывающего правила
// (ip:<внешний IP> -> direct над src:<устройство> -> TR), трафик иначе уйдёт в
// sing-box по src: и тот сам пойдёт «напрямую» — а соединение самого роутера
// на свой WAN-адрес проброс портов не проходит. Поэтому direct из одних
// src/ip/port без «!» становится nft-правилом return на своём месте по порядку.
// После первого list: так не делаем: его подсети проверяются в pr_lists, ниже
// всех этих правил, и return мог бы перебить правило, стоящее выше direct.
let fake_suffix = [], fake_sets = [];
let nft_matches = [];     // [{ src, dst, ports, direct }] для правил без domain/list
let seen_list = false;

for (let r in merged) {
	if (r.target == 'direct') {
		let exact = !seen_list && length(r.conds) &&
			!length(filter(r.conds, (c) => c.neg || c.type == 'domain' || c.type == 'list'));
		if (exact) {
			let by = {};
			for (let c in r.conds) by[c.type] = c.values;
			push(nft_matches, { src: by.src, dst: by.ip, ports: by.port, direct: true });
		}
		continue;
	}
	let pos = filter(r.conds, (c) => !c.neg);
	let by = {};
	for (let c in pos) by[c.type] = c.values;

	if (by.domain || by.list) {
		if (by.domain) fake_suffix = [ ...fake_suffix, ...by.domain ];
		for (let v in by.list ?? []) push(fake_sets, 'list-' + v);
		if (by.list) seen_list = true;
	}
	else
		push(nft_matches, { src: by.src, dst: by.ip, ports: by.port });
}

let dns_rules = [
	{ query_type: 'HTTPS', action: 'reject' },
	{ domain_suffix: 'use-application-dns.net', action: 'reject' },
];
if (length(fake_suffix) || length(fake_sets)) {
	let fr = { action: 'route', server: 'fakeip', rewrite_ttl: 60 };
	if (length(fake_suffix)) fr.domain_suffix = uniq(fake_suffix);
	if (length(fake_sets)) fr.rule_set = uniq(fake_sets);
	push(dns_rules, fr);
}

let remote_dns = { type: 'https', tag: 'dns-remote', server: settings.dns };
if (!is_ipv4(settings.dns)) remote_dns.domain_resolver = 'dns-bootstrap';

let secret = hexenc(readfile('/dev/urandom', 16));

let config = {
	log: { level: settings.log, timestamp: false },
	dns: {
		servers: [
			remote_dns,
			{ type: 'udp', tag: 'dns-bootstrap', server: settings.bootstrap },
			{ type: 'fakeip', tag: 'fakeip', inet4_range: C.FAKEIP_RANGE },
		],
		rules: dns_rules,
		final: 'dns-remote',
		strategy: 'ipv4_only',
		independent_cache: true,
	},
	inbounds: [
		{ type: 'tproxy', tag: 'tproxy-in', listen: '127.0.0.1', listen_port: C.TPROXY_PORT },
		{ type: 'direct', tag: 'dns-in', listen: C.DNS_ADDR, listen_port: 53 },
		{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: C.MIXED_PORT },
	],
	outbounds,
	route: {
		rules: route_rules,
		rule_set: rule_sets,
		final: 'direct',
		auto_detect_interface: true,
		default_mark: C.OUT_MARK,
		default_domain_resolver: 'dns-remote',
	},
	experimental: {
		cache_file: { enabled: true, path: outdir + '/cache.db', store_fakeip: true },
		clash_api: { external_controller: C.API_ADDR, secret },
	},
};

// ---------------------------------------------------------------- nftables

function nft_set(name, type, elems) {
	let s = `\tset ${name} {\n\t\ttype ${type}\n`;
	if (type != 'ifname') s += '\t\tflags interval\n\t\tauto-merge\n';
	if (length(elems)) s += `\t\telements = { ${join(', ', elems)} }\n`;
	return s + '\t}\n';
}

const MARK = sprintf('0x%08x', C.MARK), OUT_MARK = sprintf('0x%08x', C.OUT_MARK);
const L4 = 'meta l4proto { tcp, udp }';

// по nft-правилу (и своим наборам) на каждое правило из src/ip/port
let sets = nft_set('pr_ifaces', 'ifname', map(ifaces, (i) => `"${i}"`)) + nft_set('pr_local', 'ipv4_addr', C.LOCALV4);
let pre_rules = '', out_rules = '';
for (let i, mt in nft_matches) {
	let match_expr = '';
	if (mt.src) { sets += nft_set(`pr_m${i}_src`, 'ipv4_addr', uniq(mt.src)); match_expr += `ip saddr @pr_m${i}_src `; }
	if (mt.dst) { sets += nft_set(`pr_m${i}_dst`, 'ipv4_addr', uniq(mt.dst)); match_expr += `ip daddr @pr_m${i}_dst `; }
	match_expr += L4;
	if (mt.ports) { sets += nft_set(`pr_m${i}_port`, 'inet_service', uniq(mt.ports)); match_expr += ` th dport @pr_m${i}_port`; }
	let rule = mt.direct ? `\t\t${match_expr} return\n` : `\t\t${match_expr} meta mark set ${MARK} return\n`;
	pre_rules += rule;
	if (!mt.src) out_rules += rule;    // у трафика самого роутера нет «устройства»
}

let nft = `table inet ${C.NFT_TABLE}
delete table inet ${C.NFT_TABLE}
table inet ${C.NFT_TABLE} {
${sets}
	# заполняет watchdog.uc подсетями из списков list:
	chain pr_lists {
	}

	chain pr_prerouting {
		type filter hook prerouting priority mangle; policy accept;
		iifname != @pr_ifaces return
		ip daddr @pr_local return
		ct status dnat return
${pre_rules}		ip daddr ${C.FAKEIP_RANGE} ${L4} meta mark set ${MARK} return
		jump pr_lists
	}

	chain pr_output {
		type route hook output priority mangle; policy accept;
		ip daddr @pr_local return
		meta mark & ${OUT_MARK} == ${OUT_MARK} return
${out_rules}		ip daddr ${C.FAKEIP_RANGE} ${L4} meta mark set ${MARK} return
		jump pr_lists
	}

	chain pr_tproxy {
		type filter hook prerouting priority dstnat; policy accept;
		meta mark & ${MARK} == ${MARK} ${L4} tproxy ip to 127.0.0.1:${C.TPROXY_PORT} accept
	}
}
`;

// ---------------------------------------------------------------- запись

let state = {
	api: C.API_ADDR, secret, probe,
	nodes: conn_order,
	connections: map(conn_order, (n) => {
		let o = connections[n];
		return { name: n, kind: o.type == 'vless' ? 'vless' : 'iface',
			where: o.type == 'vless' ? `${o.server}:${o.server_port}` : o.bind_interface };
	}),
	chains,
	lists: list_order,
	lists_dir,
	lists_via,
	check_url: settings.check_url,
	check_interval,
	mark: MARK,
	nft_table: C.NFT_TABLE,
	nft_lists_chain: 'pr_lists',
	mixed: `127.0.0.1:${C.MIXED_PORT}`,
};

let env = `MARK=${MARK}
ROUTE_TABLE=${C.ROUTE_TABLE}
NFT_TABLE=${C.NFT_TABLE}
DNS_ADDR=${C.DNS_ADDR}
LISTS_DIR=${lists_dir}
`;

mkdir(outdir);
function put(name, data) {
	let tmp = `${outdir}/.${name}.tmp`;
	let f = open(tmp, 'w', 0o600);
	f.write(data);
	f.close();
	rename(tmp, `${outdir}/${name}`);
}
put('config.json', sprintf('%.J\n', config));
put('nft.conf', nft);
put('state.json', sprintf('%.J\n', state));
put('env.sh', env);

printf('ok: %d connections, %d rules, %d chains, %d lists\n',
	length(conn_order), length(rules), length(keys(chains)), length(list_order));
