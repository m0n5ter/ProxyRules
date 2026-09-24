'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';

const callGet = rpc.declare({ object: 'proxyrules', method: 'get' });
const callCheck = rpc.declare({ object: 'proxyrules', method: 'check', params: [ 'content' ] });
const callSave = rpc.declare({ object: 'proxyrules', method: 'save', params: [ 'content' ] });
const callService = rpc.declare({ object: 'proxyrules', method: 'service', params: [ 'action' ] });
const callStatus = rpc.declare({ object: 'proxyrules', method: 'status' });

function ago(ts) {
	if (!ts) return '—';
	const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
	if (s < 90) return s + ' s';
	if (s < 5400) return Math.round(s / 60) + ' min';
	if (s < 129600) return Math.round(s / 3600) + ' h';
	return Math.round(s / 86400) + ' d';
}

const LISTS = [ 'anime', 'block', 'cloudflare', 'cloudfront', 'digitalocean', 'discord', 'geoblock',
	'google_ai', 'google_meet', 'google_play', 'hdrezka', 'hetzner', 'hodca', 'meta', 'news', 'ovh', 'porn',
	'roblox', 'russia_inside', 'russia_outside', 'telegram', 'tiktok', 'twitter', 'ukraine_inside', 'youtube' ];

const PLACEHOLDERS = {
	domain: 'upwork.com, static-upwork.com',
	list: 'discord',
	ip: '203.0.113.0/24',
	src: '192.168.1.15',
	port: '443, 50000-65535',
};
const RULE_TYPES = Object.keys(PLACEHOLDERS);

const SETTINGS = [
	{ name: 'interfaces', def: 'br-lan', title: 'Interfaces', descr: 'Where to intercept traffic from, separated by spaces.' },
	{ name: 'dns', def: '8.8.8.8', title: 'DNS server', descr: 'DoH server: IP address or hostname.' },
	{ name: 'bootstrap', def: '77.88.8.8', title: 'Bootstrap DNS', descr: 'Plain DNS (IPv4) used to resolve the DoH server by name.' },
	{ name: 'check_url', def: 'https://www.gstatic.com/generate_204', title: 'Check URL', descr: 'Requested through each connection to see whether it is alive.' },
	{ name: 'check_interval', def: '10', title: 'Check interval', descr: 'Seconds between connection checks, 5 to 3600.' },
	{ name: 'lists_via', def: 'direct', title: 'Download lists via', descr: 'Connection or chain used to download list: rules.', target: true },
	{ name: 'log', def: 'warn', title: 'Log level', options: [ 'trace', 'debug', 'info', 'warn', 'error' ] },
];

const NAME_RE = /^[A-Za-z0-9-]{1,32}$/;
const STRUCT = { setting: true, conn: true, chain: true };

// ─────────────────────────────────────────────────────────────── модель файла
//
// Файл — список элементов: blank, note (подряд идущие строки-комментарии), setting,
// conn, chain, rule, raw (нераспознанная строка). Пока элемент не изменён (dirty),
// он пишется обратно своими исходными строками — форматирование и комментарии
// файла сохраняются как есть.

