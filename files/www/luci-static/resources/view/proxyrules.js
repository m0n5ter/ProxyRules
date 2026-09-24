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
const callUpdate = rpc.declare({ object: 'proxyrules', method: 'update' });
const callUpgrade = rpc.declare({ object: 'proxyrules', method: 'upgrade', params: [ 'tag' ] });

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

// Same as PROTOCOLS in gen.uc
const PROTOCOLS = [ 'bittorrent', 'tls', 'http', 'quic', 'stun', 'dtls', 'ssh', 'rdp', 'ntp' ];

const PLACEHOLDERS = {
	domain: 'upwork.com, static-upwork.com',
	list: 'discord',
	ip: '203.0.113.0/24',
	src: '192.168.1.15',
	port: '443, 50000-65535',
	protocol: 'bittorrent',
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

// ─────────────────────────────────────────────────────────────── file model
//
// The file is a list of items: blank, note (consecutive comment lines), setting,
// conn, chain, rule, raw (an unrecognized line). Until an item is changed (dirty),
// it is written back as its original lines — the file's formatting and comments
// are kept as they are.

// A comment is as in gen.uc: "#" at the start or after a space
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

// Heading text: from it.text if changed, otherwise from the file's original lines
function noteText(it) {
	if (it.dirty && it.text != null) return it.text;
	return it.lines.map((l) => l.replace(/^\s*#\s?/, '')).join('\n');
}

function withComment(line, comment, col) {
	if (!comment) return line;
	return (line.length < col ? line.padEnd(col) : line + '   ') + '# ' + comment;
}

function condsText(conds) {
	return conds.map((c) => (c.neg ? '!' : '') + c.type + ':' + c.values.join(', ')).join(' & ');
}

// Columns as in proxyrules.conf.example; a rule's "->" goes under the "->" of the rule above (arrow)
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
		// the column is taken only from an aligned rule (one that's too long doesn't set it)
		const body = it.kind == 'rule' ? stripComment(lines[0]) : '';
		if (/\s\s->/.test(body)) arrow = body.lastIndexOf('->');
		return lines;
	}).join('\n');
}

// Values separated by commas/spaces; for domain: only the host is kept from a pasted link
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

// vless:// vless://… → "vless · reality · 1.2.3.4:443" — no secrets
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

// ─────────────────────────────────────────────────────────────── view

function nodeState(n) {
	if (n.up === true) return E('span', { style: 'color:#2a2' }, '● up');
	if (n.up === false) return E('span', { style: 'color:#d33' }, '● not responding');
	return E('span', { style: 'color:#888' }, '○ checking');
}

// User text only as text nodes (a string child in E() goes in as innerHTML)
function T(tag, attrs, text) {
	return E(tag, attrs || {}, [ String(text) ]);
}

function btn(label, title, fn, cls) {
	return E('button', { class: 'btn cbi-button ' + (cls || 'pr-icon'), title: title, click: (ev) => { ev.preventDefault(); fn(); } }, [ label ]);
}

