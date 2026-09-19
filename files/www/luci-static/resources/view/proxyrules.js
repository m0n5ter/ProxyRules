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
	if (s < 90) return s + ' с';
	if (s < 5400) return Math.round(s / 60) + ' мин';
	if (s < 129600) return Math.round(s / 3600) + ' ч';
	return Math.round(s / 86400) + ' дн';
}

function nodeState(n) {
	if (n.up === true) return E('span', { style: 'color:#2a2' }, '● работает');
	if (n.up === false) return E('span', { style: 'color:#d33' }, '● не отвечает');
	return E('span', { style: 'color:#888' }, '○ проверяется');
}

return view.extend({
	load() {
		return Promise.all([ callGet(), callStatus() ]);
	},

	renderStatus(st) {
		const out = [];

		if (!st.running) {
			out.push(E('p', { class: 'alert-message warning' }, st.legacy
				? 'Сервис остановлен. Сейчас работает Legacy — перед запуском его нужно остановить.'
				: 'Сервис остановлен.'));
			if (st.error)
				out.push(E('pre', { class: 'alert-message error', style: 'white-space:pre-wrap' }, st.error));
		}

		const s = st.status;
		if (st.running && s) {
			if (!s.api)
				out.push(E('p', { class: 'alert-message warning' }, 'sing-box не отвечает (запускается?)'));

			const names = Object.keys(s.nodes || {});
			if (names.length) {
				out.push(E('table', { class: 'table' }, [
					E('tr', { class: 'tr table-titles' }, [
						E('th', { class: 'th' }, 'Соединение'),
						E('th', { class: 'th' }, 'Куда'),
						E('th', { class: 'th' }, 'Состояние'),
						E('th', { class: 'th' }, 'Задержка'),
						E('th', { class: 'th' }, 'В этом состоянии'),
					]),
					...names.map((name) => {
						const n = s.nodes[name];
						return E('tr', { class: 'tr' }, [
							E('td', { class: 'td' }, E('strong', name)),
							E('td', { class: 'td' }, n.kind == 'iface' ? 'интерфейс ' + n.where : n.where),
							E('td', { class: 'td' }, nodeState(n)),
							E('td', { class: 'td' }, n.delay != null ? n.delay + ' мс' : '—'),
							E('td', { class: 'td' }, ago(n.since)),
						]);
					}),
				]));
			}

			const chains = Object.keys(s.chains || {});
			if (chains.length) {
				out.push(E('p', { style: 'margin-top:1em' }, E('strong', 'Цепочки (жирным — через что идёт трафик сейчас):')));
				out.push(E('ul', {}, chains.map((key) => {
					const c = s.chains[key];
					const parts = [];
					c.members.forEach((m, i) => {
						if (i) parts.push(' → ');
						parts.push(m == c.active ? E('strong', { style: 'color:#2a2' }, m) : E('span', { style: 'opacity:.55' }, m));
					});
					if (c.active && c.active.endsWith('~auto'))
						parts.push(E('em', { style: 'color:#d33' }, '  — все недоступны, sing-box ищет живое сам'));
					return E('li', {}, parts);
				})));
			}

			const lists = Object.keys(s.lists || {});
			if (lists.length) {
				const failed = lists.filter((l) => s.lists[l].error);
				const oldest = Math.min(...lists.map((l) => s.lists[l].updated || 0));
				out.push(E('p', {}, [
					`Списков: ${lists.length}, самый старый обновлён ${ago(oldest)} назад.`,
					failed.length ? E('span', { style: 'color:#d33' }, ` Не обновились: ${failed.join(', ')}.`) : '',
				]));
			}

			out.push(E('p', { style: 'opacity:.6;font-size:90%' }, `Проверено ${ago(s.updated)} назад.`));
		}

		out.push(E('div', { class: 'cbi-page-actions', style: 'text-align:left' }, st.running ? [
			E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, 'handleService', 'restart') }, 'Перезапустить'), ' ',
			E('button', { class: 'btn cbi-button cbi-button-negative', click: ui.createHandlerFn(this, 'handleService', 'stop') }, 'Остановить'),
		] : [
			E('button', { class: 'btn cbi-button cbi-button-positive', click: ui.createHandlerFn(this, 'handleService', 'start'), disabled: st.legacy ? '' : null }, 'Запустить'),
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
				E('h3', 'Состояние'),
				this.statusNode,
			]),
			E('div', { class: 'cbi-section' }, [
				E('h3', 'Правила'),
				E('p', { class: 'cbi-section-descr' },
					'Файл /etc/proxyrules.conf. Синтаксис описан в его начале. Ctrl+S — проверить без сохранения.'),
				this.textarea,
				this.result,
				E('div', { class: 'cbi-page-actions' }, [
					E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, 'handleCheck') }, 'Проверить'), ' ',
					E('button', { class: 'btn cbi-button cbi-button-apply', click: ui.createHandlerFn(this, 'handleApply') }, 'Сохранить и применить'),
				]),
			]),
		]);
	},

	showResult(r, okText) {
		dom.content(this.result, r.ok
			? E('p', { class: 'alert-message success' }, okText + (r.summary ? ' (' + r.summary.replace(/^ok: /, '') + ')' : ''))
			: E('pre', { class: 'alert-message error', style: 'white-space:pre-wrap' }, r.errors || 'Неизвестная ошибка'));
	},

	handleCheck() {
		return callCheck(this.textarea.value).then((r) => this.showResult(r, 'Ошибок нет'));
	},

	handleApply() {
		return callSave(this.textarea.value).then((r) => {
			this.showResult(r, r.restarted ? 'Сохранено и применено' : 'Сохранено (сервис не запущен)');
			return this.refreshStatus();
		});
	},

	handleService(action) {
		return callService(action).then((r) => {
			if (!r.ok)
				ui.addNotification(null, E('pre', { style: 'white-space:pre-wrap' }, r.errors || 'Не получилось'), 'error');
			return this.refreshStatus();
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
});
