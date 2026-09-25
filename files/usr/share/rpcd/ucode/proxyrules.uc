// proxyrules: ubus object for the LuCI page
'use strict';

import { readfile, writefile, open, rename, mkdir, stat, popen } from 'fs';

const CONF = '/etc/proxyrules.conf';
const LIB = '/usr/share/proxyrules';
const RUN = '/var/run/proxyrules';
const INIT = '/etc/init.d/proxyrules';
const CHECK_DIR = '/tmp/proxyrules-check';
const REPO = 'm0n5ter/ProxyRules';
const UPGRADE_SH = '/tmp/proxyrules-install.sh';
const UPGRADE_LOG = '/tmp/proxyrules-upgrade.log';
const LANG_FILE = '/etc/proxyrules/lang';

// Messages in the interface language; the English text is the key
const RU = {
	'file is empty': 'файл пуст',
	'failed to write %s': 'не удалось записать %s',
	'saved, but the service did not come up: %s': 'сохранено, но сервис не поднялся: %s',
	'see logread -e proxyrules': 'см. logread -e proxyrules',
	'unknown action': 'неизвестное действие',
	'unexpected answer from GitHub': 'непонятный ответ GitHub',
	'bad release tag': 'неверный тег релиза',
	'an update is already running': 'обновление уже идёт',
	'failed to download the installer: %s': 'не удалось скачать установщик: %s',
	'enter a domain, a link or an IPv4 address': 'введите домен, ссылку или IPv4-адрес',
	'device: an IPv4 address': 'устройство: IPv4-адрес',
	'port: 1-65535': 'порт: 1-65535',
	'diagnostics failed: %s': 'диагностика не удалась: %s',
};

function lang() {
	return trim(readfile(LANG_FILE) ?? '') == 'ru' ? 'ru' : 'en';
}

function tr(fmt, ...args) {
	return sprintf(lang() == 'ru' ? (RU[fmt] ?? fmt) : fmt, ...args);
}

function sh(cmd) {
	let p = popen(cmd + ' 2>&1', 'r');
	if (!p) return { rc: -1, out: '' };
	let out = p.read('all') ?? '';
	return { rc: p.close(), out: trim(out) };
}

function write_private(path, data) {
	let f = open(path + '.new', 'w', 0o600);
	if (!f) return false;
	f.write(data);
	f.close();
	return rename(path + '.new', path);
}

function running() {
	return sh(`${INIT} running`).rc == 0;
}

// Check without applying: generator + sing-box check in a temporary directory.
// The directory is removed right away — it holds secrets.
function check(content) {
	if (type(content) != 'string' || trim(content) == '')
		return { ok: false, errors: tr('file is empty') };

	system([ 'rm', '-rf', CHECK_DIR ]);
	mkdir(CHECK_DIR, 0o700);
	write_private(`${CHECK_DIR}/rules.conf`, content);

	let res;
	let g = sh(`ucode ${LIB}/gen.uc ${CHECK_DIR}/rules.conf ${CHECK_DIR} ${CHECK_DIR}/lists`);
	if (g.rc != 0)
		res = { ok: false, errors: g.out };
	else {
		let c = sh(`sing-box check -c ${CHECK_DIR}/config.json`);
		res = c.rc == 0 ? { ok: true, summary: g.out } : { ok: false, errors: 'sing-box: ' + c.out };
	}
	system([ 'rm', '-rf', CHECK_DIR ]);
	return res;
}

function version() {
	return trim(readfile(`${LIB}/version`) ?? '') || null;
}

// Is a newer than b? Only the leading x.y.z is compared: a build from git
// (1.2.0-3-gabc1234) counts as equal to its release 1.2.0.
function newer(a, b) {
	let x = match(a ?? '', /^v?([0-9]+)\.([0-9]+)\.([0-9]+)/);
	let y = match(b ?? '', /^v?([0-9]+)\.([0-9]+)\.([0-9]+)/);
	if (!x) return false;
	if (!y) return true;
	for (let i = 1; i <= 3; i++)
		if (+x[i] != +y[i]) return +x[i] > +y[i];
	return false;
}

// The latest release on GitHub (checked only on a button press on the page)
function latest() {
	let r = sh(`curl -fsS -m 15 -H 'Accept: application/vnd.github+json' https://api.github.com/repos/${REPO}/releases/latest`);
	let rel = null;
	try { rel = r.rc == 0 ? json(r.out) : null; } catch (e) { }
	if (type(rel?.tag_name) == 'string')
		return { tag: rel.tag_name, url: rel.html_url };
	return { error: r.out || tr('unexpected answer from GitHub') };
}

// The update runs as a separate process (setsid): install.sh reloads rpcd
// and restarts the service. The last log line "rc=N" means it has finished.
function upgrade_state() {
	let log = readfile(UPGRADE_LOG);
	if (log == null) return null;
	let m = match(log, /\nrc=([0-9]+)\n*$/);
	return { log: trim(replace(log, /\nrc=[0-9]+\n*$/, '')), done: !!m, ok: m ? m[1] == '0' : null };
}

