// proxyrules: which way traffic to a site goes.
//
//   ucode diag.uc <rundir> <host|-> [src|-] [port] [tcp|udp]
//
// Prints JSON: what sing-box's DNS answers, whether nftables sends the traffic
// to sing-box, which rule of the running config catches it, where the target leads
// right now — and the connections open at the moment (Clash API).
// The running config is used (state.json), not unsaved edits.
'use strict';

import { readfile, popen } from 'fs';

const DNS = '127.0.0.43';      // sing-box's DNS (DNS_ADDR in gen.uc)
const RUN = ARGV[0] ?? '/var/run/proxyrules';
const arg = (i) => (ARGV[i] == null || ARGV[i] == '-' || ARGV[i] == '') ? null : ARGV[i];
const HOST = arg(1), SRC = arg(2), PORT = int(arg(3) ?? 443), NET = arg(4) ?? 'tcp';

function sh(cmd) {
	let p = popen(cmd + ' 2>&1', 'r');
	if (!p) return { rc: -1, out: '' };
	let out = p.read('all') ?? '';
	return { rc: p.close(), out };
}

function sq(s) {
	return "'" + replace(s, "'", "'\\''") + "'";
}

function load(path) {
	try { return json(readfile(path)); } catch (e) { return null; }
}

function as_array(v) {
	return v == null ? [] : (type(v) == 'array' ? v : [ v ]);
}

function is_ipv4(s) {
	return type(s) == 'string' && !!match(s, /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/);
}

function ip2int(ip) {
	let p = split(ip, '.');
	return ((int(p[0]) * 256 + int(p[1])) * 256 + int(p[2])) * 256 + int(p[3]);
}

function in_cidr(ip, c) {
	if (!is_ipv4(ip) || index(c, ':') >= 0) return false;
	let p = split(c, '/');
	let size = 1 << (32 - (length(p) > 1 ? int(p[1]) : 32));
	let base = ip2int(p[0]);
	base -= base % size;
	let n = ip2int(ip);
	return n >= base && n < base + size;
}

function in_any(ip, cidrs) {
	for (let c in as_array(cidrs))
		if (in_cidr(ip, c)) return true;
	return false;
}

// as sing-box domain_suffix: "a.com" — a.com and its subdomains, ".a.com" — subdomains only
function suffix(host, v) {
	if (substr(v, 0, 1) == '.') return length(host) > length(v) && substr(host, -length(v)) == v;
	return host == v || (length(host) > length(v) && substr(host, -length(v) - 1) == '.' + v);
}

function port_in(port, v) {
	let m = match('' + v, /^([0-9]*)[-:]([0-9]*)$/);
	if (m) return port >= int(m[1] || 0) && port <= int(m[2] || 65535);
	return port == int(v);
}

let st = load(`${RUN}/state.json`);
let status = load(`${RUN}/status.json`);
let running = system('/etc/init.d/proxyrules running >/dev/null 2>&1') == 0;
let out = { running, query: { host: HOST, src: SRC, port: PORT, network: NET } };

// what sniffing will see: TLS on 443, HTTP on 80, QUIC on udp/443
let proto = NET == 'udp' ? (PORT == 443 ? 'quic' : null) : (PORT == 443 ? 'tls' : PORT == 80 ? 'http' : null);
out.query.protocol = proto;

// ---------------------------------------------------------------- lists

let lists = {};
function list(name) {
	if (!exists(lists, name)) lists[name] = load(`${st.lists_dir}/${name}.json`)?.rules ?? [];
	return lists[name];
}

// a headless rule of a rule set: (domain… || ip_cidr) && network && port
function list_rule_match(r, domain, ip, only_ip) {
	if (r.type == 'logical' || r.invert) return false;
	if (r.network && !(NET in as_array(r.network))) return false;
	if (r.port || r.port_range) {
		let ok = false;
		for (let p in [ ...as_array(r.port), ...as_array(r.port_range) ])
			if (port_in(PORT, p)) ok = true;
		if (!ok) return false;
	}
	if (ip && r.ip_cidr && in_any(ip, r.ip_cidr)) return true;
	if (only_ip || !domain) return false;
	for (let v in as_array(r.domain)) if (domain == v) return true;
	for (let v in as_array(r.domain_suffix)) if (suffix(domain, v)) return true;
	for (let v in as_array(r.domain_keyword)) if (index(domain, v) >= 0) return true;
	for (let v in as_array(r.domain_regex)) {
		try { if (match(domain, regexp(v))) return true; } catch (e) { }
	}
	return false;
}

function list_match(name, domain, ip, only_ip) {
	for (let r in list(name))
		if (list_rule_match(r, domain, ip, only_ip)) return true;
	return false;
}

// ---------------------------------------------------------------- rules

function cond_match(c, x) {
	let hit = false;
	for (let v in c.values) {
		if (c.type == 'domain') hit = x.domain && suffix(x.domain, v);
		else if (c.type == 'list') hit = list_match(v, x.domain, x.ip);
		else if (c.type == 'ip') hit = in_cidr(x.ip, v);
		else if (c.type == 'src') hit = in_cidr(x.src, v);
		else if (c.type == 'port') hit = port_in(PORT, v);
		else if (c.type == 'protocol') hit = v == proto;
		if (hit) break;
	}
	return c.neg ? !hit : hit;
}

function first_rule(x) {
	for (let r in st.rules) {
		let ok = true;
		for (let c in r.conds)
			if (!cond_match(c, x)) { ok = false; break; }
		if (ok) return r;
	}
	return null;
}

