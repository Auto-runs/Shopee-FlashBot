'use strict';

const { h } = FB.ui;
const $ = (sel) => document.querySelector(sel);
const EMPTY = { tasks: [], runs: [], active: {}, timeSync: null };
let state = { ...EMPTY };

const serverNow = () => FB.ui.serverNow(state.timeSync);

function openOptions(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') + (hash ? '#' + hash : '') });
  window.close();
}

function runCard(run) {
  return h(
    'section',
    { class: 'hero live' },
    h('div', { class: 'hero-label' }, h('span', { class: 'dot live' }), run.kind === 'test' ? 'Uji berjalan' : 'Sedang berjalan'),
    run.phase === 'armed' ? h('div', { class: 'hero-count', dataset: { countdown: run.saleTime, done: '00:00' } }) : null,
    h('div', { class: 'hero-name', text: run.taskName }),
    FB.ui.stepper(run.phase),
    h('div', { class: 'hero-step', text: FB.ui.lastStep(run) }),
    h(
      'div',
      { class: 'hero-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => chrome.runtime.sendMessage({ type: 'ui:cancelRun', runId: run.id }) }, FB.icon('stop', 13), 'Batalkan'),
    ),
  );
}

function nextCard(task) {
  return h(
    'section',
    { class: 'hero' },
    h('div', { class: 'hero-label' }, FB.icon('timer', 13), 'Berikutnya'),
    h('div', { class: 'hero-count', dataset: { countdown: task.saleTime } }),
    h('div', { class: 'hero-name', text: task.name }),
    h('div', { class: 'hero-sub' }, h('time', { text: FB.ui.dayLabel(task.saleTime) + ' ' + FB.ui.clock(task.saleTime) }), FB.ui.modeTag(task)),
  );
}

function render() {
  const runs = Object.values(state.active);
  const busy = new Set(runs.map((r) => r.taskId));
  const upcoming = state.tasks
    .filter((t) => t.enabled && !busy.has(t.id) && t.saleTime > serverNow())
    .sort((a, b) => a.saleTime - b.saleTime);

  const main = $('#main');
  main.replaceChildren();
  if (runs.length) runs.forEach((r) => main.append(runCard(r)));
  else if (upcoming.length) main.append(nextCard(upcoming[0]));
  else main.append(h('div', { class: 'empty', text: 'Belum ada task terjadwal.' }));

  const rest = runs.length ? upcoming.slice(0, 3) : upcoming.slice(1, 4);
  $('#upcoming').replaceChildren(
    ...rest.map((t) =>
      h(
        'div',
        { class: 'item' },
        h('span', { class: 'item-name', text: t.name }),
        h('span', { class: 'countdown', dataset: { countdown: t.saleTime } }),
        h('span', { class: 'item-sub', text: FB.ui.dayLabel(t.saleTime) + ' ' + FB.ui.clock(t.saleTime) + (t.dryRun ? ' · uji coba' : ' · beli sungguhan') }),
      ),
    ),
  );
  $('#upcoming-wrap').hidden = rest.length === 0;

  $('#last').replaceChildren(
    ...state.runs.slice(0, 2).map((run) =>
      h(
        'div',
        { class: 'item result' },
        FB.ui.statusIcon(run.status, 15),
        h('span', { class: 'item-name', text: run.taskName }),
        h('span', { class: 'item-sub', text: FB.describeStatus(run.status).label + (run.message ? ' — ' + run.message : '') }),
      ),
    ),
  );
  $('#last-wrap').hidden = state.runs.length === 0;
  tick();
}

function tick() {
  const now = serverNow();
  FB.ui.tickCountdowns(now);
  $('#server-clock').textContent = FB.ui.clock(now);
}

async function init() {
  FB.hydrateIcons();
  $('#btn-settings').addEventListener('click', () => openOptions('tasks'));
  $('#btn-add').addEventListener('click', () => openOptions('tasks'));
  $('#btn-history').addEventListener('click', () => openOptions('history'));
  const data = await chrome.storage.local.get(Object.keys(EMPTY));
  for (const key of Object.keys(EMPTY)) state[key] = data[key] || EMPTY[key];
  render();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key in EMPTY) state[key] = change.newValue || EMPTY[key];
    }
    render();
  });
  setInterval(tick, 250);
  document.body.dataset.ready = 'true';
}

init();
