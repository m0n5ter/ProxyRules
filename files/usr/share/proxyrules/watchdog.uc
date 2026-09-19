// proxyrules: сторож.
//
//   ucode watchdog.uc <rundir> [dry]
//
// Каждые @check_interval секунд проверяет все соединения через Clash API sing-box,
// переключает каждую цепочку (TR,DE,UK) на первое живое по приоритету, раз в сутки
// обновляет списки list: и подсети из них в nftables, пишет status.json для LuCI.
// dry — пробный прогон: nftables только проверяются (nft -c), не меняются.
'use strict';

import { readfile, writefile, open, rename, stat, unlink, popen } from 'fs';

const RUN = ARGV[0] ?? '/var/run/proxyrules';
const DRY = ARGV[1] == 'dry';
const st = json(readfile(`${RUN}/state.json`));

const FAIL_AFTER = 2;        // столько неудач подряд — соединение упало
const UP_AFTER = 3;          // столько успехов подряд — ожило (чтобы не дёргать цепочки)
const PROBE_TIMEOUT = 5000;  // мс
const LIST_URL = 'https://github.com/itdoginfo/allow-domains/releases/latest/download/%s.srs';
const LIST_MAX_AGE = 86400;

function log(msg) {
	system([ 'logger', '-t', 'proxyrules', msg ]);
}

function sq(s) {
	return "'" + replace(s, "'", "'\\''") + "'";
}

function sh(cmd) {
	let p = popen(cmd, 'r');
	if (!p) return { rc: -1, out: '' };
	let out = p.read('all') ?? '';
	return { rc: p.close(), out };
}

function urlencode(s) {
	return replace(s, /[^A-Za-z0-9._~-]/g, (c) => sprintf('%%%02X', ord(c)));
}

function put(path, data) {
	let tmp = path + '.tmp';
	let f = open(tmp, 'w', 0o600);
	if (!f) return false;
	f.write(data);
	f.close();
	return rename(tmp, path);
}

// ---------------------------------------------------------------- Clash API

function api(method, path, body) {
	let cmd = `curl -s -m 20 -X ${method} -H ${sq('Authorization: Bearer ' + st.secret)}`;
	if (body != null)
		cmd += ` -H 'Content-Type: application/json' -d ${sq(sprintf('%J', body))}`;
	cmd += ` -w '\\n%{http_code}' ${sq('http://' + st.api + path)}`;

	let r = sh(cmd);
	if (r.rc != 0) return null;
	let i = rindex(r.out, '\n');
	let res = { code: int(substr(r.out, i + 1)), data: null };
	try { res.data = json(substr(r.out, 0, i)); } catch (e) { }
	return res;
}

// ---------------------------------------------------------------- соединения и цепочки

let nodes = {};
for (let c in st.connections)
	nodes[c.name] = { kind: c.kind, where: c.where, up: null, ok: 0, fail: 0, delay: null, since: time() };

let active = {};             // цепочка -> что выбрано сейчас
let api_ok = false;

// null — API не отвечает (sing-box ещё стартует), иначе { имя: задержка } живых
function probe() {
	if (!st.probe) return {};
	let r = api('GET', `/group/${st.probe}/delay?url=${urlencode(st.check_url)}&timeout=${PROBE_TIMEOUT}`);
	if (!r || r.code == 0 || r.code == 401) return null;
	return (r.code == 200 && type(r.data) == 'object') ? r.data : {};
}

function update_nodes(alive) {
	for (let name, n in nodes) {
		let ok = exists(alive, name);
		n.delay = ok ? alive[name] : null;
		if (ok) { n.ok++; n.fail = 0; } else { n.fail++; n.ok = 0; }

		let was = n.up;
		if (ok && was !== true && (was === null || n.ok >= UP_AFTER)) n.up = true;
		if (!ok && was !== false && (was === null || n.fail >= FAIL_AFTER)) n.up = false;
		if (was !== n.up) {
			n.since = time();
			if (was !== null) log(`${name}: ${n.up ? 'снова работает' : 'не отвечает'}`);
		}
	}
}

function apply_chains() {
	let r = api('GET', '/proxies');
	let proxies = r?.data?.proxies ?? {};

	for (let key, members in st.chains) {
		let want = null;
		for (let m in members)
			if (m == 'direct' || nodes[m]?.up === true) { want = m; break; }
		want ??= key + '~auto';       // все лежат — пусть sing-box сам ищет живое

		let now = proxies[key]?.now;
		if (now == want) { active[key] = want; continue; }

		let p = api('PUT', `/proxies/${key}`, { name: want });
		if (p?.code == 204) {
			if (now != null) log(`${key}: ${now} -> ${want}`);
			active[key] = want;
		}
		else
			active[key] = now;
	}
}

// ---------------------------------------------------------------- списки и nftables

function ip2int(ip) {
	let p = split(ip, '.');
	return ((int(p[0]) * 256 + int(p[1])) * 256 + int(p[2])) * 256 + int(p[3]);
}

