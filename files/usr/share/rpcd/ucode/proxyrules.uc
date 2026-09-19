// proxyrules: ubus-объект для страницы LuCI
'use strict';

import { readfile, open, rename, mkdir, stat, popen } from 'fs';

const CONF = '/etc/proxyrules.conf';
const LIB = '/usr/share/proxyrules';
const RUN = '/var/run/proxyrules';
const INIT = '/etc/init.d/proxyrules';
const CHECK_DIR = '/tmp/proxyrules-check';

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

// Проверка без применения: генератор + sing-box check во временном каталоге.
// Каталог удаляется сразу — в нём секреты.
function check(content) {
	if (type(content) != 'string' || trim(content) == '')
		return { ok: false, errors: 'файл пуст' };

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
				return { ok: false, errors: `не удалось записать ${CONF}` };
			if (running()) {
				let s = sh(`${INIT} restart`);
				if (!running())
					return { ok: false, errors: 'сохранено, но сервис не поднялся: ' + (s.out || 'см. logread -e proxyrules') };
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
			else return { ok: false, errors: 'неизвестное действие' };
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
				legacy: sh('nft list table inet LegacyTable >/dev/null').rc == 0,
				error: readfile(`${RUN}/error`),
				status: st,
			};
		}
	},
};

return { proxyrules: methods };
