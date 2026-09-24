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
		return { ok: false, errors: 'file is empty' };

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
	return { error: r.out || 'unexpected answer from GitHub' };
}

// The update runs as a separate process (setsid): install.sh reloads rpcd
// and restarts the service. The last log line "rc=N" means it has finished.
function upgrade_state() {
	let log = readfile(UPGRADE_LOG);
	if (log == null) return null;
	let m = match(log, /\nrc=([0-9]+)\n*$/);
	return { log: trim(replace(log, /\nrc=[0-9]+\n*$/, '')), done: !!m, ok: m ? m[1] == '0' : null };
}

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
				return { ok: false, errors: `failed to write ${CONF}` };
			if (running()) {
				let s = sh(`${INIT} restart`);
				if (!running())
					return { ok: false, errors: 'saved, but the service did not come up: ' + (s.out || 'see logread -e proxyrules') };
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
			else return { ok: false, errors: 'unknown action' };
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
				upgrade: upgrade_state(),
			};
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
				return { ok: false, errors: 'bad release tag' };
			let u = upgrade_state();
			if (u && !u.done)
				return { ok: false, errors: 'an update is already running' };
			// the installer comes from the same release: it knows which packages the new version needs
			let d = sh(`curl -fsSL -m 15 -o ${UPGRADE_SH} https://github.com/${REPO}/releases/download/${tag}/install.sh && sh -n ${UPGRADE_SH}`);
			if (d.rc != 0)
				return { ok: false, errors: 'failed to download the installer: ' + d.out };
			writefile(UPGRADE_LOG, '');
			system(`setsid sh -c 'sh ${UPGRADE_SH} ${tag}; rc=$?; echo; echo rc=$rc' >${UPGRADE_LOG} 2>&1 </dev/null &`);
			return { ok: true };
		}
	},
};

return { proxyrules: methods };
