'use strict';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const state = {
  settings: FB.mergeSettings(),
  tasks: [],
  runs: [],
  active: {},
  timeSync: null,
  lastNotifyError: null,
};

const TEXT_FIELDS = [
  ['buyNow', 'Tombol “Beli Sekarang”'],
  ['cartCheckout', 'Tombol “Checkout” di keranjang'],
  ['placeOrder', 'Tombol “Buat Pesanan”'],
  ['totalLabel', 'Label total pembayaran'],
  ['quantityLabel', 'Label kolom jumlah'],
  ['soldOut', 'Teks stok habis (boleh kosong)'],
  ['notStarted', 'Teks flash sale belum mulai (boleh kosong)'],
];

const QUICK_HOURS = [0, 9, 12, 15, 18, 20, 21, 22];

// ── Util ──────────────────────────────────────────────────────────────────────

/** Buat elemen DOM tanpa innerHTML (aman dari data pengguna). */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function send(type, data) {
  try {
    const res = await chrome.runtime.sendMessage({ type, ...(data || {}) });
    return res || { ok: false, error: 'Tidak ada respons dari extension.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

let toastTimer = null;
function toast(message, tone) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'show' + (tone ? ' ' + tone : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3800);
}

function serverNow() {
  const sync = state.timeSync;
  return Date.now() + (sync && sync.source === 'shopee' ? sync.offsetMs : 0);
}

function statusChip(status) {
  const st = FB.describeStatus(status);
  return h('span', { class: 'chip ' + st.tone }, st.icon + ' ' + st.label);
}

function timeZoneLabel() {
  const offset = -new Date().getTimezoneOffset() / 60;
  const names = { 7: 'WIB', 8: 'WITA', 9: 'WIT' };
  const sign = offset >= 0 ? '+' : '-';
  return 'GMT' + sign + Math.abs(offset) + (names[offset] ? ' (' + names[offset] + ')' : '');
}

function formatClock(ms) {
  const d = new Date(ms);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
}

function activeRunForTask(taskId) {
  return Object.values(state.active).find((r) => r.taskId === taskId) || null;
}

// ── Navigasi tab ──────────────────────────────────────────────────────────────

function showView(name) {
  const views = ['tasks', 'notify', 'advanced', 'history', 'help'];
  if (!views.includes(name)) name = 'tasks';
  for (const v of views) $('#view-' + v).hidden = v !== name;
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

// ── Render: run aktif, peringatan, task ───────────────────────────────────────

function renderActiveRuns() {
  const box = $('#active-runs');
  box.replaceChildren();
  for (const run of Object.values(state.active)) {
    const last = run.steps && run.steps.length ? run.steps[run.steps.length - 1].msg : '';
    const phase = FB.PHASE_LABELS[run.phase] || run.phase;
    box.append(
      h(
        'div',
        { class: 'card run-banner', dataset: { run: run.id } },
        h(
          'div',
          { class: 'run-info' },
          h(
            'div',
            { class: 'run-title' },
            h('span', { class: 'pulse', 'aria-hidden': 'true' }),
            (run.kind === 'test' ? 'Uji sekarang: ' : 'Berjalan: ') + run.taskName,
          ),
          h(
            'div',
            { class: 'run-step' },
            phase,
            run.phase === 'armed'
              ? h('span', { class: 'mono', dataset: { countdown: run.saleTime } })
              : null,
            last ? ' · ' + last : '',
          ),
        ),
        h('button', {
          class: 'btn sm',
          type: 'button',
          text: 'Batalkan',
          onclick: async () => {
            const res = await send('ui:cancelRun', { runId: run.id });
            if (!res.ok) toast(res.error || 'Gagal membatalkan.', 'bad');
          },
        }),
      ),
    );
  }
}

function renderWarnings() {
  const box = $('#warnings');
  box.replaceChildren();
  const tg = state.settings.telegram;
  const enabledTasks = state.tasks.filter((t) => t.enabled);
  if (enabledTasks.length && !(tg.enabled && tg.botToken && tg.chatId)) {
    box.append(
      h(
        'div',
        { class: 'callout info' },
        'Tips: aktifkan ',
        h('a', { href: '#notify', text: 'notifikasi Telegram', onclick: () => showView('notify') }),
        ' supaya tahu hasilnya walaupun tidak di depan komputer.',
      ),
    );
  }
  for (const [a, b] of FB.findCloseTasks(state.tasks)) {
    box.append(
      h(
        'div',
        { class: 'callout warn' },
        '“' + a.name + '” dan “' + b.name + '” berjadwal berdekatan. Keduanya tetap dijalankan di tab terpisah, tapi koneksi & komputer akan lebih sibuk.',
      ),
    );
  }
  if (state.lastNotifyError) {
    box.append(h('div', { class: 'callout bad' }, 'Notifikasi Telegram terakhir gagal: ' + state.lastNotifyError.error));
  }
}

function taskStatusChip(task, run) {
  if (run) {
    return h('span', { class: 'chip accent' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), run.kind === 'test' ? 'Uji berjalan' : 'Berjalan');
  }
  if (task.enabled) return h('span', { class: 'chip info', text: 'Terjadwal' });
  return h('span', { class: 'chip', text: 'Nonaktif' });
}

function taskCard(task) {
  const run = activeRunForTask(task.id);
  const meta = [];
  if (task.variants.length) meta.push(h('span', { class: 'chip', text: 'Varian: ' + task.variants.join(', ') }));
  meta.push(h('span', { class: 'chip', text: 'Jumlah ' + task.quantity }));
  if (task.payment) meta.push(h('span', { class: 'chip', text: 'Bayar: ' + task.payment }));
  meta.push(
    task.maxPrice
      ? h('span', { class: 'chip', text: 'Maks ' + FB.formatRupiah(task.maxPrice) })
      : h('span', { class: 'chip warn', text: 'Tanpa harga maksimal' }),
  );
  meta.push(
    task.dryRun
      ? h('span', { class: 'chip info', text: '🧪 Mode uji coba' })
      : h('span', { class: 'chip accent', text: '🛒 Beli sungguhan' }),
  );

  let last = null;
  if (task.lastRun) {
    const st = FB.describeStatus(task.lastRun.status);
    last = h(
      'div',
      { class: 'task-last' },
      'Terakhir' + (task.lastRun.kind === 'test' ? ' (uji sekarang)' : '') + ': ' + st.icon + ' ' + st.label,
      task.lastRun.message ? ' — ' + task.lastRun.message : '',
      ' · ' + FB.formatDateTime(task.lastRun.at),
    );
  }

  const toggle = h('input', {
    type: 'checkbox',
    'aria-label': 'Aktifkan jadwal',
    onchange: async (e) => {
      const res = await send('ui:toggleTask', { id: task.id, enabled: e.target.checked });
      if (!res.ok) {
        e.target.checked = !e.target.checked;
        toast(res.error || 'Gagal mengubah.', 'bad');
      }
    },
  });
  toggle.checked = task.enabled;
  toggle.disabled = Boolean(run);

  return h(
    'article',
    { class: 'card task' + (task.enabled ? '' : ' disabled'), dataset: { task: task.id } },
    h(
      'div',
      { class: 'task-main' },
      h('div', { class: 'task-title' }, taskStatusChip(task, run), h('h3', { text: task.name })),
      h('a', { class: 'task-url', href: task.url, target: '_blank', rel: 'noopener', text: task.url }),
      h(
        'div',
        { class: 'task-time' },
        '🕒 ' + FB.formatDateTime(task.saleTime),
        task.enabled || run ? h('span', { class: 'countdown', dataset: { countdown: task.saleTime } }) : null,
      ),
      h('div', { class: 'task-meta' }, meta),
      last,
    ),
    h(
      'div',
      { class: 'task-side' },
      h('label', { class: 'toggle-row' }, h('span', { text: 'Jadwal aktif' }), h('span', { class: 'switch' }, toggle, h('span'))),
      h(
        'div',
        { class: 'task-actions' },
        h('button', {
          class: 'btn sm',
          type: 'button',
          text: 'Uji sekarang',
          title: 'Jalankan semua langkah sekarang tanpa membuat pesanan',
          disabled: Boolean(run),
          onclick: () => testTask(task),
        }),
        h('button', { class: 'btn sm', type: 'button', text: 'Edit', disabled: Boolean(run), onclick: () => openForm(task) }),
        h('button', {
          class: 'btn sm danger',
          type: 'button',
          text: 'Hapus',
          disabled: Boolean(run),
          onclick: () => deleteTask(task),
        }),
      ),
    ),
  );
}

function renderTasks() {
  const list = $('#task-list');
  list.replaceChildren();
  const tasks = state.tasks
    .slice()
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.saleTime || 0) - (b.saleTime || 0));
  for (const task of tasks) list.append(taskCard(task));
  $('#empty').hidden = tasks.length > 0 || !$('#task-form').hidden;
}

function renderHistory() {
  const list = $('#history-list');
  list.replaceChildren();
  for (const run of state.runs) {
    const kind =
      run.kind === 'test'
        ? h('span', { class: 'chip', text: 'Uji sekarang' })
        : run.dryRun
          ? h('span', { class: 'chip', text: 'Terjadwal · uji coba' })
          : h('span', { class: 'chip', text: 'Terjadwal' });
    const steps = (run.steps || []).map((s) => h('li', {}, h('time', { text: formatClock(s.at) }), h('span', { text: s.msg })));
    list.append(
      h(
        'article',
        { class: 'card history-item' },
        h('div', { class: 'history-head' }, statusChip(run.status), h('strong', { text: run.taskName }), kind),
        h(
          'div',
          { class: 'history-msg' },
          run.message || '',
          Number.isFinite(run.total) ? ' · Total ' + FB.formatRupiah(run.total) : '',
        ),
        h('div', { class: 'muted small' }, FB.formatDateTime(run.finishedAt || run.startedAt)),
        run.notifyError ? h('div', { class: 'small', style: 'color:var(--bad)' }, 'Notifikasi gagal: ' + run.notifyError) : null,
        steps.length ? h('details', {}, h('summary', { text: 'Detail langkah (' + steps.length + ')' }), h('ol', { class: 'steps' }, steps)) : null,
      ),
    );
  }
  $('#history-empty').hidden = state.runs.length > 0;
}

function renderAll() {
  renderActiveRuns();
  renderWarnings();
  renderTasks();
  renderHistory();
  tickCountdowns();
}

function tickCountdowns() {
  const now = serverNow();
  for (const el of $$('[data-countdown]')) {
    const target = Number(el.dataset.countdown);
    const left = target - now;
    el.textContent = left > 0 ? ' · ' + FB.formatDuration(left) + ' lagi' : ' · dimulai';
  }
}

// ── Form task ─────────────────────────────────────────────────────────────────

function setFieldErrors(errors) {
  for (const field of $$('#task-form [data-field]')) {
    const msg = (errors && errors[field.dataset.field]) || '';
    field.classList.toggle('invalid', Boolean(msg));
    $('.field-error', field).textContent = msg;
  }
}

function nextOccurrence(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now() + 60000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function updateUrlPreview() {
  const value = $('#f-url').value.trim();
  const preview = $('#url-preview');
  if (!value) {
    preview.textContent = 'Salin dari address bar saat membuka halaman produk.';
    return;
  }
  const parsed = FB.parseProductUrl(value);
  preview.textContent = parsed.ok
    ? '✓ Produk: ' + (FB.productNameFromUrl(parsed.url) || 'ID ' + parsed.itemId)
    : parsed.error;
}

function updateDryRunStyle() {
  $('.dryrun-box').classList.toggle('off', !$('#f-dryrun').checked);
}

function formatPriceInput() {
  const input = $('#f-maxprice');
  const digits = input.value.replace(/[^\d]/g, '');
  input.value = digits ? FB.formatRupiah(Number(digits)).replace('Rp', '') : '';
}

function openForm(task) {
  const form = $('#task-form');
  form.reset();
  setFieldErrors(null);
  $('#f-id').value = task ? task.id : '';
  $('#form-title').textContent = task ? 'Edit task' : 'Task baru';
  $('#f-url').value = task ? task.url : '';
  $('#f-name').value = task ? task.name : '';
  $('#f-variants').value = task ? task.variants.join(', ') : '';
  $('#f-qty').value = task ? task.quantity : 1;
  $('#f-payment').value = task ? task.payment : '';
  $('#f-maxprice').value = task && task.maxPrice ? String(task.maxPrice) : '';
  formatPriceInput();
  $('#f-dryrun').checked = task ? task.dryRun : true;
  const time = task && task.saleTime > Date.now() ? task.saleTime : nextOccurrence(12);
  $('#f-time').value = FB.toDatetimeLocal(time);
  updateUrlPreview();
  updateDryRunStyle();
  form.hidden = false;
  $('#empty').hidden = true;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#f-url').focus({ preventScroll: true });
}

function closeForm() {
  $('#task-form').hidden = true;
  renderTasks();
}

async function submitTask(e) {
  e.preventDefault();
  const input = {
    id: $('#f-id').value || undefined,
    url: $('#f-url').value,
    name: $('#f-name').value,
    variants: $('#f-variants').value,
    quantity: $('#f-qty').value,
    saleTime: FB.fromDatetimeLocal($('#f-time').value),
    payment: $('#f-payment').value,
    maxPrice: $('#f-maxprice').value,
    dryRun: $('#f-dryrun').checked,
    enabled: true,
  };
  if (input.saleTime == null) input.saleTime = $('#f-time').value;

  const check = FB.validateTask(input);
  if (!check.ok) {
    setFieldErrors(check.errors);
    return;
  }
  if (!input.dryRun) {
    const ok = confirm(
      'Mode uji coba MATI.\n\nBot akan BENAR-BENAR membuat pesanan saat flash sale dimulai. ' +
        'Pastikan sudah mencoba “Uji sekarang” dan harga maksimal sudah diisi.\n\nLanjutkan?',
    );
    if (!ok) return;
  }
  const btn = $('#btn-save-task');
  btn.disabled = true;
  const res = await send('ui:saveTask', { task: input });
  btn.disabled = false;
  if (!res.ok) {
    if (res.errors) setFieldErrors(res.errors);
    else toast(res.error || 'Gagal menyimpan.', 'bad');
    return;
  }
  closeForm();
  toast('Task disimpan. Bot akan berjalan otomatis ' + FB.formatDateTime(res.task.saleTime) + '.', 'good');
}

async function testTask(task) {
  const res = await send('ui:testTask', { id: task.id });
  if (res.ok) toast('Uji coba dimulai di tab baru — pesanan tidak akan dibuat.', 'good');
  else toast(res.error || 'Gagal memulai uji coba.', 'bad');
}

async function deleteTask(task) {
  if (!confirm('Hapus task “' + task.name + '”?')) return;
  const res = await send('ui:deleteTask', { id: task.id });
  if (!res.ok) toast(res.error || 'Gagal menghapus.', 'bad');
}

// ── Notifikasi ────────────────────────────────────────────────────────────────

function fillNotifyForm() {
  const tg = state.settings.telegram;
  $('#n-enabled').checked = tg.enabled;
  $('#n-token').value = tg.botToken;
  $('#n-chat').value = tg.chatId;
  $('#n-arm').checked = state.settings.notifyOnArm;
  renderNotifyError();
}

function renderNotifyError() {
  const box = $('#notify-error');
  box.hidden = !state.lastNotifyError;
  box.textContent = state.lastNotifyError ? 'Pengiriman terakhir gagal: ' + state.lastNotifyError.error : '';
}

function notifyFormValues() {
  return {
    enabled: $('#n-enabled').checked,
    botToken: $('#n-token').value.trim(),
    chatId: $('#n-chat').value.trim(),
  };
}

async function saveNotify(e) {
  e.preventDefault();
  const telegram = notifyFormValues();
  if (telegram.enabled && (!telegram.botToken || !telegram.chatId)) {
    toast('Isi token bot dan Chat ID dulu.', 'bad');
    return;
  }
  const res = await send('ui:saveSettings', { settings: { telegram, notifyOnArm: $('#n-arm').checked } });
  if (res.ok) toast('Pengaturan notifikasi disimpan.', 'good');
  else toast(res.error || 'Gagal menyimpan.', 'bad');
}

async function testTelegram() {
  const btn = $('#btn-test-telegram');
  btn.disabled = true;
  const res = await send('ui:testTelegram', { telegram: notifyFormValues() });
  btn.disabled = false;
  if (res.ok) toast('Pesan tes terkirim — cek Telegram kamu.', 'good');
  else toast(res.error || 'Gagal mengirim.', 'bad');
}

async function detectChat() {
  const btn = $('#btn-detect-chat');
  btn.disabled = true;
  const res = await send('ui:detectChat', { botToken: $('#n-token').value.trim() });
  btn.disabled = false;
  if (res.ok) {
    $('#n-chat').value = res.chatId;
    toast('Chat ID ditemukan' + (res.name ? ' (' + res.name + ')' : '') + '. Jangan lupa Simpan.', 'good');
  } else {
    toast(res.error || 'Gagal mendeteksi.', 'bad');
  }
}

// ── Lanjutan ──────────────────────────────────────────────────────────────────

function buildTextFields() {
  const grid = $('#texts-grid');
  grid.replaceChildren();
  for (const [key, label] of TEXT_FIELDS) {
    grid.append(
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: label }),
        h('textarea', { id: 't-' + key, rows: 3, spellcheck: 'false' }),
      ),
    );
  }
}