const CSS = `
/* the same gap under the tabs on every tab: the top margin of the first content element is removed */
.pr-tabs { margin-bottom:1em !important }
.pr-body > :first-child, .pr-body > :first-child > :first-child { margin-top:0 !important }
/* button bar: the theme gives its elements float and different margins — here it's flex with equal gaps */
.pr-bar { display:flex !important; flex-wrap:wrap; gap:.5em; align-items:center; justify-content:flex-end; margin-top:1em !important }
/* the gap before the button bar is the same on every tab: only the bar sets it */
.pr-body > :last-child { margin-bottom:0 !important }
.pr-bar > * { float:none !important; margin:0 !important }
.pr-bar > .pr-dirty { margin-right:auto !important }
.pr-hidden { display:none !important }
.pr-toolbar { display:flex; flex-wrap:wrap; gap:.5em; align-items:center; margin:.8em 0 }
.pr-toolbar .pr-filter { flex:0 1 20em; min-width:10em }
.pr-list { margin:.3em 0 1em }
.pr-row { display:grid; gap:.25em .8em; align-items:center; padding:.35em .3em; border-bottom:1px solid rgba(128,128,128,.18) }
.pr-row:hover { background:rgba(128,128,128,.07) }
/* One grid for the whole list, the rows are its parts (subgrid): the columns are shared by all rows,
   Target and Comment size to content, Condition takes the rest */
.pr-rules, .pr-conns { display:grid }
.pr-rules { grid-template-columns:auto minmax(0,1fr) auto auto auto }
.pr-conns { grid-template-columns:auto minmax(0,1fr) auto auto }
.pr-rules > *, .pr-conns > * { grid-column:1 / -1 }
.pr-rules > .pr-row:not(.pr-note), .pr-conns > .pr-row { grid-template-columns:subgrid }
.pr-rules > .pr-row > .pr-c-target { max-width:16em }
.pr-rules > .pr-row > .pr-c-comment { max-width:18em }
.pr-conns > .pr-row > .pr-comment { max-width:18em }
.pr-rules > .pr-row > .pr-handle { width:1.4em }
/* a rule inside a group is indented (the handle and conditions are shifted relative to the heading) */
.pr-rules > .pr-row.pr-in-group > .pr-handle { margin-left:1.1em }
.pr-rules > .pr-edit.pr-in-group { margin-left:1.1em }
.pr-row.pr-head { font-size:85%; opacity:.6; border-bottom-color:rgba(128,128,128,.4) }
.pr-row.pr-head:hover { background:none }
.pr-row.pr-note { display:flex; gap:.8em; padding-top:1.1em; border-bottom-color:rgba(128,128,128,.45) }
.pr-note > .pr-handle { flex:0 0 1.4em }
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
.pr-tag-protocol { background:rgba(192,57,43,.2) }
.pr-neg .pr-tag { text-decoration:line-through }
.pr-target { display:inline-block; padding:.05em .5em; border-radius:3px; font-weight:bold; overflow-wrap:anywhere; background:rgba(128,128,128,.2) }
.pr-t-chain { background:rgba(58,123,213,.2) }
.pr-t-conn { background:rgba(22,160,133,.22) }
.pr-t-block { background:rgba(220,50,50,.25) }
.pr-t-unknown { background:none; outline:1px dashed #d33; color:#d33 }
.pr-rules > .pr-row > .pr-c-wide { grid-column:2 / span 3 }
.pr-row.pr-head > span { white-space:nowrap }
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
/* the LuCI theme gives fields a fixed width: here the selects size to content
   ("Go via" fits the longest chain), the values field takes all the remaining space */
.pr-edit select { width:auto !important; min-width:0 !important; max-width:100%; flex:0 0 auto }
.pr-edit .pr-grow { flex:1 1 18em; min-width:10em; width:auto !important; max-width:none !important }
.pr-edit .pr-err { color:#d33 }
.pr-ms { position:relative }
/* the list picker button looks like the theme's text field (bootstrap: 30px, padding 4px, 1px border, 13px) */
.pr-edit .pr-ms-btn { display:block; width:100% !important; max-width:none !important; height:30px; margin:0; padding:4px;
	font:inherit; font-size:13px; line-height:18px; color:var(--text-color-high, inherit); background:var(--background-color-high, Canvas);
	border:1px solid var(--border-color-high, rgba(128,128,128,.6)); border-radius:3px;
	text-align:left; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.pr-ms-empty { opacity:.6 }
.pr-ms-panel { display:none; position:absolute; z-index:100; left:0; right:0; top:100%; margin-top:2px; max-height:20em; overflow:auto;
	padding:.4em .6em; grid-template-columns:repeat(auto-fill, minmax(10em, 1fr)); gap:.1em 1em;
	background:var(--background-color-high, Canvas); color:inherit; border:1px solid rgba(128,128,128,.5); border-radius:4px; box-shadow:0 4px 14px rgba(0,0,0,.18) }
.pr-ms-open > .pr-ms-panel { display:grid }
.pr-ms-panel label { display:flex; align-items:center; gap:.3em; padding:.15em 0; cursor:pointer; white-space:nowrap }
.pr-ms-panel input { margin:0 }
.pr-chip { display:inline-flex; align-items:center; gap:.2em; padding:.1em .2em .1em .5em; margin:.15em; border-radius:3px; background:rgba(58,123,213,.18) }
.pr-chip .btn { padding:0 .35em !important; min-width:0; line-height:1.5 }
.pr-dirty { color:#e67e22; font-weight:bold; line-height:1 }
.pr-empty { padding:1em; opacity:.6 }
@media (max-width: 800px) {
	/* narrow: everything in one column under the handle, the buttons in a row under the rule */
	.pr-rules { grid-template-columns:auto minmax(0,1fr) }
	.pr-rules > .pr-row > .pr-c-conds, .pr-rules > .pr-row > .pr-c-wide { grid-column:2; grid-row:1 }
	.pr-rules > .pr-row > .pr-c-target, .pr-rules > .pr-row > .pr-c-comment, .pr-rules > .pr-row > .pr-c-actions { grid-column:2 }
	.pr-rules > .pr-row > .pr-c-actions { white-space:normal; text-align:left }
	.pr-rules > .pr-row > .pr-c-actions .btn { margin:0 .2em 0 0 !important }
	.pr-rules > .pr-row > .pr-c-comment:empty, .pr-row.pr-head { display:none }
	.pr-conns { grid-template-columns:minmax(0,1fr) auto }
	.pr-conns > .pr-row > .pr-c-actions { grid-column:2; grid-row:1 / span 3 }
	.pr-conns > .pr-row > :not(.pr-c-actions) { grid-column:1 }
}
`;