function rule_text(r) {
	return join(' & ', map(r.conds, (c) => (c.neg ? '!' : '') + c.type + ':' + join(', ', c.values))) + ' -> ' + r.target;
}

// Does nftables send a connection to a real address to sing-box? The same order as pr_prerouting.
function intercept(ip) {
	if (in_any(ip, st.local)) return { to: false, by: 'local' };
	if (in_cidr(ip, st.fakeip)) return { to: true, by: 'fakeip' };
	for (let m in st.intercept) {
		if (m.src && !in_any(SRC, m.src)) continue;
		if (m.dst && !in_any(ip, m.dst)) continue;
		if (m.ports) {
			let ok = false;
			for (let p in m.ports) if (port_in(PORT, p)) ok = true;
			if (!ok) continue;
		}
		return { to: !m.direct, by: 'rule', ln: m.ln };
	}
	for (let name in st.lists)
		if (list_match(name, null, ip, true)) return { to: true, by: 'list', list: name };
	return { to: false, by: 'none' };
}

// A target -> where it leads right now
function path(target) {
	if (target == 'direct' || target == 'block') return { kind: target };
	let conn = (name) => {
		let c = filter(st.connections, (c) => c.name == name)[0];
		let n = status?.nodes?.[name];
		return c ? { name, kind: c.kind, where: c.where, up: n?.up, delay: n?.delay } : { name };
	};
	if (st.chains[target]) {
		// active is a member, direct, or "<chain>~auto" when all are down
		let active = status?.chains?.[target]?.active, via = null;
		if (active == 'direct') via = { name: 'direct', kind: 'direct' };
		else if (active && !match(active, /~auto$/)) via = conn(active);
		return { kind: 'chain', chain: target, members: st.chains[target], active, via };
	}
	return { kind: 'conn', via: conn(target) };
}

// ---------------------------------------------------------------- the site

// stopped — everything goes direct; a state.json without rules — the service was started
// by an older version and has to be restarted
if (HOST && !running) out.stopped = true;
else if (HOST && !st?.rules) out.outdated = true;
else if (HOST) {
	let domain = is_ipv4(HOST) ? null : HOST;
	let dns = { addrs: [] };
	if (domain) {
		// the devices ask dnsmasq, which asks sing-box — here sing-box is asked directly
		let r = sh(`nslookup ${sq(domain)} ${DNS}`);
		let after = false;
		for (let l in split(r.out, '\n')) {
			if (match(l, /^Name:/)) after = true;
			let m = after && match(l, /^Address( [0-9]+)?:[[:space:]]*([0-9.]+)[[:space:]]*$/);
			if (m && is_ipv4(m[2]) && !(m[2] in dns.addrs)) push(dns.addrs, m[2]);
		}
		if (!length(dns.addrs)) dns.error = trim(r.out);
		dns.fake = length(dns.addrs) > 0 && in_cidr(dns.addrs[0], st.fakeip);
	}
	else
		dns.addrs = [ HOST ];
	out.dns = domain ? dns : null;

	let ip = dns.addrs[0];
	if (ip) {
		let ic = intercept(ip);
		out.intercept = ic;
		if (ic.to) {
			// fake-ip: sing-box knows the domain and not the address (ip: doesn't fire);
			// otherwise the address is real and the domain comes from sniffing
			let x = { domain, ip: dns.fake ? null : ip, src: SRC };
			let r = first_rule(x);
			out.rule = r ? { ln: r.ln, text: rule_text(r), target: r.target } : null;
			out.target = r ? r.target : 'direct';
			out.path = path(out.target);
		}
		else {
			// in sing-box a direct rule above could have caught it — here nft let it go by
			out.target = 'direct';
			out.path = { kind: 'direct' };
		}
	}
}

// ---------------------------------------------------------------- live connections

// only for a site or a device — with neither, only the device list is returned
if (running && st && (HOST || SRC)) {
	let r = sh(`curl -s -m 5 -H ${sq('Authorization: Bearer ' + st.secret)} http://${st.api}/connections`);
	let data = null;
	try { data = json(r.out); } catch (e) { }
	let q = HOST ? lc(HOST) : null;
	let addrs = out.dns?.addrs ?? (HOST ? [ HOST ] : []);
	let conns = [];
	for (let c in data?.connections ?? []) {
		let m = c.metadata ?? {};
		if (SRC && m.sourceIP != SRC) continue;
		if (q && !(m.host && suffix(lc(m.host), q)) && !(m.destinationIP in addrs)) continue;
		push(conns, {
			src: m.sourceIP, host: m.host || null, ip: m.destinationIP || null, port: m.destinationPort,
			network: m.network, chains: c.chains, rule: c.rule, up: c.upload, down: c.download, start: c.start,
		});
	}
	conns = sort(conns, (a, b) => a.start < b.start ? 1 : a.start > b.start ? -1 : 0);
	out.total = length(conns);
	out.connections = slice(conns, 0, 100);
	out.api = data != null;
}

// the devices from DHCP — for the picker on the page
out.devices = [];
for (let l in split(readfile('/tmp/dhcp.leases') ?? '', '\n')) {
	let f = split(l, ' ');
	if (length(f) >= 4 && is_ipv4(f[2])) push(out.devices, { ip: f[2], name: f[3] == '*' ? null : f[3] });
}

print(sprintf('%J\n', out));