function fillAdvancedForm() {
  const s = state.settings;
  $('#a-lead').value = s.leadSeconds;
  $('#a-delay').value = s.reloadDelayMs;
  $('#a-reloads').value = s.maxReloads;
  $('#a-timeout').value = Math.round(s.stepTimeoutMs / 1000);
  $('#a-timesync').checked = s.timeSync;
  for (const [key] of TEXT_FIELDS) $('#t-' + key).value = (s.texts[key] || []).join('\n');
  renderTimeSync();
}

function renderTimeSync(text) {
  const sync = state.timeSync;
  $('#time-result').textContent =
    text || (sync ? FB.describeOffset(sync) + ' Dicek ' + FB.formatDateTime(sync.at) + '.' : '');
}

async function saveAdvanced(e) {
  e.preventDefault();
  const texts = {};
  for (const [key] of TEXT_FIELDS) texts[key] = $('#t-' + key).value;
  const res = await send('ui:saveSettings', {
    settings: {
      leadSeconds: $('#a-lead').value,
      reloadDelayMs: $('#a-delay').value,
      maxReloads: $('#a-reloads').value,
      stepTimeoutMs: Number($('#a-timeout').value) * 1000,
      timeSync: $('#a-timesync').checked,
      texts,
    },
  });
  if (res.ok) {
    state.settings = res.settings;
    fillAdvancedForm();
    toast('Pengaturan disimpan.', 'good');
  } else {
    toast(res.error || 'Gagal menyimpan.', 'bad');
  }
}