return view.extend({
	load() {
		return Promise.all([ callGet(), callStatus() ]);
	},

	renderVersion(st) {
		const u = this.update, up = st.upgrade;
		const line = [ E('strong', 'Version: '), st.version || 'unknown' ];

		// The update has finished and the version changed — the page is different now, reload
		if (up && up.done && up.ok && st.version != this.loadedVersion) {
			if (!this.reloading) {
				this.reloading = true;
				window.setTimeout(() => location.reload(), 1500);
			}
			return E('p', { class: 'alert-message success' }, `Updated to ${st.version}, reloading the page…`);
		}

		if (up && (!up.done || this.upgrading)) {
			const out = [ E('p', {}, line) ];
			if (!up.done) out.push(E('p', { class: 'alert-message notice' }, [ E('span', { class: 'spinning' }, 'Updating…') ]));
			else out.push(E('p', { class: 'alert-message error' }, 'Update failed:'));
			if (up.log) out.push(E('pre', { style: 'white-space:pre-wrap;font-size:90%' }, [ up.log ]));
			return E('div', {}, out);
		}

		// Releases are checked only on a button press
		const check = (label) => E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, 'handleCheckUpdate') }, label);
		if (u && u.newer)
			line.push(' · ', E('strong', { style: 'color:#2a2' }, `${u.latest.replace(/^v/, '')} is available`), ' ',
				u.url ? E('a', { href: u.url, target: '_blank', rel: 'noopener' }, 'release notes') : '', ' ',
				E('button', { class: 'btn cbi-button cbi-button-action', click: ui.createHandlerFn(this, 'handleUpgrade', u.latest) }, 'Update'));
		else if (u)
			line.push(u.error
				? E('span', { style: 'color:#d33', title: u.error }, ' · could not check for updates ')
				: E('span', { style: 'opacity:.6' }, ' · this is the latest release '), check('Check again'));
		else
			line.push(' ', check('Check for updates'));
		return E('p', {}, line);
	},

	renderStatus(st) {
		const out = [ this.renderVersion(st) ];

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
				// Two columns: the name (as wide as the longest one) and the members
				out.push(E('div', { style: 'display:grid;grid-template-columns:max-content 1fr;gap:.3em 1.5em;margin-left:1em' }, chains.flatMap((key) => {
					const c = s.chains[key];
					// Chains given right in a rule have a key like "TR_DE_UK" — "_" is not allowed in names
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
		// The last tab opens (not the text one: edits in it don't survive a reload)
		let tab = null;
		try { tab = localStorage.getItem('proxyrules.tab'); } catch (e) { }
		this.tab = [ 'status', 'rules', 'conns', 'chains', 'settings' ].includes(tab) ? tab : 'rules';
		this.errors = new Map();     // item -> messages of the last check
		this.editing = null;         // the item open in the editor
		this.editorNode = null;
		this.pending = null;         // { apply() -> bool, cancel() } of the open editor

		this.loadedVersion = st.version;
		this.update = null;
		this.statusNode = E('div', {}, this.renderStatus(st));
		poll.add(() => this.refreshStatus(), 5);

		this.textarea = E('textarea', {
			class: 'cbi-input-textarea',
			style: 'width:100%;min-height:40em;font-family:monospace;font-size:12px;white-space:pre;overflow-wrap:normal;overflow-x:auto;tab-size:4',
			spellcheck: 'false',
			wrap: 'off',
			input: () => this.updateDirty(),
		}, [ this.savedText ]);

		this.filterInput = E('input', {
			class: 'cbi-input-text pr-filter', type: 'search', placeholder: 'Filter rules…',
			input: () => this.renderRuleList(),
		});
		this.ruleList = E('div', { class: 'pr-list pr-rules' });

		this.tabsNode = E('ul', { class: 'cbi-tabmenu pr-tabs' });
		this.body = E('div', { class: 'pr-body' });
		this.result = E('div');
		this.dirtyNode = E('span', { class: 'pr-dirty' });
		this.revertBtn = E('button', { class: 'btn cbi-button cbi-button-reset', click: ui.createHandlerFn(this, 'handleRevert') }, 'Revert');

		this.actionsNode = E('div', { class: 'cbi-page-actions pr-bar' }, [
			this.dirtyNode,
			this.revertBtn,
			E('button', { class: 'btn cbi-button', title: 'Ctrl+S', click: ui.createHandlerFn(this, 'handleCheck') }, 'Check'),
			E('button', { class: 'btn cbi-button cbi-button-apply', click: ui.createHandlerFn(this, 'handleApply') }, 'Save & Apply'),
		]);

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
				this.tabsNode,
				this.body,
				this.result,
				this.actionsNode,
			]),
		]);
	},

	// ─────────────────────────────────────────── common

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
			[ 'status', 'Status', {} ],
			[ 'rules', `Rules (${count('rule')})`, { rule: true, raw: true, note: true } ],
			[ 'conns', `Connections (${count('conn')})`, { conn: true } ],
			[ 'chains', `Chains (${count('chain')})`, { chain: true } ],
			[ 'settings', 'Settings', { setting: true } ],
			[ 'text', 'Config file', {} ],
		];
		this.rowEls = new Map();
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
		else if (this.tab == 'status') dom.content(this.body, [ this.statusNode ]);
		else if (this.tab == 'conns') dom.content(this.body, this.renderConnsTab());
		else if (this.tab == 'chains') dom.content(this.body, this.renderChainsTab());
		else if (this.tab == 'settings') dom.content(this.body, this.renderSettingsTab());
		else dom.content(this.body, [
			E('p', { class: 'cbi-section-descr' }, 'File /etc/proxyrules.conf as is. The syntax is described at its top. Ctrl+S — check without saving.'),
			this.textarea,
		]);
		// Check and save are about the file — the status tab doesn't have them
		this.actionsNode.classList.toggle('pr-hidden', this.tab == 'status');
		this.result.classList.toggle('pr-hidden', this.tab == 'status');
		this.updateDirty();
	},

	switchTab(tab) {
		if (tab == this.tab) return;
		if (!this.closeEditor(true)) return;
		if (this.tab == 'text') {
			// The text may have been edited by hand — the model is rebuilt
			if (this.textarea.value != serialize(this.items)) {
				this.items = parseDoc(this.textarea.value);
				this.errors.clear();
			}
		}
		else if (tab == 'text')
			this.textarea.value = serialize(this.items);
		this.tab = tab;
		try { localStorage.setItem('proxyrules.tab', tab); } catch (e) { }
		dom.content(this.result, []);
		this.renderAll();
	},

	// Changing the model: first close the open editor (saving it), then fn
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
		// An editor closed above shifts the list — the editor takes the row's place;
		// scroll only if it isn't fully visible
		this.keepAt(it, top);
		this.reveal(this.editorNode);
		const f = this.editorNode && this.editorNode.querySelector('input, textarea, select');
		if (f) f.focus({ preventScroll: true });
	},

	rowTop(it) {
		const el = this.rowEls && this.rowEls.get(it);
		// the top of the row's space including the outer margin — the editor has it, the row doesn't
		return el && el.isConnected ? el.getBoundingClientRect().top - (parseFloat(getComputedStyle(el).marginTop) || 0) : null;
	},

	// What scrolls: in some LuCI themes it's not the window but the page container
	scroller() {
		for (let el = this.ruleList.parentElement; el && el != document.body; el = el.parentElement) {
			const oy = getComputedStyle(el).overflowY;
			if ((oy == 'auto' || oy == 'scroll') && el.scrollHeight > el.clientHeight) return el;
		}
		return document.scrollingElement || document.documentElement;
	},

	// The visible area, minus the theme's sticky header
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

	// Scroll as little as possible so el is fully visible (if it's above the screen, the top matters more)
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

	// Enter — done, Esc — cancel
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

	// Insert a new structure item after the last item of the first kind found
	insertStruct(it, kinds) {
		for (const k of kinds) {
			let i = -1;
			this.items.forEach((x, j) => { if (x.kind == k) i = j; });
			if (i >= 0) { this.items.splice(i + 1, 0, it); return; }
		}
		// there's nothing like that — before the first structure item or rule, together with its heading
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

	// Rule target: a list of names + "inline chain…" with an input field
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

	// ─────────────────────────────────────────── rules

	ruleRegionStart() {
		const first = this.items.findIndex((x) => x.kind == 'rule');
		const upto = first < 0 ? this.items.length : first;
		let start = 0;
		for (let i = 0; i < upto; i++) if (STRUCT[this.items[i].kind]) start = i + 1;
		return start;
	},

	renderRulesTab() {
		return [
			E('div', { class: 'pr-toolbar' }, [
				this.filterInput,
				E('span', { style: 'opacity:.65;font-size:90%;flex:1' }, 'Checked top to bottom, the first match wins. Drag ⋮⋮ or use ↑ ↓ to reorder; double-click a rule to edit; +R / +G add a rule / group right below.'),
			]),
			this.ruleList,
		];
	},

	matches(it, q) {
		if (it.kind == 'rule')
			return (condsText(it.conds) + ' ' + it.target + ' ' + it.comment).toLowerCase().includes(q);
		return itemLines(it).join('\n').toLowerCase().includes(q);
	},

	renderRuleList() {
		const q = this.filterInput.value.trim().toLowerCase();
		const rows = [
			E('div', { class: 'pr-row pr-head' }, [ E('span'), E('span', 'Condition'), E('span', 'Target'), E('span', 'Comment'), E('span') ]),
		];
		this.rowEls = new Map();
		let inGroup = false;   // under a heading, up to a blank line
		for (let i = this.ruleRegionStart(); i < this.items.length; i++) {
			const it = this.items[i];
			if (it.kind == 'blank') { inGroup = false; continue; }
			if (it.kind == 'note') inGroup = true;
			let row;
			if (it == this.editing)
				row = this.editorNode = this.editorNode || (it.kind == 'note' ? this.noteEditor(it) : it.kind == 'rule' ? this.ruleEditor(it) : this.rawEditor(it));
			else if (q && !this.matches(it, q)) continue;
			else row = it.kind == 'note' ? this.noteRow(it) : this.ruleRow(it);
			row.classList.toggle('pr-in-group', inGroup && it.kind != 'note');
			rows.push(row);
			this.rowEls.set(it, row);
		}
		// Completely empty — nothing to add from, so the buttons are here
		if (rows.length == 1)
			rows.push(q ? E('div', { class: 'pr-empty' }, 'Nothing matches the filter.') : E('div', { class: 'pr-empty' }, [
				'No rules yet. ',
				btn('+ Rule', 'Add a rule', () => this.addRule(), 'cbi-button-add'), ' ',
				btn('+ Group', 'Add a heading for a group of rules', () => this.addGroup(), ''),
			]));
		dom.content(this.ruleList, rows);
		if (this.ruleList.querySelector('.pr-flash')) this.clearFlash();
	},

	// The highlight stays while the animation runs — survives the redraw after a check
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
			// an unrecognized line or a connection/chain in the middle of the rules
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
				btn('+R', 'Add a rule below this one', () => this.insertRule(it)),
				btn('+G', 'Start a new group below this rule', () => this.insertGroup(it)),
				btn('✕', 'Delete', () => this.remove(it), 'pr-icon cbi-button-negative'),
			]),
		]);
		this.errorsOf(it, row);
		if (!STRUCT[it.kind]) this.dragSource(row, it);
		this.dropTarget(row, it);
		return row;
	},

	noteRow(it) {
		// Frames like "── Rules ────" are removed for display
		const lines = noteText(it).split('\n').map((l) => l.replace(/^[─═━\-=\s]+|[─═━\-=\s]+$/g, '')).filter((l) => l != '');
		const row = E('div', { class: 'pr-row pr-note', dblclick: (ev) => ev.target.closest('button') || this.edit(it) }, [
			E('span', { class: 'pr-handle', title: 'Drag to move the whole group', mousedown: () => row.draggable = true, mouseup: () => row.draggable = false }, [ '⋮⋮' ]),
			E('div', { class: 'pr-note-text' }, lines.length
				? [ lines[0], ...lines.slice(1).map((l) => T('div', { class: 'pr-sub' }, l)) ]
				: [ E('span', { class: 'pr-sub' }, '(separator)') ]),
			E('div', { class: 'pr-actions' }, [
				btn('+R', 'Add a rule at the top of this group', () => this.insertRule(it)),
				btn('+G', 'Add a group below this one', () => this.insertGroup(it)),
				btn('✎', 'Edit heading', () => this.edit(it)),
				btn('✕', 'Delete heading (rules stay)', () => this.remove(it), 'pr-icon cbi-button-negative'),
			]),
		]);
		this.dragSource(row, it);
		this.dropTarget(row, it);
		return row;
	},

	// A rule is dragged or, by its heading, a whole group (heading + its rules)
	dragSource(row, it) {
		row.addEventListener('dragstart', (ev) => {
			const group = it.kind == 'note';
			const [ a, b ] = group ? this.sectionOf(it) : [ 0, -1 ];
			this.drag = { it, group, items: group ? this.items.slice(a, b + 1) : [ it ] };
			ev.dataTransfer.effectAllowed = 'move';
			ev.dataTransfer.setData('text/plain', '');
			this.drag.items.forEach((x) => { const el = this.rowEls.get(x); if (el) el.classList.add('pr-dragging'); });
			this.startAutoScroll();
		});
		row.addEventListener('dragend', () => {
			row.draggable = false;
			this.drag = null;
			this.stopAutoScroll();
			this.ruleList.querySelectorAll('.pr-dragging, .pr-drop-before, .pr-drop-after')
				.forEach((r) => r.classList.remove('pr-dragging', 'pr-drop-before', 'pr-drop-after'));
		});
	},

	dropTarget(row, it) {
		const clear = () => row.classList.remove('pr-drop-before', 'pr-drop-after');
		row.addEventListener('dragover', (ev) => {
			if (!this.drag || this.drag.items.includes(it)) return;
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
			const d = this.drag;
			if (!d || d.items.includes(it)) return;
			this.act(() => {
				if (d.group) this.moveGroup(d.it, it, row.dataset.where);
				else this.moveTo(d.it, it, row.dataset.where);
				this.flash = d.it;
			});
		});
	},

	// While something is dragged, the page scrolls by itself at the top/bottom edge —
	// the faster, the closer the cursor is to the edge
	startAutoScroll() {
		this.dragY = null;
		this.onDragMove = (ev) => { this.dragY = ev.clientY; };
		document.addEventListener('dragover', this.onDragMove);
		const sc = this.scroller(), zone = 80, max = 18;
		const tick = () => {
			if (!this.drag) return;
			const v = this.viewport(sc), y = this.dragY;
			let d = 0;
			if (y != null && y < v.top + zone) d = -max * Math.min(1, (v.top + zone - y) / zone);
			else if (y != null && y > v.bottom - zone) d = max * Math.min(1, (y - v.bottom + zone) / zone);
			if (d) sc.scrollBy(0, Math.round(d));
			this.scrollRaf = requestAnimationFrame(tick);
		};
		this.scrollRaf = requestAnimationFrame(tick);
	},

	stopAutoScroll() {
		cancelAnimationFrame(this.scrollRaf);
		document.removeEventListener('dragover', this.onDragMove);
	},

	// Before a group heading means at the end of the previous group (before the blank lines above the heading)
	moveTo(it, ref, where) {
		this.items.splice(this.items.indexOf(it), 1);
		let i = this.items.indexOf(ref);
		if (where == 'after') i++;
		else if (ref.kind == 'note')
			while (i > 0 && this.items[i - 1].kind == 'blank') i--;
		this.items.splice(i, 0, it);
	},

	// A group runs from a heading (or a blank line) to the next blank line or heading: [first, last]
	sectionOf(it) {
		const start = this.ruleRegionStart();
		let i = this.items.indexOf(it), j = i;
		while (i > start && this.items[i].kind != 'note' && this.items[i - 1].kind != 'blank') i--;
		while (j + 1 < this.items.length && this.items[j + 1].kind != 'blank' && this.items[j + 1].kind != 'note') j++;
		return [ i, j ];
	},

	// A whole group — before/after the group ref is in; groups are separated by a blank line
	moveGroup(note, ref, where) {
		const L = this.items;
		const [ a, b ] = this.sectionOf(note);
		const group = L.splice(a, b - a + 1);
		if (a > 0 && a < L.length && L[a - 1].kind == 'blank' && L[a].kind == 'blank') L.splice(a, 1);
		const [ c, d ] = this.sectionOf(ref);
		let at = where == 'before' ? c : d + 1;
		if (at > 0 && L[at - 1].kind != 'blank') L.splice(at++, 0, { kind: 'blank', lines: [ '' ] });
		L.splice(at, 0, ...group);
		at += group.length;
		if (at < L.length && L[at].kind != 'blank') L.splice(at, 0, { kind: 'blank', lines: [ '' ] });
	},

	// By one position; across a group heading — into the neighboring group
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

	// A new rule right under the ref row (a rule or a group heading); target as the neighboring rule's
	insertRule(ref) {
		if (!this.closeEditor(true)) return;
		const at = this.items.indexOf(ref) + 1;
		const near = ref.kind == 'rule' ? ref : this.items[at];
		const it = this.newRule(near && near.kind == 'rule' ? near.target : '');
		this.items.splice(at, 0, it);
		this.edit(it);
	},

	// A new group: under a rule it starts right here (the rules below go into it),
	// under a heading — after its whole group
	insertGroup(ref) {
		if (!this.closeEditor(true)) return;
		let at = this.items.indexOf(ref) + 1;
		if (ref.kind == 'note')
			while (at < this.items.length && this.items[at].kind != 'blank' && this.items[at].kind != 'note') at++;
		this.newGroupAt(at);
	},

	newGroupAt(at) {
		const blank = { kind: 'blank', lines: [ '' ] };
		const it = { kind: 'note', lines: [], text: '', dirty: true, isNew: true, blank };
		this.items.splice(at, 0, blank, it);
		this.edit(it);
	},

	// Remove a heading; for a just-added one, also the blank line inserted with it
	dropNote(it) {
		this.items.splice(this.items.indexOf(it), 1);
		if (it.blank && this.items.includes(it.blank)) this.items.splice(this.items.indexOf(it.blank), 1);
	},

	addGroup() {
		if (!this.closeEditor(true)) return;
		let at = this.items.length;
		while (at > 0 && this.items[at - 1].kind == 'blank') at--;
		this.newGroupAt(at);
	},

	ruleEditor(it) {
		const draft = it.conds.map((c) => ({ neg: c.neg, type: c.type, raw: c.values.join(', ') }));
		const box = E('div');
		const err = E('span', { class: 'pr-err' });

		const renderConds = () => dom.content(box, draft.map((c, i) => {
			const val = c.type == 'list' ? this.listPicker(c, LISTS, 'lists')
				: c.type == 'protocol' ? this.listPicker(c, PROTOCOLS, 'protocols') : E('input', {
				class: 'cbi-input-text pr-grow', type: 'text', value: c.raw, placeholder: PLACEHOLDERS[c.type],
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
					// gen.uc doesn't accept identical conditions — merge them
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

	// A heading is edited right in the table row and applied on every input; Esc reverts it
	// Picking list: and protocol: — a button showing the selection, a panel with checkboxes on click.
	// Names from the file that aren't among the known ones are shown too (checked).
	listPicker(c, known, what) {
		const sel = new Set(normalizeValues(c.type, c.raw));
		const all = [ ...known, ...[ ...sel ].filter((v) => !known.includes(v)) ];
		const label = E('span', { class: 'pr-ms-label' });
		const update = () => {
			const on = all.filter((v) => sel.has(v));
			c.raw = on.join(', ');
			dom.content(label, [ on.length ? on.join(', ') : 'choose ' + what + '…' ]);
			label.classList.toggle('pr-ms-empty', !on.length);
		};
		const panel = E('div', { class: 'pr-ms-panel' }, all.map((v) => E('label', {}, [
			E('input', { type: 'checkbox', checked: sel.has(v) ? '' : null, change: (ev) => { ev.target.checked ? sel.add(v) : sel.delete(v); update(); } }),
			' ' + v,
		])));
		const outside = (ev) => { if (!wrap.contains(ev.target)) close(); };
		const open = () => {
			wrap.classList.add('pr-ms-open');
			document.addEventListener('mousedown', outside, true);
			this.reveal(panel);
		};
		const close = () => { wrap.classList.remove('pr-ms-open'); document.removeEventListener('mousedown', outside, true); };
		const wrap = E('div', {
			class: 'pr-ms pr-grow',
			// Esc and Enter close only the panel, not the whole editor
			keydown: (ev) => {
				if (wrap.classList.contains('pr-ms-open') && (ev.key == 'Escape' || ev.key == 'Enter')) {
					ev.preventDefault(); ev.stopPropagation(); close(); button.focus();
				}
			},
		}, [
			E('button', { class: 'cbi-input-select pr-ms-btn', type: 'button', title: 'Choose ' + what,
				click: (ev) => { ev.preventDefault(); wrap.classList.contains('pr-ms-open') ? close() : open(); } }, [ label ]),
			panel,
		]);
		const button = wrap.firstChild;
		update();
		return wrap;
	},

	noteEditor(it) {
		const orig = { text: it.text, dirty: it.dirty };
		const start = noteText(it);
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
				if (text.value.trim() == '') this.dropNote(it);
				it.isNew = false;
				delete it.blank;
				return true;
			},
			cancel: () => {
				if (it.isNew) this.dropNote(it);
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

	// A new rule goes after the last one (the very end of the file may hold comments)
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

	// ─────────────────────────────────────────── connections and chains

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

	// Renaming — together with all references to the name
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

	// A connection/chain row; the editor takes its place
	structRow(it, cells) {
		if (it == this.editing) {
			this.editorNode = this.editorNode || (it.kind == 'conn' ? this.connEditor(it) : this.chainEditor(it));
			this.rowEls.set(it, this.editorNode);
			return this.editorNode;
		}
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
		this.rowEls.set(it, r);
		return r;
	},

	renderConnsTab() {
		const conns = this.items.filter((it) => it.kind == 'conn');
		this.clearFlash();
		return [
			E('p', { class: 'cbi-section-descr' }, 'A vless:// link as the server gave it, or an OpenWrt interface (AmneziaWG, WireGuard…).'),
			E('div', { class: 'pr-list pr-conns' }, [
				...conns.map((it) => this.structRow(it, E('div', { class: 'pr-mono', title: 'Double-click to see the full link' }, [
					linkSummary(it.link), it.comment ? T('span', { class: 'pr-comment' }, '  # ' + it.comment) : '',
				]))),
				conns.length ? '' : E('div', { class: 'pr-empty' }, 'No connections yet.'),
			].filter((x) => x)),
			btn('+ Connection', 'Add a connection', () => this.addStruct({ kind: 'conn', name: '', link: '', comment: '' }, [ 'conn', 'setting' ]), 'cbi-button-add'),
		];
	},

	renderChainsTab() {
		const chains = this.items.filter((it) => it.kind == 'chain');
		this.clearFlash();
		return [
			E('p', { class: 'cbi-section-descr' }, 'The first live connection in order is used; when a higher-priority one comes back, traffic switches back to it. A chain holds only connections and direct.'),
			E('div', { class: 'pr-list pr-conns' }, [
				...chains.map((it) => this.structRow(it, E('div', {}, [
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

	// ─────────────────────────────────────────── settings

	setSetting(name, value) {
		const it = this.items.find((x) => x.kind == 'setting' && x.name == name);
		value = value.trim();
		if (it && value == '') this.items.splice(this.items.indexOf(it), 1);  // empty — the default value
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
			// settings gen.uc doesn't know (a typo?) — show them so there's something to fix or remove
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

	// ─────────────────────────────────────────── check and save

	// "line N: …" from gen.uc → the model items holding those lines
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
			// "saved, but the service did not come up" — the file is written anyway
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

	handleCheckUpdate() {
		return callUpdate().then((u) => { this.update = u; return this.refreshStatus(); });
	},

	handleUpgrade(tag) {
		if (!confirm(`Update proxyrules to ${tag.replace(/^v/, '')}? A running service will be restarted.`)) return;
		return callUpgrade(tag).then((r) => {
			if (!r.ok) {
				ui.addNotification(null, E('pre', { style: 'white-space:pre-wrap' }, [ r.errors || 'Failed' ]), 'error');
				return;
			}
			this.upgrading = true;
			return this.refreshStatus();
		});
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