// Комментарий — как в gen.uc: «#» в начале или после пробела
function splitComment(raw) {
	const m = raw.match(/(^|\s)#(.*)$/);
	return m ? { body: raw.slice(0, m.index).trim(), comment: m[2].trim() } : { body: raw.trim(), comment: '' };
}

function stripComment(line) {
	return splitComment(line).body;
}

function splitNames(s) {
	return s.split(',').map((t) => t.trim()).filter((t) => t != '');
}

function parseLine(raw) {
	const { body, comment } = splitComment(raw);
	const it = { lines: [ raw ], comment };
	if (body == '')
		return Object.assign(it, { kind: raw.trim() == '' ? 'blank' : 'note' });

	let m = body.match(/^@([a-z_]+)\s*=\s*(.*)$/);
	if (m) return Object.assign(it, { kind: 'setting', name: m[1], value: m[2] });

	m = body.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
	if (m && /^(vless:\/\/|iface:)/.test(m[2]))
		return Object.assign(it, { kind: 'conn', name: m[1], link: m[2] });
	if (m)
		return Object.assign(it, { kind: 'chain', name: m[1], members: splitNames(m[2]) });

	m = body.match(/^(!?[a-z]+:.+)->(.+)$/);
	if (m) {
		const conds = m[1].split('&').map((p) => p.trim().match(/^(!?)([a-z]+):(.*)$/));
		if (conds.every((c) => c && RULE_TYPES.includes(c[2]) && c[3].trim() != ''))
			return Object.assign(it, {
				kind: 'rule',
				conds: conds.map((c) => ({ neg: c[1] == '!', type: c[2], values: c[3].trim().split(/[\s,]+/).filter((v) => v != '') })),
				target: splitNames(m[2]).join(','),
			});
	}
	return Object.assign(it, { kind: 'raw' });
}

function parseDoc(text) {
	const items = [];
	for (const raw of text.split('\n')) {
		const it = parseLine(raw);
		const last = items[items.length - 1];
		if (it.kind == 'note' && last && last.kind == 'note') last.lines.push(raw);
		else items.push(it);
	}
	return items;
}

function noteText(it) {
	return it.lines.map((l) => l.replace(/^\s*#\s?/, '')).join('\n');
}

function withComment(line, comment, col) {
	if (!comment) return line;
	return (line.length < col ? line.padEnd(col) : line + '   ') + '# ' + comment;
}

function condsText(conds) {
	return conds.map((c) => (c.neg ? '!' : '') + c.type + ':' + c.values.join(', ')).join(' & ');
}

// Колонки — как в proxyrules.conf.example; «->» правила — под «->» правила выше (arrow)
function formatItem(it, arrow) {
	switch (it.kind) {
	case 'note': return it.text.split('\n').map((l) => l.trim() == '' ? '#' : '# ' + l);
	case 'setting': return [ withComment(('@' + it.name).padEnd(15) + ' = ' + it.value, it.comment, 36) ];
	case 'conn': return [ withComment(it.name.padEnd(3) + ' = ' + it.link, it.comment, 0) ];
	case 'chain': return [ withComment(it.name.padEnd(8) + ' = ' + it.members.join(','), it.comment, 27) ];
	case 'rule': return [ withComment(condsText(it.conds).padEnd((arrow || 60) - 1) + ' -> ' + it.target, it.comment, (arrow || 60) + 14) ];
	default: return it.lines;
	}
}

function itemLines(it) {
	return it.dirty ? formatItem(it) : it.lines;
}

function serialize(items) {
	let arrow = 0;
	return items.flatMap((it) => {
		const lines = it.dirty ? formatItem(it, arrow) : it.lines;
		// колонка берётся только у выровненного правила (слишком длинное её не задаёт)
		const body = it.kind == 'rule' ? stripComment(lines[0]) : '';
		if (/\s\s->/.test(body)) arrow = body.lastIndexOf('->');
		return lines;
	}).join('\n');
}

// Значения через запятую/пробел; для domain: из вставленной ссылки остаётся только хост
function normalizeValues(kind, raw) {
	return raw.split(/[\s,]+/).filter((v) => v != '').map((v) => {
		if (kind != 'domain') return v;
		return v.toLowerCase()
			.replace(/^[a-z]+:\/\//, '')
			.replace(/[\/?#].*$/, '')
			.replace(/:\d+$/, '')
			.replace(/^\*?\./, '')
			.replace(/^www\./, '')
			.replace(/\.$/, '');
	}).filter((v, i, a) => v != '' && a.indexOf(v) == i);
}

// vless://… → «vless · reality · 1.2.3.4:443» — без секретов
function linkSummary(link) {
	let m = link.match(/^iface:(.+)$/);
	if (m) return 'interface ' + m[1];
	m = link.match(/^vless:\/\/[^@]+@([^:/?#]+):([0-9]+)\/?(\?[^#]*)?/);
	if (!m) return link.replace(/:\/\/.*/, '://…');
	const q = {};
	for (const kv of (m[3] || '?').slice(1).split('&')) {
		const i = kv.indexOf('=');
		if (i > 0) try { q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { }
	}
	return [ 'vless', q.security || 'none', q.type && q.type != 'tcp' ? q.type : null, m[1] + ':' + m[2], q.sni ? 'sni ' + q.sni : null ]
		.filter((x) => x).join(' · ');
}

// ─────────────────────────────────────────────────────────────── вид

function nodeState(n) {
	if (n.up === true) return E('span', { style: 'color:#2a2' }, '● up');
	if (n.up === false) return E('span', { style: 'color:#d33' }, '● not responding');
	return E('span', { style: 'color:#888' }, '○ checking');
}

// Пользовательский текст — только текстовыми узлами (строка-потомок в E() идёт как innerHTML)
function T(tag, attrs, text) {
	return E(tag, attrs || {}, [ String(text) ]);
}

function btn(label, title, fn, cls) {
	return E('button', { class: 'btn cbi-button ' + (cls || 'pr-icon'), title: title, click: (ev) => { ev.preventDefault(); fn(); } }, [ label ]);
}

const CSS = `
.pr-tabs { margin-bottom: 0 }
.pr-toolbar { display:flex; flex-wrap:wrap; gap:.5em; align-items:center; margin:.8em 0 }
.pr-toolbar .pr-filter { flex:0 1 20em; min-width:10em }
.pr-list { margin:.3em 0 1em }
.pr-row { display:grid; gap:.25em .8em; align-items:center; padding:.35em .3em; border-bottom:1px solid rgba(128,128,128,.18) }
.pr-row:hover { background:rgba(128,128,128,.07) }
.pr-rules > .pr-row { grid-template-columns:1.4em minmax(0,1fr) minmax(7em,11em) minmax(0,13em) auto }
.pr-conns > .pr-row { grid-template-columns:minmax(6em,10em) minmax(0,1fr) minmax(0,14em) auto }
.pr-row.pr-head { font-size:85%; opacity:.6; border-bottom-color:rgba(128,128,128,.4) }
.pr-row.pr-head:hover { background:none }
.pr-row.pr-note { display:flex; gap:.8em; padding-top:1.1em; border-bottom-color:rgba(128,128,128,.45) }
.pr-note .pr-note-text { flex:1; font-weight:bold; white-space:pre-wrap }
.pr-note .pr-note-text .pr-sub { font-weight:normal; opacity:.7 }
.pr-note .pr-note-input { flex:1; min-width:0; font:inherit; font-weight:bold; resize:none; overflow:hidden; line-height:1.5 }
.pr-handle { cursor:grab; opacity:.35; user-select:none; text-align:center; letter-spacing:-.2em }
.pr-handle:hover { opacity:.8 }
.pr-and { opacity:.55; font-size:85%; margin:0 .3em }
.pr-cond { overflow-wrap:anywhere }
.pr-tag { display:inline-block; padding:0 .4em; margin-right:.3em; border-radius:3px; font-size:85%; font-weight:bold; background:rgba(128,128,128,.2); white-space:nowrap }
.pr-tag-domain { background:rgba(58,123,213,.2) }
.pr-tag-list { background:rgba(142,68,173,.22) }
.pr-tag-ip { background:rgba(230,126,34,.25) }
.pr-tag-src { background:rgba(39,174,96,.22) }
.pr-tag-port { background:rgba(128,128,128,.25) }
.pr-neg .pr-tag { text-decoration:line-through }
.pr-target { display:inline-block; padding:.05em .5em; border-radius:3px; font-weight:bold; overflow-wrap:anywhere; background:rgba(128,128,128,.2) }
.pr-t-chain { background:rgba(58,123,213,.2) }
.pr-t-conn { background:rgba(22,160,133,.22) }
.pr-t-block { background:rgba(220,50,50,.25) }
.pr-t-unknown { background:none; outline:1px dashed #d33; color:#d33 }
.pr-rules > .pr-row > .pr-c-wide { grid-column:2 / span 3 }
.pr-comment { opacity:.65; font-size:90%; overflow-wrap:anywhere }
.pr-mono { font-family:monospace; font-size:90%; overflow-wrap:anywhere }
.pr-actions { white-space:nowrap; text-align:right }
.pr-actions .btn, .pr-icon { padding:0 .55em !important; min-width:2.2em; margin:0 0 0 .2em !important; line-height:1.9 }
@media (hover: hover) {
	.pr-row > .pr-actions { opacity:.3; transition:opacity .15s }
	.pr-row:hover > .pr-actions, .pr-row:focus-within > .pr-actions { opacity:1 }
}
.pr-dragging { opacity:.35 }
.pr-drop-before { box-shadow:inset 0 3px 0 #3a7bd5 }
.pr-drop-after { box-shadow:inset 0 -3px 0 #3a7bd5 }
.pr-has-error { background:rgba(220,50,50,.09) }
.pr-errmsg { grid-column:1 / -1; color:#d33; white-space:pre-wrap; font-size:90% }
.pr-flash { animation:pr-flash 2.5s ease-out }
@keyframes pr-flash { from { background:rgba(255,196,0,.45) } to { background:transparent } }
.pr-edit { padding:.7em .8em; margin:.4em 0; border:1px solid rgba(58,123,213,.55); border-radius:4px; background:rgba(58,123,213,.05) }
.pr-edit .pr-line { display:flex; flex-wrap:wrap; gap:.4em; align-items:center; margin:.35em 0 }
.pr-edit .pr-label { min-width:6em; opacity:.75 }
.pr-edit .pr-grow { flex:1 1 18em; min-width:10em }
.pr-edit .pr-err { color:#d33 }
.pr-chip { display:inline-flex; align-items:center; gap:.2em; padding:.1em .2em .1em .5em; margin:.15em; border-radius:3px; background:rgba(58,123,213,.18) }
.pr-chip .btn { padding:0 .35em !important; min-width:0; line-height:1.5 }
.pr-dirty { color:#e67e22; font-weight:bold; margin-right:auto }
.pr-empty { padding:1em; opacity:.6 }
@media (max-width: 800px) {
	.pr-rules > .pr-row { grid-template-columns:1.4em minmax(0,1fr) auto }
	.pr-rules > .pr-row > .pr-c-conds, .pr-rules > .pr-row > .pr-c-wide { grid-column:2; grid-row:1 }
	.pr-rules > .pr-row > .pr-c-actions { grid-column:3; grid-row:1 / span 3 }
	.pr-rules > .pr-row > .pr-c-target, .pr-rules > .pr-row > .pr-c-comment { grid-column:2 }
	.pr-rules > .pr-row > .pr-c-comment:empty, .pr-row.pr-head { display:none }
	.pr-conns > .pr-row { grid-template-columns:minmax(0,1fr) auto }
	.pr-conns > .pr-row > .pr-c-actions { grid-column:2; grid-row:1 / span 3 }
	.pr-conns > .pr-row > :not(.pr-c-actions) { grid-column:1 }
}
`;

return view.extend({
	load() {
		return Promise.all([ callGet(), callStatus() ]);
	},

	renderStatus(st) {
		const out = [];

		if (!st.running) {
			out.push(E('p', { class: 'alert-message warning' }, 'Service is stopped.'));
			if (st.error)
				out.push(E('pre', { class: 'alert-message error', style: 'white-space:pre-wrap' }, [ st.error ]));
		}

		const s = st.status;
		if (st.running && s) {
			if (!s.api)
				out.push(E('p', { class: 'alert-message warning' }, 'sing-box is not responding (still starting?)'));

			const names = Object.keys(s.nodes || {});
			if (names.length) {
				out.push(E('table', { class: 'table' }, [
					E('tr', { class: 'tr table-titles' }, [
						E('th', { class: 'th' }, 'Connection'),
						E('th', { class: 'th' }, 'Endpoint'),
						E('th', { class: 'th' }, 'State'),
						E('th', { class: 'th' }, 'Latency'),
						E('th', { class: 'th' }, 'In this state for'),
					]),
					...names.map((name) => {
						const n = s.nodes[name];
						return E('tr', { class: 'tr' }, [
							E('td', { class: 'td' }, E('strong', [ name ])),
							E('td', { class: 'td' }, [ n.kind == 'iface' ? 'interface ' + n.where : n.where ]),
							E('td', { class: 'td' }, nodeState(n)),
							E('td', { class: 'td' }, n.delay != null ? n.delay + ' ms' : '—'),
							E('td', { class: 'td' }, ago(n.since)),
						]);
					}),
				]));
			}

			const chains = Object.keys(s.chains || {});
			if (chains.length) {
				out.push(E('p', { style: 'margin-top:1em' }, E('strong', 'Chains (bold — where traffic goes right now):')));
				// Две колонки: имя (по ширине самого длинного) и участники
				out.push(E('div', { style: 'display:grid;grid-template-columns:max-content 1fr;gap:.3em 1.5em;margin-left:1em' }, chains.flatMap((key) => {
					const c = s.chains[key];
					// У заданных прямо в правиле ключ вида "TR_DE_UK" — в именах «_» запрещён
					const name = key.includes('_')
						? E('em', { style: 'opacity:.7' }, 'inline')
						: E('strong', {}, [ key ]);
					const parts = [];
					c.members.forEach((m, i) => {
						if (i) parts.push(' → ');
						parts.push(m == c.active ? E('strong', { style: 'color:#2a2' }, [ m ]) : E('span', { style: 'opacity:.55' }, [ m ]));
					});
					if (c.active && c.active.endsWith('~auto'))
						parts.push(E('em', { style: 'color:#d33' }, '  — all down, sing-box is looking for a live one itself'));
					return [E('div', {}, name), E('div', {}, parts)];
				})));
			}

			const lists = Object.keys(s.lists || {});
			if (lists.length) {
				const failed = lists.filter((l) => s.lists[l].error);
				const oldest = Math.min(...lists.map((l) => s.lists[l].updated || 0));
				out.push(E('p', { style: 'margin-top:1em' }, [
					`Lists: ${lists.length}, oldest updated ${ago(oldest)} ago.`,
					failed.length ? E('span', { style: 'color:#d33' }, [ ` Failed to update: ${failed.join(', ')}.` ]) : '',
				]));
			}

			out.push(E('p', { style: 'opacity:.6;font-size:90%' }, `Checked ${ago(s.updated)} ago.`));
		}

		out.push(E('div', { class: 'cbi-page-actions', style: 'text-align:left' }, st.running ? [
			E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, 'handleService', 'restart') }, 'Restart'), ' ',
			E('button', { class: 'btn cbi-button cbi-button-negative', click: ui.createHandlerFn(this, 'handleService', 'stop') }, 'Stop'),
		] : [
			E('button', { class: 'btn cbi-button cbi-button-positive', click: ui.createHandlerFn(this, 'handleService', 'start') }, 'Start'),
		]));

		return out;
	},

	refreshStatus() {
		return callStatus().then((st) => dom.content(this.statusNode, this.renderStatus(st)));
	},

	render([ conf, st ]) {
		if (!document.getElementById('proxyrules-css'))
			document.head.appendChild(E('style', { id: 'proxyrules-css' }, [ CSS ]));

		this.savedText = conf.content || '';
		this.items = parseDoc(this.savedText);
		this.tab = 'rules';
		this.errors = new Map();     // элемент -> сообщения последней проверки
		this.editing = null;         // элемент, открытый в редакторе
		this.editorNode = null;
		this.pending = null;         // { apply() -> bool, cancel() } открытого редактора

		this.statusNode = E('div', {}, this.renderStatus(st));
		poll.add(() => this.refreshStatus(), 5);

		this.textarea = E('textarea', {
			class: 'cbi-input-textarea',
			style: 'width:100%;min-height:40em;font-family:monospace;font-size:12px;white-space:pre;overflow-wrap:normal;overflow-x:auto;tab-size:4',
			spellcheck: 'false',
			wrap: 'off',
			input: () => this.updateDirty(),
		}, [ this.savedText ]);

		this.listsDatalist = E('datalist', { id: 'proxyrules-lists' }, LISTS.map((l) => E('option', { value: l })));
		this.filterInput = E('input', {
			class: 'cbi-input-text pr-filter', type: 'search', placeholder: 'Filter rules…',
			input: () => this.renderRuleList(),
		});
		this.ruleList = E('div', { class: 'pr-list pr-rules' });

		this.tabsNode = E('ul', { class: 'cbi-tabmenu pr-tabs' });
		this.body = E('div');
		this.result = E('div');
		this.dirtyNode = E('span', { class: 'pr-dirty' });
		this.revertBtn = E('button', { class: 'btn cbi-button cbi-button-reset', click: ui.createHandlerFn(this, 'handleRevert') }, 'Revert');

		window.addEventListener('beforeunload', (ev) => {
			if (this.isDirty()) { ev.preventDefault(); ev.returnValue = ''; }
		});

		this.renderAll();

		return E('div', {
			keydown: (ev) => {
				if ((ev.ctrlKey || ev.metaKey) && ev.key == 's') {
					ev.preventDefault();
					this.handleCheck();
				}
			},
		}, [
			E('h2', 'Proxy Rules'),
			E('div', { class: 'cbi-section' }, [
				E('h3', 'Status'),
				this.statusNode,
			]),
			E('div', { class: 'cbi-section' }, [
				this.tabsNode,
				this.body,
				this.result,
				E('div', { class: 'cbi-page-actions', style: 'display:flex;flex-wrap:wrap;gap:.4em;align-items:center;justify-content:flex-end' }, [
					this.dirtyNode,
					this.revertBtn,
					E('button', { class: 'btn cbi-button', title: 'Ctrl+S', click: ui.createHandlerFn(this, 'handleCheck') }, 'Check'),
					E('button', { class: 'btn cbi-button cbi-button-apply', click: ui.createHandlerFn(this, 'handleApply') }, 'Save & Apply'),
				]),
			]),
		]);
	},

	// ─────────────────────────────────────────── общее

	getText() {
		return this.tab == 'text' ? this.textarea.value : serialize(this.items);
	},

	setText(text) {
		this.items = parseDoc(text);
		this.textarea.value = text;
		this.errors.clear();
		this.editing = this.editorNode = this.pending = null;
	},

	isDirty() {
		return this.getText() != this.savedText;
	},

	updateDirty() {
		const d = this.isDirty();
		dom.content(this.dirtyNode, d ? '● Unsaved changes' : '');
		this.revertBtn.disabled = !d;
	},

	errCount(kinds) {
		let n = 0;
		this.errors.forEach((msgs, it) => { if (kinds[it.kind]) n += msgs.length; });
		return n;
	},

	renderAll() {
		const count = (k) => this.items.filter((it) => it.kind == k).length;
		const tabs = [
			[ 'rules', `Rules (${count('rule')})`, { rule: true, raw: true, note: true } ],
			[ 'conns', `Connections (${count('conn')}) & chains (${count('chain')})`, { conn: true, chain: true } ],
			[ 'settings', 'Settings', { setting: true } ],
			[ 'text', 'Text file', {} ],
		];
		dom.content(this.tabsNode, tabs.map(([ id, label, kinds ]) => {
			const n = this.errCount(kinds);
			return E('li', { class: id == this.tab ? 'cbi-tab' : 'cbi-tab-disabled' },
				E('a', { href: '#', click: (ev) => { ev.preventDefault(); this.switchTab(id); } },
					[ label, n ? E('span', { style: 'color:#d33' }, [ ` ⚠ ${n}` ]) : '' ]));
		}));

		if (this.tab == 'rules') {
			dom.content(this.body, this.renderRulesTab());
			this.renderRuleList();
		}
		else if (this.tab == 'conns') dom.content(this.body, this.renderConnsTab());
		else if (this.tab == 'settings') dom.content(this.body, this.renderSettingsTab());
		else dom.content(this.body, [
			E('p', { class: 'cbi-section-descr' }, 'File /etc/proxyrules.conf as is. The syntax is described at its top. Ctrl+S — check without saving.'),
			this.textarea,
		]);
		this.updateDirty();
	},

	switchTab(tab) {
		if (tab == this.tab) return;
		if (!this.closeEditor(true)) return;
		if (this.tab == 'text') {
			// Текст мог быть изменён руками — модель строится заново
			if (this.textarea.value != serialize(this.items)) {
				this.items = parseDoc(this.textarea.value);
				this.errors.clear();
			}
		}
		else if (tab == 'text')
			this.textarea.value = serialize(this.items);
		this.tab = tab;
		dom.content(this.result, []);
		this.renderAll();
	},

	// Изменение модели: сначала закрыть открытый редактор (с сохранением), потом fn
	act(fn) {
		if (!this.closeEditor(true)) return;
		fn();
		this.renderAll();
		if (this.flash) this.reveal(this.rowEls && this.rowEls.get(this.flash));
	},

	edit(it) {
		if (it == this.editing) return;
		const top = this.rowTop(it);
		if (!this.closeEditor(true)) return;
		this.editing = it;
		this.renderAll();
		// Закрытый выше редактор сдвигает список — редактор встаёт на место строки;
		// прокрутка — только если он не виден целиком
		this.keepAt(it, top);
		this.reveal(this.editorNode);
		const f = this.editorNode && this.editorNode.querySelector('input, textarea, select');
		if (f) f.focus({ preventScroll: true });
	},

	rowTop(it) {
		const el = this.rowEls && this.rowEls.get(it);
		// верх места под строку вместе с внешним отступом — у редактора он есть, у строки нет
		return el && el.isConnected ? el.getBoundingClientRect().top - (parseFloat(getComputedStyle(el).marginTop) || 0) : null;
	},

	// Что прокручивается: в некоторых темах LuCI это не окно, а контейнер страницы
	scroller() {
		for (let el = this.ruleList.parentElement; el && el != document.body; el = el.parentElement) {
			const oy = getComputedStyle(el).overflowY;
			if ((oy == 'auto' || oy == 'scroll') && el.scrollHeight > el.clientHeight) return el;
		}
		return document.scrollingElement || document.documentElement;
	},

	// Видимая область с учётом закреплённой шапки темы
	viewport(sc) {
		let top = 0, bottom = window.innerHeight;
		if (sc != document.scrollingElement && sc != document.documentElement) {
			const r = sc.getBoundingClientRect();
			top = Math.max(top, r.top);
			bottom = Math.min(bottom, r.bottom);
		}
		const hdr = document.querySelector('header');
		if (hdr && /fixed|sticky/.test(getComputedStyle(hdr).position)) {
			const r = hdr.getBoundingClientRect();
			if (r.top <= top + 1 && r.bottom > top) top = r.bottom;
		}
		return { top, bottom };
	},

	keepAt(it, top) {
		const now = this.rowTop(it);
		if (top != null && now != null && Math.abs(now - top) > 1) this.scroller().scrollBy(0, now - top);
	},

	// Прокрутить минимально, чтобы el был виден целиком (если выше экрана — важнее верх)
	reveal(el) {
		if (!el || !el.isConnected) return;
		const sc = this.scroller(), v = this.viewport(sc), r = el.getBoundingClientRect(), m = 8;
		let d = 0;
		if (r.bottom > v.bottom - m) d = r.bottom - v.bottom + m;
		if (r.top - d < v.top + m) d = r.top - v.top - m;
		if (Math.abs(d) > 1) sc.scrollBy(0, d);
	},

	closeEditor(save) {
		if (!this.editing) return true;
		if (save ? !this.pending.apply() : (this.pending.cancel(), false)) return false;
		this.editing = this.editorNode = this.pending = null;
		return true;
	},

	finishEdit(save) {
		const it = this.editing, top = this.rowTop(it);
		if (!this.closeEditor(save)) return;
		if (save && this.items.includes(it)) this.flash = it;
		this.renderAll();
		this.keepAt(it, top);
	},

	editorButtons(err) {
		return E('div', { class: 'pr-line' }, [
			E('button', { class: 'btn cbi-button cbi-button-positive', click: (ev) => { ev.preventDefault(); this.finishEdit(true); } }, 'Done'),
			E('button', { class: 'btn cbi-button', click: (ev) => { ev.preventDefault(); this.finishEdit(false); } }, 'Cancel'),
			err,
		]);
	},

	// Enter — готово, Esc — отмена
	editorKeys(ev) {
		if (ev.key == 'Escape') { ev.preventDefault(); this.finishEdit(false); }
		else if (ev.key == 'Enter' && (ev.target.tagName == 'INPUT' || ev.target.tagName == 'SELECT')) { ev.preventDefault(); this.finishEdit(true); }
	},

	remove(it) {
		this.act(() => {
			this.items.splice(this.items.indexOf(it), 1);
			this.errors.delete(it);
		});
	},

	// Вставить новый элемент структуры после последнего элемента первого найденного вида
	insertStruct(it, kinds) {
		for (const k of kinds) {
			let i = -1;
			this.items.forEach((x, j) => { if (x.kind == k) i = j; });
			if (i >= 0) { this.items.splice(i + 1, 0, it); return; }
		}
		// ничего такого нет — перед первым элементом-структурой или правилом вместе с его заголовком
		let i = this.items.findIndex((x) => STRUCT[x.kind] || x.kind == 'rule');
		if (i < 0) i = this.items.length;
		while (i > 0 && (this.items[i - 1].kind == 'note' || this.items[i - 1].kind == 'blank')) i--;
		this.items.splice(i, 0, it);
	},

	names() {
		const conns = [], chains = {};
		for (const it of this.items) {
			if (it.kind == 'conn') conns.push(it.name);
			else if (it.kind == 'chain') chains[it.name] = it.members;
		}
		return { conns, chains };
	},

	targetNames() {
		const { conns, chains } = this.names();
		return [ ...Object.keys(chains), ...conns, 'direct', 'block' ];
	},

	targetChip(target) {
		const { conns, chains } = this.names();
		let cls = 'pr-t-unknown', label = target, title = 'Unknown connection or chain';
		if (target == 'direct') { cls = ''; title = 'Direct, no proxy'; }
		else if (target == 'block') { cls = 'pr-t-block'; title = 'Blocked'; }
		else if (chains[target]) { cls = 'pr-t-chain'; title = 'Chain: ' + chains[target].join(' → '); }
		else if (conns.includes(target)) { cls = 'pr-t-conn'; title = 'Single connection, no fallback'; }
		else if (target.includes(',')) { cls = 'pr-t-chain'; label = target.split(',').join(' → '); title = 'Inline chain'; }
		return T('span', { class: 'pr-target ' + cls, title }, label);
	},

	// Цель правила: список имён + «inline chain…» с полем ввода
	targetPicker(value) {
		const names = this.names();
		const known = this.targetNames();
		const inline = E('input', { class: 'cbi-input-text', type: 'text', placeholder: 'TR, DE, direct', style: 'width:12em' });
		const opt = (v, label) => E('option', { value: v }, [ label || v ]);
		const sel = E('select', { class: 'cbi-input-select', change: () => {
			inline.style.display = sel.value == '*inline' ? '' : 'none';
			if (sel.value == '*inline') inline.focus();
		} }, [
			Object.keys(names.chains).length ? E('optgroup', { label: 'Chains' }, Object.keys(names.chains).map((n) => opt(n, `${n}  (${names.chains[n].join(' → ')})`))) : '',
			names.conns.length ? E('optgroup', { label: 'Connections' }, names.conns.map((n) => opt(n))) : '',
			E('optgroup', { label: 'Other' }, [ opt('direct'), opt('block'), opt('*inline', 'inline chain…') ]),
		].filter((x) => x));

		if (known.includes(value)) sel.value = value;
		else if (value) { sel.value = '*inline'; inline.value = value.split(',').join(', '); }
		else sel.value = known.includes('AUTO') ? 'AUTO' : known[0];
		inline.style.display = sel.value == '*inline' ? '' : 'none';

		return {
			nodes: [ sel, inline ],
			value: () => sel.value == '*inline' ? splitNames(inline.value).join(',') : sel.value,
		};
	},

	// ─────────────────────────────────────────── правила

	ruleRegionStart() {
		const first = this.items.findIndex((x) => x.kind == 'rule');
		const upto = first < 0 ? this.items.length : first;
		let start = 0;
		for (let i = 0; i < upto; i++) if (STRUCT[this.items[i].kind]) start = i + 1;
		return start;
	},

	renderRulesTab() {
		return [
			this.listsDatalist,
			E('div', { class: 'pr-toolbar' }, [
				this.filterInput,
				E('span', { style: 'opacity:.65;font-size:90%;flex:1' }, 'Checked top to bottom, the first match wins. Drag ⋮⋮ or use ↑ ↓ to reorder; double-click a rule to edit.'),
				btn('+ Rule', 'Add a rule after the last one', () => this.addRule(), 'cbi-button-add'),
				btn('+ Group', 'Add a heading for a group of rules', () => this.addGroup(), ''),
			]),
			this.ruleList,
		];
	},

	matches(it, q) {
		if (it.kind == 'rule')
			return (condsText(it.conds) + ' ' + it.target + ' ' + it.comment).toLowerCase().includes(q);
		return it.lines.join('\n').toLowerCase().includes(q);
	},

	renderRuleList() {
		const q = this.filterInput.value.trim().toLowerCase();
		const rows = [
			E('div', { class: 'pr-row pr-head' }, [ E('span'), E('span', 'Condition'), E('span', 'Target'), E('span', 'Comment'), E('span') ]),
		];
		this.rowEls = new Map();
		for (let i = this.ruleRegionStart(); i < this.items.length; i++) {
			const it = this.items[i];
			if (it.kind == 'blank') continue;
			if (it == this.editing) {
				rows.push(this.editorNode = this.editorNode || (it.kind == 'note' ? this.noteEditor(it) : it.kind == 'rule' ? this.ruleEditor(it) : this.rawEditor(it)));
				this.rowEls.set(it, this.editorNode);
				continue;
			}
			if (q && !this.matches(it, q)) continue;
			rows.push(it.kind == 'note' ? this.noteRow(it) : this.ruleRow(it));
			this.rowEls.set(it, rows[rows.length - 1]);
		}
		if (rows.length == 1)
			rows.push(E('div', { class: 'pr-empty' }, q ? 'Nothing matches the filter.' : 'No rules yet — add one above.'));
		dom.content(this.ruleList, rows);
		if (this.ruleList.querySelector('.pr-flash')) this.clearFlash();
	},

	// Подсветка держится, пока идёт анимация, — переживает перерисовку после проверки
	clearFlash() {
		const f = this.flash;
		if (f) setTimeout(() => { if (this.flash === f) this.flash = null; }, 2500);
	},

	errorsOf(it, row) {
		const msgs = this.errors.get(it);
		if (!msgs) return;
		row.classList.add('pr-has-error');
		row.appendChild(T('div', { class: 'pr-errmsg' }, msgs.join('\n')));
	},

	ruleRow(it) {
		let main;
		if (it.kind == 'rule') {
			const conds = [];
			it.conds.forEach((c, i) => {
				if (i) conds.push(E('span', { class: 'pr-and' }, 'and'));
				conds.push(E('span', { class: 'pr-cond' + (c.neg ? ' pr-neg' : ''), title: c.neg ? 'Everything except' : '' }, [
					T('span', { class: 'pr-tag pr-tag-' + c.type }, (c.neg ? 'not ' : '') + c.type),
					c.values.join(', '),
				]));
			});
			main = [
				E('div', { class: 'pr-c-conds' }, conds),
				E('div', { class: 'pr-c-target' }, [ this.targetChip(it.target) ]),
				E('div', { class: 'pr-c-comment pr-comment' }, it.comment ? [ it.comment ] : []),
			];
		}
		else {
			// нераспознанная строка или соединение/цепочка посреди правил
			const struct = STRUCT[it.kind];
			main = [
				T('div', { class: 'pr-c-conds pr-c-wide pr-mono', title: struct ? 'Edit it on the Connections tab' : 'Not recognized as a rule' },
					it.lines.join('\n')),
			];
		}

		const row = E('div', { class: 'pr-row' + (it == this.flash ? ' pr-flash' : ''), dblclick: (ev) => ev.target.closest('button') || STRUCT[it.kind] || this.edit(it) }, [
			STRUCT[it.kind] ? E('span') : E('span', { class: 'pr-handle', title: 'Drag to move', mousedown: () => row.draggable = true, mouseup: () => row.draggable = false }, [ '⋮⋮' ]),
			...main,
			E('div', { class: 'pr-c-actions pr-actions' }, STRUCT[it.kind] ? [] : [
				btn('↑', 'Move up', () => this.step(it, -1)),
				btn('↓', 'Move down', () => this.step(it, 1)),
				btn('✎', 'Edit', () => this.edit(it)),
				btn('⧉', 'Duplicate', () => this.duplicate(it)),
				btn('✕', 'Delete', () => this.remove(it), 'pr-icon cbi-button-negative'),
			]),
		]);
		this.errorsOf(it, row);
		if (!STRUCT[it.kind]) this.dragSource(row, it);
		this.dropTarget(row, it);
		return row;
	},

	noteRow(it) {
		// Рамки вида «── Rules ────» при показе убираются
		const lines = noteText(it).split('\n').map((l) => l.replace(/^[─═━\-=\s]+|[─═━\-=\s]+$/g, '')).filter((l) => l != '');
		const row = E('div', { class: 'pr-row pr-note', dblclick: (ev) => ev.target.closest('button') || this.edit(it) }, [
			E('div', { class: 'pr-note-text' }, lines.length
				? [ lines[0], ...lines.slice(1).map((l) => T('div', { class: 'pr-sub' }, l)) ]
				: [ E('span', { class: 'pr-sub' }, '(separator)') ]),
			E('div', { class: 'pr-actions' }, [
				btn('+', 'Add a rule to this group', () => this.addRuleToGroup(it)),
				btn('✎', 'Edit heading', () => this.edit(it)),
				btn('✕', 'Delete heading (rules stay)', () => this.remove(it), 'pr-icon cbi-button-negative'),
			]),
		]);
		this.dropTarget(row, it);
		return row;
	},

	dragSource(row, it) {
		row.addEventListener('dragstart', (ev) => {
			this.dragItem = it;
			ev.dataTransfer.effectAllowed = 'move';
			ev.dataTransfer.setData('text/plain', '');
			row.classList.add('pr-dragging');
		});
		row.addEventListener('dragend', () => {
			row.draggable = false;
			row.classList.remove('pr-dragging');
			this.dragItem = null;
			this.ruleList.querySelectorAll('.pr-drop-before, .pr-drop-after').forEach((r) => r.classList.remove('pr-drop-before', 'pr-drop-after'));
		});
	},

	dropTarget(row, it) {
		const clear = () => row.classList.remove('pr-drop-before', 'pr-drop-after');
		row.addEventListener('dragover', (ev) => {
			if (!this.dragItem || this.dragItem == it) return;
			ev.preventDefault();
			const r = row.getBoundingClientRect();
			row.dataset.where = ev.clientY < r.top + r.height / 2 ? 'before' : 'after';
			row.classList.toggle('pr-drop-before', row.dataset.where == 'before');
			row.classList.toggle('pr-drop-after', row.dataset.where == 'after');
		});
		row.addEventListener('dragleave', clear);
		row.addEventListener('drop', (ev) => {
			ev.preventDefault();
			clear();
			const src = this.dragItem;
			if (src && src != it) this.act(() => { this.moveTo(src, it, row.dataset.where); this.flash = src; });
		});
	},

	// Перед заголовком группы — значит в конец предыдущей группы (до пустых строк над заголовком)
	moveTo(it, ref, where) {
		this.items.splice(this.items.indexOf(it), 1);
		let i = this.items.indexOf(ref);
		if (where == 'after') i++;
		else if (ref.kind == 'note')
			while (i > 0 && this.items[i - 1].kind == 'blank') i--;
		this.items.splice(i, 0, it);
	},

	// На одну позицию; через заголовок группы — в соседнюю группу
	step(it, dir) {
		const start = this.ruleRegionStart();
		let j = this.items.indexOf(it) + dir;
		while (j >= start && j < this.items.length && this.items[j].kind == 'blank') j += dir;
		if (j < start || j >= this.items.length) return;
		const ref = this.items[j];
		this.act(() => { this.moveTo(it, ref, dir < 0 ? 'before' : 'after'); this.flash = it; });
	},

	duplicate(it) {
		this.act(() => {
			const copy = it.kind == 'rule'
				? Object.assign({}, it, { conds: it.conds.map((c) => Object.assign({}, c, { values: c.values.slice() })), dirty: true })
				: Object.assign({}, it, { lines: it.lines.slice() });
			this.items.splice(this.items.indexOf(it) + 1, 0, copy);
			this.flash = copy;
		});
	},

	newRule(target) {
		return { kind: 'rule', lines: [], conds: [ { neg: false, type: 'domain', values: [] } ], target: target || '', comment: '', dirty: true, isNew: true };
	},

	addRuleToGroup(note) {
		if (!this.closeEditor(true)) return;
		let i = this.items.indexOf(note), at = i + 1;
		for (let j = i + 1; j < this.items.length && this.items[j].kind != 'note'; j++)
			if (this.items[j].kind == 'rule') at = j + 1;
		const prev = this.items[at - 1];
		const it = this.newRule(prev && prev.kind == 'rule' ? prev.target : '');
		this.items.splice(at, 0, it);
		this.edit(it);
	},

	addGroup() {
		if (!this.closeEditor(true)) return;
		let at = this.items.length;
		while (at > 0 && this.items[at - 1].kind == 'blank') at--;
		const it = { kind: 'note', lines: [], text: '', dirty: true, isNew: true };
		this.items.splice(at, 0, { kind: 'blank', lines: [ '' ] }, it);
		this.edit(it);
	},

	ruleEditor(it) {
		const draft = it.conds.map((c) => ({ neg: c.neg, type: c.type, raw: c.values.join(', ') }));
		const box = E('div');
		const err = E('span', { class: 'pr-err' });

		const renderConds = () => dom.content(box, draft.map((c, i) => {
			const val = E('input', {
				class: 'cbi-input-text pr-grow', type: 'text', value: c.raw, placeholder: PLACEHOLDERS[c.type],
				list: c.type == 'list' ? 'proxyrules-lists' : null,
				input: () => c.raw = val.value,
			});
			return E('div', { class: 'pr-line' }, [
				E('span', { class: 'pr-label' }, i ? 'and' : 'If'),
				E('select', { class: 'cbi-input-select', change: (ev) => { c.type = ev.target.value; renderConds(); } },
					RULE_TYPES.map((t) => E('option', { value: t, selected: t == c.type ? '' : null }, [ t ]))),
				E('select', { class: 'cbi-input-select', change: (ev) => c.neg = ev.target.value == '1' }, [
					E('option', { value: '0' }, 'is'),
					E('option', { value: '1', selected: c.neg ? '' : null }, 'is not'),
				]),
				val,
				draft.length > 1 ? btn('✕', 'Remove condition', () => { draft.splice(i, 1); renderConds(); }, 'pr-icon cbi-button-negative') : '',
			]);
		}));
		renderConds();

		const target = this.targetPicker(it.target);
		const comment = E('input', { class: 'cbi-input-text pr-grow', type: 'text', value: it.comment, placeholder: 'optional' });

		this.pending = {
			apply: () => {
				const conds = [];
				for (const c of draft) {
					const values = normalizeValues(c.type, c.raw);
					if (!values.length) continue;
					// одинаковые условия gen.uc не принимает — объединяем
					const same = conds.find((x) => x.type == c.type && x.neg == c.neg);
					if (same) same.values.push(...values.filter((v) => !same.values.includes(v)));
					else conds.push({ neg: c.neg, type: c.type, values });
				}
				const t = target.value();
				if (!conds.length) { dom.content(err, 'Enter at least one value.'); return false; }
				if (!t) { dom.content(err, 'Choose a target.'); return false; }
				Object.assign(it, { conds, target: t, comment: comment.value.replace(/\s+/g, ' ').trim(), dirty: true, isNew: false });
				this.errors.delete(it);
				return true;
			},
			cancel: () => { if (it.isNew) this.items.splice(this.items.indexOf(it), 1); },
		};

		return E('div', { class: 'pr-edit', keydown: (ev) => this.editorKeys(ev) }, [
			box,
			E('div', { class: 'pr-line' }, [
				E('span', { class: 'pr-label' }),
				btn('+ and', 'Add a condition that must also match', () => { draft.push({ neg: false, type: 'src', raw: '' }); renderConds(); }, ''),
				E('span', { style: 'opacity:.6;font-size:90%' }, 'Several values in one field — separated by commas, any of them matches.'),
			]),
			E('div', { class: 'pr-line' }, [ E('span', { class: 'pr-label' }, 'Go via'), ...target.nodes ]),
			E('div', { class: 'pr-line' }, [ E('span', { class: 'pr-label' }, 'Comment'), comment ]),
			this.editorButtons(err),
		]);
	},

	// Заголовок правится прямо в строке таблицы и применяется при каждом вводе; Esc — вернуть как было
	noteEditor(it) {
		const orig = { text: it.text, dirty: it.dirty };
		const start = it.text != null ? it.text : noteText(it);
		const fit = () => text.rows = Math.max(1, text.value.split('\n').length);
		const text = E('textarea', {
			class: 'cbi-input-textarea pr-note-input', spellcheck: 'false', placeholder: 'Group heading',
			title: 'Enter — done, Shift+Enter — new line, Esc — undo',
			input: () => {
				fit();
				const t = text.value.replace(/\s+$/, '');
				Object.assign(it, t == start && !orig.dirty ? { text: orig.text, dirty: false } : { text: t, dirty: true });
				this.updateDirty();
			},
			keydown: (ev) => {
				if (ev.key == 'Escape') { ev.preventDefault(); this.finishEdit(false); }
				else if (ev.key == 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.finishEdit(true); }
			},
		}, [ start ]);
		fit();
		this.pending = {
			apply: () => {
				if (text.value.trim() == '') this.items.splice(this.items.indexOf(it), 1);
				it.isNew = false;
				return true;
			},
			cancel: () => {
				if (it.isNew) this.items.splice(this.items.indexOf(it), 1);
				else Object.assign(it, orig);
			},
		};
		return E('div', { class: 'pr-row pr-note' }, [
			text,
			E('div', { class: 'pr-actions', style: 'opacity:1' }, [
				btn('✓', 'Done (Enter)', () => this.finishEdit(true)),
				btn('↶', 'Undo changes (Esc)', () => this.finishEdit(false)),
			]),
		]);
	},

	rawEditor(it) {
		const input = E('input', { class: 'cbi-input-text', type: 'text', value: it.lines.join(''), style: 'width:100%;font-family:monospace' });
		this.pending = {
			apply: () => {
				const idx = this.items.indexOf(it);
				const repl = parseLine(input.value);
				if (repl.kind == 'note' || repl.kind == 'blank') repl.text = noteText(repl);
				this.items[idx] = repl;
				this.errors.delete(it);
				return true;
			},
			cancel: () => {},
		};
		return E('div', { class: 'pr-edit', keydown: (ev) => this.editorKeys(ev) }, [
			E('div', { style: 'opacity:.7;margin-bottom:.3em' }, 'This line is not recognized as a rule — edit it as text:'),
			input,
			this.editorButtons(),
		]);
	},

	// Новое правило — после последнего (в самом конце файла могут быть комментарии)
	addRule() {
		if (!this.closeEditor(true)) return;
		const rules = this.items.map((x, i) => x.kind == 'rule' ? i : -1).filter((i) => i >= 0);
		let at = rules.length ? rules[rules.length - 1] + 1 : this.items.length;
		if (!rules.length) while (at > 0 && this.items[at - 1].kind == 'blank') at--;
		const prev = this.items[at - 1];
		const it = this.newRule(prev && prev.kind == 'rule' ? prev.target : '');
		this.items.splice(at, 0, it);
		this.filterInput.value = '';
		this.edit(it);
	},

	// ─────────────────────────────────────────── соединения и цепочки

	usedBy(name) {
		const out = [];
		let rules = 0;
		for (const it of this.items) {
			if (it.kind == 'rule' && it.target.split(',').includes(name)) rules++;
			else if (it.kind == 'chain' && it.members.includes(name)) out.push('chain ' + it.name);
			else if (it.kind == 'setting' && it.name == 'lists_via' && splitNames(it.value).includes(name)) out.push('@lists_via');
		}
		if (rules) out.unshift(rules + (rules == 1 ? ' rule' : ' rules'));
		return out;
	},

	// Переименование — вместе со всеми ссылками на имя
	rename(from, to) {
		const sub = (list) => list.map((n) => n == from ? to : n);
		for (const it of this.items) {
			if (it.kind == 'rule' && it.target.split(',').includes(from)) { it.target = sub(it.target.split(',')).join(','); it.dirty = true; }
			else if (it.kind == 'chain' && it.members.includes(from)) { it.members = sub(it.members); it.dirty = true; }
			else if (it.kind == 'setting' && it.name == 'lists_via' && splitNames(it.value).includes(from)) { it.value = sub(splitNames(it.value)).join(','); it.dirty = true; }
		}
	},

	checkName(it, name) {
		if (!NAME_RE.test(name)) return 'Name: Latin letters, digits and "-", up to 32 characters.';
		if (name == 'direct' || name == 'block') return `"${name}" is reserved.`;
		if (this.items.some((x) => x != it && (x.kind == 'conn' || x.kind == 'chain') && x.name == name)) return `"${name}" is already used.`;
		return null;
	},

	confirmRemove(it) {
		const used = this.usedBy(it.name);
		if (used.length && !confirm(`${it.name} is used by: ${used.join(', ')}.\nThe file won't pass the check until those are changed. Delete anyway?`))
			return;
		this.remove(it);
	},

	renderConnsTab() {
		const conns = this.items.filter((it) => it.kind == 'conn');
		const chains = this.items.filter((it) => it.kind == 'chain');
		const row = (it, cells) => {
			if (it == this.editing)
				return this.editorNode = this.editorNode || (it.kind == 'conn' ? this.connEditor(it) : this.chainEditor(it));
			const used = this.usedBy(it.name);
			const r = E('div', { class: 'pr-row' + (it == this.flash ? ' pr-flash' : ''), dblclick: (ev) => ev.target.closest('button') || this.edit(it) }, [
				T('strong', {}, it.name),
				cells,
				T('div', { class: 'pr-comment' }, used.length ? 'used by ' + used.join(', ') : 'not used'),
				E('div', { class: 'pr-c-actions pr-actions' }, [
					btn('✎', 'Edit', () => this.edit(it)),
					btn('✕', 'Delete', () => this.confirmRemove(it), 'pr-icon cbi-button-negative'),
				]),
			]);
			this.errorsOf(it, r);
			return r;
		};
		this.clearFlash();

		return [
			E('h3', 'Connections'),
			E('p', { class: 'cbi-section-descr' }, 'A vless:// link as the server gave it, or an OpenWrt interface (AmneziaWG, WireGuard…).'),
			E('div', { class: 'pr-list pr-conns' }, [
				...conns.map((it) => row(it, E('div', { class: 'pr-mono', title: 'Double-click to see the full link' }, [
					linkSummary(it.link), it.comment ? T('span', { class: 'pr-comment' }, '  # ' + it.comment) : '',
				]))),
				conns.length ? '' : E('div', { class: 'pr-empty' }, 'No connections yet.'),
			].filter((x) => x)),
			btn('+ Connection', 'Add a connection', () => this.addStruct({ kind: 'conn', name: '', link: '', comment: '' }, [ 'conn', 'setting' ]), 'cbi-button-add'),

			E('h3', { style: 'margin-top:2em' }, 'Chains'),
			E('p', { class: 'cbi-section-descr' }, 'The first live connection in order is used; when a higher-priority one comes back, traffic switches back to it. A chain holds only connections and direct.'),
			E('div', { class: 'pr-list pr-conns' }, [
				...chains.map((it) => row(it, E('div', {}, [
					it.members.join(' → '), it.comment ? T('span', { class: 'pr-comment' }, '  # ' + it.comment) : '',
				]))),
				chains.length ? '' : E('div', { class: 'pr-empty' }, 'No chains yet.'),
			].filter((x) => x)),
			btn('+ Chain', 'Add a chain', () => this.addStruct({ kind: 'chain', name: '', members: [], comment: '' }, [ 'chain', 'conn', 'setting' ]), 'cbi-button-add'),
		];
	},

	addStruct(it, kinds) {
		if (!this.closeEditor(true)) return;
		Object.assign(it, { lines: [], dirty: true, isNew: true });
		this.insertStruct(it, kinds);
		this.edit(it);
	},

	structPending(it, err, collect) {
		this.pending = {
			apply: () => {
				const v = collect();
				if (typeof v == 'string') { dom.content(err, v); return false; }
				if (!it.isNew && it.name != v.name) this.rename(it.name, v.name);
				Object.assign(it, v, { dirty: true, isNew: false });
				this.errors.delete(it);
				return true;
			},
			cancel: () => { if (it.isNew) this.items.splice(this.items.indexOf(it), 1); },
		};
	},

	connEditor(it) {
		const err = E('span', { class: 'pr-err' });
		const name = E('input', { class: 'cbi-input-text', type: 'text', value: it.name, placeholder: 'DE', style: 'width:10em' });
		const link = E('textarea', { class: 'cbi-input-textarea pr-grow', rows: 3, spellcheck: 'false', placeholder: 'vless://…  or  iface:awg0',
			style: 'font-family:monospace;font-size:90%;word-break:break-all' }, [ it.link ]);
		const comment = E('input', { class: 'cbi-input-text pr-grow', type: 'text', value: it.comment, placeholder: 'optional' });
		this.structPending(it, err, () => {
			const n = name.value.trim(), l = link.value.replace(/\s+/g, '');
			const bad = this.checkName(it, n);
			if (bad) return bad;
			if (!/^(vless:\/\/|iface:)./.test(l)) return 'The link must start with vless:// or iface:';
			return { name: n, link: l, comment: comment.value.replace(/\s+/g, ' ').trim() };
		});
		return E('div', { class: 'pr-edit', keydown: (ev) => this.editorKeys(ev) }, [
			E('div', { class: 'pr-line' }, [ E('span', { class: 'pr-label' }, 'Name'), name,
				it.isNew ? '' : E('span', { style: 'opacity:.6;font-size:90%' }, 'renaming updates rules and chains that use it') ]),
			E('div', { class: 'pr-line' }, [ E('span', { class: 'pr-label' }, 'Link'), link ]),
			E('div', { class: 'pr-line' }, [ E('span', { class: 'pr-label' }, 'Comment'), comment ]),
			this.editorButtons(err),
		]);
	},

	chainEditor(it) {
		const err = E('span', { class: 'pr-err' });
		const members = it.members.slice();
		const name = E('input', { class: 'cbi-input-text', type: 'text', value: it.name, placeholder: 'AUTO', style: 'width:10em' });
		const comment = E('input', { class: 'cbi-input-text pr-grow', type: 'text', value: it.comment, placeholder: 'optional' });
		const box = E('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:.2em' });
		const renderMembers = () => {
			const avail = [ ...this.names().conns, 'direct' ].filter((n) => !members.includes(n));
			const add = E('select', { class: 'cbi-input-select', change: () => {
				if (add.value) { members.push(add.value); renderMembers(); }
			} }, [ E('option', { value: '' }, '+ add…'), ...avail.map((n) => E('option', { value: n }, [ n ])) ]);
			const move = (i, d) => { members.splice(i + d, 0, members.splice(i, 1)[0]); renderMembers(); };
			dom.content(box, [
				...members.flatMap((m, i) => [
					i ? E('span', { style: 'opacity:.5' }, '→') : '',
					E('span', { class: 'pr-chip' }, [
						T('strong', {}, m),
						i ? btn('‹', 'Earlier', () => move(i, -1)) : '',
						i < members.length - 1 ? btn('›', 'Later', () => move(i, 1)) : '',
						btn('✕', 'Remove', () => { members.splice(i, 1); renderMembers(); }),
					].filter((x) => x)),
				]).filter((x) => x),
				avail.length ? add : '',
			].filter((x) => x));
		};
		renderMembers();
		this.structPending(it, err, () => {
			const n = name.value.trim();
			const bad = this.checkName(it, n);
			if (bad) return bad;
			if (!members.length) return 'Add at least one connection.';
			return { name: n, members: members.slice(), comment: comment.value.replace(/\s+/g, ' ').trim() };
		});
		return E('div', { class: 'pr-edit', keydown: (ev) => this.editorKeys(ev) }, [
			E('div', { class: 'pr-line' }, [ E('span', { class: 'pr-label' }, 'Name'), name,
				it.isNew ? '' : E('span', { style: 'opacity:.6;font-size:90%' }, 'renaming updates rules that use it') ]),
			E('div', { class: 'pr-line' }, [ E('span', { class: 'pr-label' }, 'Order'), box ]),
			E('div', { class: 'pr-line' }, [ E('span', { class: 'pr-label' }, 'Comment'), comment ]),
			this.editorButtons(err),
		]);
	},

	// ─────────────────────────────────────────── настройки

	setSetting(name, value) {
		const it = this.items.find((x) => x.kind == 'setting' && x.name == name);
		value = value.trim();
		if (it && value == '') this.items.splice(this.items.indexOf(it), 1);  // пусто — значение по умолчанию
		else if (it) Object.assign(it, { value, dirty: true });
		else if (value != '') this.insertStruct({ kind: 'setting', name, value, comment: '', lines: [], dirty: true }, [ 'setting' ]);
		if (it) this.errors.delete(it);
		this.updateDirty();
	},

	renderSettingsTab() {
		return [
			E('p', { class: 'cbi-section-descr' }, 'Fine to leave as is. An empty field means the default value.'),
			...SETTINGS.map((s) => {
				const it = this.items.find((x) => x.kind == 'setting' && x.name == s.name);
				const cur = it ? it.value : '';
				let field;
				if (s.options || s.target) {
					const opts = s.options || this.targetNames().filter((n) => n != 'block');
					field = E('select', { class: 'cbi-input-select', change: (ev) => this.setSetting(s.name, ev.target.value) }, [
						E('option', { value: '' }, [ `default (${s.def})` ]),
						...opts.map((o) => E('option', { value: o, selected: o == cur ? '' : null }, [ o ])),
						cur && !opts.includes(cur) ? E('option', { value: cur, selected: '' }, [ cur ]) : '',
					].filter((x) => x));
				}
				else
					field = E('input', { class: 'cbi-input-text', type: 'text', value: cur, placeholder: s.def,
						change: (ev) => this.setSetting(s.name, ev.target.value) });
				const msgs = it && this.errors.get(it);
				return E('div', { class: 'cbi-value' }, [
					E('label', { class: 'cbi-value-title' }, [ s.title ]),
					E('div', { class: 'cbi-value-field' }, [
						field,
						s.descr || it?.comment ? T('div', { class: 'cbi-value-description' }, s.descr || it.comment) : '',
						msgs ? T('div', { class: 'cbi-value-description', style: 'color:#d33' }, msgs.join('\n')) : '',
					].filter((x) => x)),
				]);
			}),
			// незнакомые gen.uc настройки (опечатка?) — показать, чтобы было что исправить или удалить
			...this.items.filter((it) => it.kind == 'setting' && !SETTINGS.some((s) => s.name == it.name)).map((it) =>
				E('div', { class: 'cbi-value' }, [
					T('label', { class: 'cbi-value-title', style: 'color:#d33' }, '@' + it.name),
					E('div', { class: 'cbi-value-field' }, [
						T('code', {}, it.value), ' ',
						btn('✕', 'Delete this line', () => this.remove(it), 'pr-icon cbi-button-negative'),
						T('div', { class: 'cbi-value-description', style: 'color:#d33' }, (this.errors.get(it) || [ 'Unknown setting' ]).join('\n')),
					]),
				])),
		];
	},

	// ─────────────────────────────────────────── проверка и сохранение

	// «line N: …» из gen.uc → элементы модели, в которых эти строки
	mapErrors(text, errors) {
		this.errors.clear();
		if (this.tab == 'text') {
			const m = (errors || '').match(/^line (\d+):/m);
			if (m) this.selectLine(+m[1]);
			return;
		}
		const spans = [];
		let ln = 1;
		for (const it of this.items) {
			const n = itemLines(it).length;
			spans.push([ ln, ln + n, it ]);
			ln += n;
		}
		for (const line of (errors || '').split('\n')) {
			const m = line.match(/^line (\d+): (.*)$/);
			if (!m) continue;
			const s = spans.find(([ a, b ]) => +m[1] >= a && +m[1] < b);
			if (!s) continue;
			if (!this.errors.has(s[2])) this.errors.set(s[2], []);
			this.errors.get(s[2]).push(m[2]);
		}
	},

	selectLine(n) {
		const lines = this.textarea.value.split('\n');
		const start = lines.slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0);
		this.textarea.focus();
		this.textarea.setSelectionRange(start, start + (lines[n - 1] || '').length);
		const lh = parseFloat(getComputedStyle(this.textarea).lineHeight) || 15;
		this.textarea.scrollTop = Math.max(0, (n - 1) * lh - this.textarea.clientHeight / 2);
	},

	showResult(r, okText) {
		dom.content(this.result, r.ok
			? E('p', { class: 'alert-message success' }, [ okText + (r.summary ? ' (' + r.summary.replace(/^ok: /, '') + ')' : '') ])
			: E('pre', { class: 'alert-message error', style: 'white-space:pre-wrap' }, [ r.errors || 'Unknown error' ]));
	},

	afterCheck(text, r) {
		this.mapErrors(text, r.ok ? '' : r.errors);
		if (this.tab != 'text') this.renderAll();
	},

	handleCheck() {
		if (!this.closeEditor(true)) return Promise.resolve();
		const text = this.getText();
		return callCheck(text).then((r) => {
			this.showResult(r, 'No errors');
			this.afterCheck(text, r);
		});
	},

	handleApply() {
		if (!this.closeEditor(true)) return Promise.resolve();
		const text = this.getText();
		return callSave(text).then((r) => {
			this.showResult(r, r.restarted ? 'Saved and applied' : 'Saved (service is not running)');
			// «saved, but the service did not come up» — файл всё равно записан
			if (r.ok || /^saved,/.test(r.errors || '')) {
				this.savedText = text;
				if (this.tab != 'text') this.items = parseDoc(text);
			}
			this.afterCheck(text, r);
			this.updateDirty();
			return this.refreshStatus();
		});
	},

	handleRevert() {
		if (!confirm('Discard all unsaved changes?')) return;
		this.setText(this.savedText);
		dom.content(this.result, []);
		this.renderAll();
	},

	handleService(action) {
		return callService(action).then((r) => {
			if (!r.ok)
				ui.addNotification(null, E('pre', { style: 'white-space:pre-wrap' }, [ r.errors || 'Failed' ]), 'error');
			return this.refreshStatus();
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
});