// "https://www.Example.com:8443/path" -> "www.example.com"
function diag_host(s) {
	s = lc(trim(s ?? ''));
	s = replace(s, /^[a-z][a-z0-9+.-]*:\/\//, '');
	s = replace(s, /[\/?#].*$/, '');
	s = replace(s, /:[0-9]*$/, '');
	s = replace(s, /^\*?\./, '');
	s = replace(s, /\.$/, '');
	return s;
}

const IPV4 = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/;

const methods = {
	get: {
		call: function() {
			return { content: readfile(CONF) ?? '' };
		}
	},

	check: {
		args: { content: '' },
		call: function(req) {
			return check(req.args?.content);
		}
	},

	save: {
		args: { content: '' },
		call: function(req) {
			let content = req.args?.content;
			let r = check(content);
			if (!r.ok) return r;
			if (!write_private(CONF, content))
				return { ok: false, errors: tr('failed to write %s', CONF) };
			if (running()) {
				let s = sh(`${INIT} restart`);
				if (!running())
					return { ok: false, saved: true, errors: tr('saved, but the service did not come up: %s', s.out || tr('see logread -e proxyrules')) };
				r.restarted = true;
			}
			return r;
		}
	},

	service: {
		args: { action: '' },
		call: function(req) {
			let a = req.args?.action, s;
			if (a == 'start') { sh(`${INIT} enable`); s = sh(`${INIT} start`); }
			else if (a == 'stop') { sh(`${INIT} disable`); s = sh(`${INIT} stop`); }
			else if (a == 'restart') s = sh(`${INIT} restart`);
			else return { ok: false, errors: tr('unknown action') };
			let up = running();
			return { ok: a == 'stop' ? !up : up, errors: s.out };
		}
	},

	status: {
		call: function() {
			let st = null;
			try { st = json(readfile(`${RUN}/status.json`)); } catch (e) { }
			return {
				running: running(),
				enabled: sh(`${INIT} enabled`).rc == 0,
				error: readfile(`${RUN}/error`),
				status: st,
				version: version(),
				lang: lang(),
				upgrade: upgrade_state(),
			};
		}
	},

	// Which way traffic to a site goes: diag.uc in a separate process (the lists are big)
	diag: {
		args: { host: '', src: '', port: 0, network: '' },
		call: function(req) {
			let host = diag_host(req.args?.host);
			let src = trim(req.args?.src ?? '');
			let port = int(req.args?.port ?? 443) || 443;
			let net = req.args?.network == 'udp' ? 'udp' : 'tcp';
			if (host != '' && (length(host) > 253 || !match(host, /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9])?$/)))
				return { ok: false, errors: tr('enter a domain, a link or an IPv4 address') };
			if (src != '' && !match(src, IPV4))
				return { ok: false, errors: tr('device: an IPv4 address') };
			if (port < 1 || port > 65535)
				return { ok: false, errors: tr('port: 1-65535') };
			let r = sh(`ucode ${LIB}/diag.uc ${RUN} ${host || '-'} ${src || '-'} ${port} ${net}`);
			let res = null;
			try { res = json(r.out); } catch (e) { }
			if (r.rc != 0 || type(res) != 'object')
				return { ok: false, errors: tr('diagnostics failed: %s', r.out) };
			res.ok = true;
			return res;
		}
	},

	set_lang: {
		args: { lang: '' },
		call: function(req) {
			let l = req.args?.lang;
			if (l != 'en' && l != 'ru') return { ok: false, errors: 'lang: en or ru' };
			mkdir('/etc/proxyrules', 0o700);
			return { ok: !!writefile(LANG_FILE, l + '\n') };
		}
	},

	update: {
		call: function() {
			let l = latest(), cur = version();
			return { current: cur, latest: l.tag, url: l.url, error: l.error, newer: l.tag ? newer(l.tag, cur) : false };
		}
	},

	upgrade: {
		args: { tag: '' },
		call: function(req) {
			let tag = req.args?.tag;
			if (type(tag) != 'string' || !match(tag, /^v[0-9]+\.[0-9]+\.[0-9]+$/))
				return { ok: false, errors: tr('bad release tag') };
			let u = upgrade_state();
			if (u && !u.done)
				return { ok: false, errors: tr('an update is already running') };
			// the installer comes from the same release: it knows which packages the new version needs
			let d = sh(`curl -fsSL -m 15 -o ${UPGRADE_SH} https://github.com/${REPO}/releases/download/${tag}/install.sh && sh -n ${UPGRADE_SH}`);
			if (d.rc != 0)
				return { ok: false, errors: tr('failed to download the installer: %s', d.out) };
			writefile(UPGRADE_LOG, '');
			system(`setsid sh -c 'sh ${UPGRADE_SH} ${tag}; rc=$?; echo; echo rc=$rc' >${UPGRADE_LOG} 2>&1 </dev/null &`);
			return { ok: true };
		}
	},
};

return { proxyrules: methods };
