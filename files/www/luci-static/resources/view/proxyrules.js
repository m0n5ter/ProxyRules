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

function nodeState(n) {
	if (n.up === true) return E('span', { style: 'color:#2a2' }, '● up');
	if (n.up === false) return E('span', { style: 'color:#d33' }, '● not responding');
	return E('span', { style: 'color:#888' }, '○ checking');
}

return view.extend({
	load() {
		return Promise.all([ callGet(), callStatus() ]);
	},

	renderStatus(st) {
		const out = [];

		if (!st.running) {
			out.push(E('p', { class: 'alert-message warning' }, st.legacy
				? 'Service is stopped. Legacy is currently running — stop it before starting this service.'
				: 'Service is stopped.'));
			if (st.error)
				out.push(E('pre', { class: 'alert-message error', style: 'white-space:pre-wrap' }, st.error));
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
							E('td', { class: 'td' }, E('strong', name)),
							E('td', { class: 'td' }, n.kind == 'iface' ? 'interface ' + n.where : n.where),
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
						: E('strong', {}, key);
					const parts = [];
					c.members.forEach((m, i) => {
						if (i) parts.push(' → ');
						parts.push(m == c.active ? E('strong', { style: 'color:#2a2' }, m) : E('span', { style: 'opacity:.55' }, m));
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
					failed.length ? E('span', { style: 'color:#d33' }, ` Failed to update: ${failed.join(', ')}.`) : '',
				]));
			}

			out.push(E('p', { style: 'opacity:.6;font-size:90%' }, `Checked ${ago(s.updated)} ago.`));
		}

		out.push(E('div', { class: 'cbi-page-actions', style: 'text-align:left' }, st.running ? [
			E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, 'handleService', 'restart') }, 'Restart'), ' ',
			E('button', { class: 'btn cbi-button cbi-button-negative', click: ui.createHandlerFn(this, 'handleService', 'stop') }, 'Stop'),
		] : [
			E('button', { class: 'btn cbi-button cbi-button-positive', click: ui.createHandlerFn(this, 'handleService', 'start'), disabled: st.legacy ? '' : null }, 'Start'),
		]));

		return out;
	},

	refreshStatus() {
		return callStatus().then((st) => dom.content(this.statusNode, this.renderStatus(st)));
	},

	render([ conf, st ]) {
		this.statusNode = E('div', {}, this.renderStatus(st));
		this.result = E('div');
		this.textarea = E('textarea', {
			class: 'cbi-input-textarea',
			style: 'width:100%;min-height:40em;font-family:monospace;font-size:12px;white-space:pre;overflow-wrap:normal;overflow-x:auto;tab-size:4',
			spellcheck: 'false',
			wrap: 'off',
			keydown: (ev) => {
				if ((ev.ctrlKey || ev.metaKey) && ev.key == 's') {
					ev.preventDefault();
					this.handleCheck();
				}
			},
		}, [ conf.content || '' ]);

		poll.add(() => this.refreshStatus(), 5);

		return E([], [
			E('h2', 'Proxy Rules'),
			E('div', { class: 'cbi-section' }, [
				E('h3', 'Status'),
				this.statusNode,
			]),
			E('div', { class: 'cbi-section' }, [
				E('h3', 'Rules'),
				E('p', { class: 'cbi-section-descr' },
					'File /etc/proxyrules.conf. The syntax is described at its top. Ctrl+S — check without saving.'),
				this.textarea,
				this.result,
				E('div', { class: 'cbi-page-actions' }, [
					E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, 'handleCheck') }, 'Check'), ' ',
					E('button', { class: 'btn cbi-button cbi-button-apply', click: ui.createHandlerFn(this, 'handleApply') }, 'Save & Apply'),
				]),
			]),
		]);
	},

	showResult(r, okText) {
		dom.content(this.result, r.ok
			? E('p', { class: 'alert-message success' }, okText + (r.summary ? ' (' + r.summary.replace(/^ok: /, '') + ')' : ''))
			: E('pre', { class: 'alert-message error', style: 'white-space:pre-wrap' }, r.errors || 'Unknown error'));
	},

	handleCheck() {
		return callCheck(this.textarea.value).then((r) => this.showResult(r, 'No errors'));
	},

	handleApply() {
		return callSave(this.textarea.value).then((r) => {
			this.showResult(r, r.restarted ? 'Saved and applied' : 'Saved (service is not running)');
			return this.refreshStatus();
		});
	},

	handleService(action) {
		return callService(action).then((r) => {
			if (!r.ok)
				ui.addNotification(null, E('pre', { style: 'white-space:pre-wrap' }, r.errors || 'Failed'), 'error');
			return this.refreshStatus();
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
});