function int2ip(n) {
	return sprintf('%d.%d.%d.%d', (n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function cidr_range(c) {
	let p = split(c, '/');
	let bits = length(p) > 1 ? int(p[1]) : 32;
	let size = 1 << (32 - bits);
	let base = ip2int(p[0]);
	base -= base % size;
	return [ base, base + size - 1 ];
}

// nft ругается на пересекающиеся интервалы в анонимных наборах — сливаем сами
function merge_ranges(ranges) {
	ranges = sort(ranges, (a, b) => a[0] - b[0]);
	let out = [];
	for (let r in ranges) {
		let last = length(out) ? out[length(out) - 1] : null;
		if (last && r[0] <= last[1] + 1) {
			if (r[1] > last[1]) last[1] = r[1];
		}
		else
			push(out, [ r[0], r[1] ]);
	}
	return map(out, (r) => r[0] == r[1] ? int2ip(r[0]) : `${int2ip(r[0])}-${int2ip(r[1])}`);
}

function as_array(v) {
	return v == null ? [] : (type(v) == 'array' ? v : [ v ]);
}

const IGNORED_KEYS = { domain: 1, domain_suffix: 1, domain_keyword: 1, domain_regex: 1 };

// Подсети из списков -> правила цепочки pr_lists. Сохраняем ограничения по
// протоколу и портам (у discord, например, только UDP 50000-65535).
function rebuild_nft() {
	let groups = {};          // "l4|порты" -> [диапазоны]

	for (let name in st.lists) {
		let data;
		try { data = json(readfile(`${st.lists_dir}/${name}.json`)); } catch (e) { continue; }

		for (let r in data?.rules ?? []) {
			if (!r.ip_cidr) continue;
			let plain = true;
			for (let k in keys(r))
				if (!(k in [ 'ip_cidr', 'network', 'port', 'port_range' ]) && !IGNORED_KEYS[k]) plain = false;
			if (!plain) continue;   // source_*, invert, logical — в nft не переносим

			let nets = as_array(r.network);
			let l4 = length(nets) == 1 ? nets[0] : 'tcp, udp';
			let ports = [];
			for (let p in as_array(r.port)) push(ports, '' + p);
			for (let p in as_array(r.port_range)) {
				let m = match(p, /^([0-9]*):([0-9]*)$/);
				if (m) push(ports, `${m[1] == '' ? 0 : m[1]}-${m[2] == '' ? 65535 : m[2]}`);
			}

			let key = l4 + '|' + join(', ', ports);
			groups[key] ??= [];
			for (let c in as_array(r.ip_cidr))
				if (index(c, ':') < 0) push(groups[key], cidr_range(c));
		}
	}

	let t = st.nft_table, ch = st.nft_lists_chain;
	let nft = `flush chain inet ${t} ${ch}\n`;
	let n = 0;
	for (let key, ranges in groups) {
		if (!length(ranges)) continue;
		let kp = split(key, '|'), l4 = kp[0], ports = kp[1];
		let rule = `add rule inet ${t} ${ch} ip daddr { ${join(', ', merge_ranges(ranges))} } meta l4proto { ${l4} }`;
		if (ports != '') rule += ` th dport { ${ports} }`;
		nft += rule + ` meta mark set ${st.mark} return\n`;
		n++;
	}

	put(`${RUN}/lists.nft`, nft);
	// в пробном прогоне таблицы нет — проверяем вместе с её описанием
	let r = sh(DRY ? `cat ${RUN}/nft.conf ${RUN}/lists.nft | nft -c -f - 2>&1` : `nft -f ${RUN}/lists.nft 2>&1`);
	if (r.rc != 0) log(`nft: не удалось применить подсети списков: ${trim(r.out)}`);
	return n;
}

let list_info = {};

function update_lists() {
	let changed = false;
	for (let name in st.lists) {
		let path = `${st.lists_dir}/${name}.json`;
		let s = stat(path);
		if (s && s.size > 64 && time() - s.mtime < LIST_MAX_AGE) {
			list_info[name] = { updated: s.mtime };
			continue;
		}

		let tmp = `${RUN}/dl-${name}`;
		let r = sh(`curl -fsSL -m 120 -x socks5h://${st.mixed} -o ${tmp}.srs ${sq(sprintf(LIST_URL, name))} 2>&1 && ` +
			`sing-box rule-set decompile ${tmp}.srs -o ${tmp}.json 2>&1`);
		unlink(`${tmp}.srs`);
		let data = r.rc == 0 ? readfile(`${tmp}.json`) : null;
		unlink(`${tmp}.json`);

		let parsed = null;
		try { parsed = json(data); } catch (e) { }
		if (type(parsed?.rules) != 'array') {
			log(`список ${name}: не удалось скачать (${trim(r.out) || 'пустой ответ'}), остаётся прежний`);
			list_info[name] = { updated: s?.mtime, error: true };
			continue;
		}

		// /var/run и /etc могут быть на разных ФС — пишем рядом и переименовываем
		put(path, data);
		list_info[name] = { updated: time() };
		changed = true;
	}
	return changed;
}

// ---------------------------------------------------------------- статус

function write_status() {
	let chains = {};
	for (let key, members in st.chains)
		chains[key] = { members, active: active[key] };
	let out = { updated: time(), api: api_ok, nodes: {}, chains, lists: list_info };
	for (let name, n in nodes)
		out.nodes[name] = { kind: n.kind, where: n.where, up: n.up, delay: n.delay, since: n.since };
	put(`${RUN}/status.json`, sprintf('%J\n', out));
}

// ---------------------------------------------------------------- цикл

rebuild_nft();                 // сразу, из того, что уже скачано
let next_lists = 0;

while (true) {
	let alive = probe();
	api_ok = alive != null;
	if (api_ok) {
		update_nodes(alive);
		apply_chains();
		if (time() >= next_lists) {
			if (update_lists()) rebuild_nft();
			next_lists = time() + 3600;   // каждый список обновляется, когда ему больше суток
		}
	}
	write_status();
	sleep((api_ok ? st.check_interval : 2) * 1000);
}
