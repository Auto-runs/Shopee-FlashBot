'use strict';

const $ = (sel) => document.querySelector(sel);
let state = { tasks: [], runs: [], active: {}, timeSync: null };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function serverNow() {
  const s = state.timeSync;
  return Date.now() + (s && s.source === 'shopee' ? s.offsetMs : 0);
}

function openOptions(hash) {
  const url = chrome.runtime.getURL('src/options/options.html') + (hash ? '#' + hash : '');
  chrome.tabs.create({ url });
  window.close();
}

function render() {
  const active = $('#active');
  active.replaceChildren();
  for (const run of Object.values(state.active)) {
    const last = run.steps && run.steps.length ? run.steps[run.steps.length - 1].msg : '';
    active.append(
      h(
        'div',
        { class: 'card item active' },
        h(
          'div',
          { class: 'item-title' },
          h('span', { text: (run.kind === 'test' ? 'Uji: ' : '') + run.taskName }),
          run.phase === 'armed' ? h('span', { class: 'countdown', dataset: { countdown: run.saleTime } }) : null,
        ),
        h('div', { class: 'item-sub', text: (FB.PHASE_LABELS[run.phase] || run.phase) + (last ? ' · ' + last : '') }),
        h(
          'div',
          { class: 'item-actions' },
          h('button', {
            class: 'btn sm',
            type: 'button',
            text: 'Batalkan',
            onclick: () => chrome.runtime.sendMessage({ type: 'ui:cancelRun', runId: run.id }),
          }),
        ),
      ),
    );
  }

  const activeTaskIds = new Set(Object.values(state.active).map((r) => r.taskId));
  const upcoming = state.tasks
    .filter((t) => t.enabled && !activeTaskIds.has(t.id))
    .sort((a, b) => a.saleTime - b.saleTime)
    .slice(0, 4);
  const up = $('#upcoming');
  up.replaceChildren();
  for (const task of upcoming) {
    up.append(
      h(
        'div',
        { class: 'card item' },
        h('div', { class: 'item-title' }, h('span', { text: task.name }), h('span', { class: 'countdown', dataset: { countdown: task.saleTime } })),
        h('div', {
          class: 'item-sub',
          text: FB.formatDateTime(task.saleTime) + (task.dryRun ? ' · 🧪 uji coba' : ' · 🛒 beli sungguhan'),
        }),
      ),
    );
  }
  $('#upcoming-empty').hidden = upcoming.length > 0 || Object.keys(state.active).length > 0;

  const last = $('#last');
  last.replaceChildren();
  for (const run of state.runs.slice(0, 2)) {
    const st = FB.describeStatus(run.status);
    last.append(
      h(
        'div',
        { class: 'card item' },
        h('div', { class: 'item-title' }, h('span', { text: run.taskName }), h('span', { class: 'chip ' + st.tone, text: st.icon })),
        h('div', { class: 'item-sub', text: st.label + (run.message ? ' — ' + run.message : '') }),
      ),
    );
  }
  $('#last-wrap').hidden = state.runs.length === 0;
  tick();
}

function tick() {
  const now = serverNow();
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const left = Number(el.dataset.countdown) - now;
    el.textContent = left > 0 ? FB.formatDuration(left) : 'mulai';
  }
}

async function init() {
  $('#btn-settings').addEventListener('click', () => openOptions('tasks'));
  $('#btn-add').addEventListener('click', () => openOptions('tasks'));
  $('#btn-history').addEventListener('click', () => openOptions('history'));
  const data = await chrome.storage.local.get(['tasks', 'runs', 'active', 'timeSync']);
  state = { tasks: data.tasks || [], runs: data.runs || [], active: data.active || {}, timeSync: data.timeSync || null };
  render();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const empty = { tasks: [], runs: [], active: {}, timeSync: null };
    for (const [key, change] of Object.entries(changes)) {
      if (key in empty) state[key] = change.newValue || empty[key];
    }
    render();
  });
  setInterval(tick, 500);
  document.body.dataset.ready = 'true';
}

init();