async function resetTexts() {
  const res = await send('ui:resetTexts');
  if (res.ok) {
    state.settings = res.settings;
    fillAdvancedForm();
    toast('Teks tombol dikembalikan ke bawaan.', 'good');
  }
}

async function checkTime() {
  const btn = $('#btn-check-time');
  btn.disabled = true;
  renderTimeSync('Mengecek…');
  const res = await send('ui:checkTime');
  btn.disabled = false;
  if (res.ok) {
    state.timeSync = res.sync;
    renderTimeSync();
  } else {
    renderTimeSync(res.error);
  }
}

// ── Mulai ─────────────────────────────────────────────────────────────────────

function applyStorage(data) {
  if ('settings' in data) state.settings = FB.mergeSettings(data.settings);
  if ('tasks' in data) state.tasks = data.tasks || [];
  if ('runs' in data) state.runs = data.runs || [];
  if ('active' in data) state.active = data.active || {};
  if ('timeSync' in data) state.timeSync = data.timeSync || null;
  if ('lastNotifyError' in data) state.lastNotifyError = data.lastNotifyError || null;
}

function bindEvents() {
  for (const tab of $$('.tab')) tab.addEventListener('click', () => showView(tab.dataset.view));
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

  $('#btn-add').addEventListener('click', () => openForm(null));
  $('#btn-add-empty').addEventListener('click', () => openForm(null));
  $('#btn-cancel-form').addEventListener('click', closeForm);
  $('#btn-cancel-form-2').addEventListener('click', closeForm);
  $('#task-form').addEventListener('submit', submitTask);
  $('#f-url').addEventListener('input', updateUrlPreview);
  $('#task-form').addEventListener('input', (e) => {
    const field = e.target.closest('[data-field]');
    if (field && field.classList.contains('invalid')) {
      field.classList.remove('invalid');
      $('.field-error', field).textContent = '';
    }
  });
  $('#f-dryrun').addEventListener('change', updateDryRunStyle);
  $('#f-maxprice').addEventListener('blur', formatPriceInput);

  $('#tz-hint').textContent = 'Zona waktu komputer: ' + timeZoneLabel();
  const quick = $('#quick-times');
  for (const hour of QUICK_HOURS) {
    quick.append(
      h('button', {
        type: 'button',
        text: String(hour).padStart(2, '0') + ':00',
        onclick: () => ($('#f-time').value = FB.toDatetimeLocal(nextOccurrence(hour))),
      }),
    );
  }

  $('#notify-form').addEventListener('submit', saveNotify);
  $('#btn-test-telegram').addEventListener('click', testTelegram);
  $('#btn-detect-chat').addEventListener('click', detectChat);
  $('#btn-show-token').addEventListener('click', () => {
    const input = $('#n-token');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#btn-show-token').textContent = input.type === 'password' ? 'Lihat' : 'Sembunyikan';
  });

  $('#advanced-form').addEventListener('submit', saveAdvanced);
  $('#btn-reset-texts').addEventListener('click', resetTexts);
  $('#btn-check-time').addEventListener('click', checkTime);

  $('#btn-clear-history').addEventListener('click', async () => {
    if (!state.runs.length || !confirm('Hapus semua riwayat?')) return;
    await send('ui:clearHistory');
  });
}

async function init() {
  $('#version').textContent = 'Versi ' + chrome.runtime.getManifest().version;
  buildTextFields();
  bindEvents();
  showView(location.hash.slice(1));

  applyStorage(await chrome.storage.local.get(['settings', 'tasks', 'runs', 'active', 'timeSync', 'lastNotifyError']));
  fillNotifyForm();
  fillAdvancedForm();
  renderAll();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const data = {};
    for (const [key, change] of Object.entries(changes)) data[key] = change.newValue;
    applyStorage(data);
    renderAll();
    if ('lastNotifyError' in data) renderNotifyError();
    if ('timeSync' in data) renderTimeSync();
  });
  setInterval(tickCountdowns, 500);
  document.body.dataset.ready = 'true';
}

init();
