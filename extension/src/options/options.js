'use strict';

const { h } = FB.ui;
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
  ['buyNow', 'Beli Sekarang'],
  ['cartCheckout', 'Checkout (keranjang)'],
  ['placeOrder', 'Buat Pesanan'],
  ['totalLabel', 'Label total pembayaran'],
  ['quantityLabel', 'Label kolom jumlah'],
  ['soldOut', 'Stok habis (boleh kosong)'],
  ['notStarted', 'Flash sale belum mulai (boleh kosong)'],
];

const QUICK_HOURS = [0, 9, 12, 15, 18, 20, 21, 22];
const ISSUE_URL = 'https://github.com/Auto-runs/Shopee-FlashBot/issues/new?template=bug_report.yml';

// ── Util ──────────────────────────────────────────────────────────────────────

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
  el.replaceChildren(FB.icon(tone === 'bad' ? 'fail' : 'check', 15), h('span', { text: message }));
  el.className = 'show' + (tone ? ' ' + tone : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3800);
}

const serverNow = () => FB.ui.serverNow(state.timeSync);

function timeZoneLabel() {
  const offset = -new Date().getTimezoneOffset() / 60;
  const names = { 7: 'WIB', 8: 'WITA', 9: 'WIT' };
  return names[offset] || 'GMT' + (offset >= 0 ? '+' : '-') + Math.abs(offset);
}

function activeRunForTask(taskId) {
  return Object.values(state.active).find((r) => r.taskId === taskId) || null;
}

function iconButton(icon, label, onclick, opts) {
  return h(
    'button',
    { class: 'btn sm icon-only ' + ((opts && opts.cls) || 'quiet'), type: 'button', 'aria-label': label, title: label, disabled: opts && opts.disabled, onclick },
    FB.icon(icon, 15),
  );
}

// ── Navigasi ──────────────────────────────────────────────────────────────────

const VIEWS = ['tasks', 'history', 'notify', 'advanced', 'help'];

function showView(name) {
  if (!VIEWS.includes(name)) name = 'tasks';
  for (const v of VIEWS) $('#view-' + v).hidden = v !== name;
  for (const item of $$('.nav-item')) {
    if (item.dataset.view === name) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

// ── Hero: sedang berjalan / berikutnya ────────────────────────────────────────

function runHero(run) {
  const armed = run.phase === 'armed';
  return h(
    'section',
    { class: 'panel hero live', dataset: { run: run.id } },
    h(
      'div',
      {},
      h('div', { class: 'hero-label' }, h('span', { class: 'dot live' }), run.kind === 'test' ? 'Uji sekarang berjalan' : 'Sedang berjalan'),
      armed
        ? h('div', { class: 'hero-count', dataset: { countdown: run.saleTime, done: '00:00' } })
        : null,
      h('div', { class: 'hero-name', text: run.taskName }),
    ),
    h(
      'div',
      { class: 'hero-side' },
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            const res = await send('ui:cancelRun', { runId: run.id });
            if (!res.ok) toast(res.error || 'Gagal membatalkan.', 'bad');
          },
        },
        FB.icon('stop', 14),
        'Batalkan',
      ),
    ),
    FB.ui.stepper(run.phase),
    h('div', { class: 'hero-step', text: FB.ui.lastStep(run) }),
  );
}

function nextHero(task) {
  return h(
    'section',
    { class: 'panel hero' },
    h(
      'div',
      {},
      h('div', { class: 'hero-label' }, FB.icon('timer', 14), 'Berikutnya'),
      h('div', { class: 'hero-count', dataset: { countdown: task.saleTime } }),
      h('div', { class: 'hero-name', text: task.name }),
      h('div', { class: 'hero-sub' }, h('time', { text: FB.ui.dayLabel(task.saleTime) + ' ' + FB.ui.clock(task.saleTime) }), FB.ui.modeTag(task)),
    ),
    h(
      'div',
      { class: 'hero-side' },
      h('button', { class: 'btn', type: 'button', onclick: () => testTask(task) }, FB.icon('play', 14), 'Uji sekarang'),
    ),
  );
}

function renderHero() {
  const box = $('#hero');
  box.replaceChildren();
  const runs = Object.values(state.active);
  if (runs.length) {
    for (const run of runs) box.append(runHero(run));
    return;
  }
  const busy = new Set(runs.map((r) => r.taskId));
  const next = state.tasks
    .filter((t) => t.enabled && !busy.has(t.id) && t.saleTime > serverNow())
    .sort((a, b) => a.saleTime - b.saleTime)[0];
  if (next) box.append(nextHero(next));
}

function renderWarnings() {
  const box = $('#warnings');
  box.replaceChildren();
  const tg = state.settings.telegram;
  if (state.tasks.some((t) => t.enabled) && !(tg.enabled && tg.botToken && tg.chatId)) {
    box.append(
      h(
        'div',
        { class: 'note' },
        FB.icon('bell', 15),
        h('span', {}, 'Aktifkan ', h('a', { href: '#notify', text: 'notifikasi Telegram', onclick: () => showView('notify') }), ' supaya tahu hasilnya walau tidak di depan komputer.'),
      ),
    );
  }
  for (const [a, b] of FB.findCloseTasks(state.tasks)) {
    box.append(
      h('div', { class: 'note warn' }, FB.icon('alert', 15), h('span', { text: '“' + a.name + '” dan “' + b.name + '” berjadwal berdekatan. Keduanya tetap jalan di tab terpisah, tapi komputer dan koneksi lebih sibuk.' })),
    );
  }
  if (state.lastNotifyError) {
    box.append(h('div', { class: 'note bad' }, FB.icon('fail', 15), h('span', { text: 'Notifikasi Telegram terakhir gagal: ' + state.lastNotifyError.error })));
  }
}

// ── Daftar task ───────────────────────────────────────────────────────────────

function taskMeta(task) {
  const parts = [];
  if (task.variants.length) parts.push(task.variants.join(', '));
  parts.push(task.quantity + ' pcs');
  parts.push(task.payment || 'pembayaran default');
  const meta = h('div', { class: 'task-meta' }, parts.join(' · ') + ' · ');
  meta.append(task.maxPrice ? 'maks ' + FB.formatRupiah(task.maxPrice) : h('span', { class: 'warn', text: 'tanpa harga maksimal' }));
  return meta;
}

function taskRow(task) {
  const run = activeRunForTask(task.id);
  const title = h('div', { class: 'task-title' }, h('span', { class: 'task-name', text: task.name }));
  if (run) title.append(h('span', { class: 'tag live' }, h('span', { class: 'dot' }), 'Berjalan'));
  else if (!task.enabled) title.append(h('span', { class: 'tag', text: 'Nonaktif' }));
  title.append(FB.ui.modeTag(task));

  let last = null;
  if (task.lastRun) {
    const st = FB.describeStatus(task.lastRun.status);
    last = h(
      'div',
      { class: 'task-last' },
      FB.ui.statusIcon(task.lastRun.status, 14),
      h('span', {}, st.label + (task.lastRun.kind === 'test' ? ' (uji)' : '') + (task.lastRun.message ? ': ' + task.lastRun.message : '')),
    );
  }

  const toggle = h('input', {
    type: 'checkbox',
    'aria-label': 'Jadwal aktif',
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

  const upcoming = task.enabled && task.saleTime > serverNow();
  return h(
    'article',
    { class: 'task' + (task.enabled ? '' : ' disabled'), dataset: { task: task.id } },
    h(
      'div',
      { class: 'task-when' },
      h('span', { class: 'day', text: FB.ui.dayLabel(task.saleTime) }),
      h('time', { text: FB.ui.clock(task.saleTime), title: FB.formatDateTime(task.saleTime) }),
      upcoming ? h('span', { class: 'countdown', dataset: { countdown: task.saleTime, prefix: '−' } }) : null,
    ),
    h(
      'div',
      { class: 'task-body' },
      title,
      taskMeta(task),
      last,
    ),
    h(
      'div',
      { class: 'task-controls' },
      h('label', { class: 'switch', title: 'Jadwal aktif' }, toggle, h('span')),
      h('button', { class: 'btn sm', type: 'button', disabled: Boolean(run), title: 'Jalankan semua langkah sekarang tanpa membuat pesanan', onclick: () => testTask(task) }, FB.icon('play', 13), 'Uji'),
      iconButton('edit', 'Edit', () => openForm(task), { disabled: Boolean(run) }),
      iconButton('trash', 'Hapus', () => deleteTask(task), { disabled: Boolean(run), cls: 'quiet danger' }),
    ),
  );
}

function renderTasks() {
  const list = $('#task-list');
  list.replaceChildren();
  const tasks = state.tasks
    .slice()
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.saleTime || 0) - (b.saleTime || 0));
  for (const task of tasks) list.append(taskRow(task));
  $('#empty').hidden = tasks.length > 0 || !$('#task-form').hidden;

  const enabled = state.tasks.filter((t) => t.enabled).length;
  $('#nav-count').textContent = enabled ? String(enabled) : '';
  $('#tasks-summary').textContent = state.tasks.length
    ? enabled + ' terjadwal dari ' + state.tasks.length + ' task.'
    : 'Produk yang dibeli otomatis saat flash sale dimulai.';
}

// ── Riwayat ───────────────────────────────────────────────────────────────────

function historyItem(run) {
  const st = FB.describeStatus(run.status);
  const kind = run.kind === 'test' ? 'Uji sekarang' : run.dryRun ? 'Terjadwal · uji coba' : 'Terjadwal';
  const start = run.startedAt || (run.steps && run.steps[0] ? run.steps[0].at : 0);
  const steps = (run.steps || []).map((s) =>
    h('li', {}, h('time', { text: '+' + Math.max(0, s.at - start) + ' ms', title: FB.ui.clock(s.at) }), h('span', { text: s.msg })),
  );
  const failed = run.status !== 'success' && run.status !== 'dry_run_ok';
  return h(
    'article',
    { class: 'history-item' },
    h(
      'div',
      { class: 'history-head' },
      FB.ui.statusIcon(run.status, 16),
      h(
        'div',
        {},
        h('div', { class: 'history-title' }, h('strong', { text: run.taskName }), h('span', { class: 'tag', text: kind })),
        h('div', { class: 'history-msg' }, st.label + (run.message ? ' — ' + run.message : ''), Number.isFinite(run.total) ? ' · Total ' + FB.formatRupiah(run.total) : ''),
      ),
      h('time', { class: 'history-time', text: FB.ui.dayLabel(run.finishedAt || run.startedAt) + ' ' + FB.ui.clock(run.finishedAt || run.startedAt) }),
    ),
    h(
      'div',
      { class: 'history-body' },
      run.notifyError ? h('div', { class: 'tone-bad', text: 'Notifikasi gagal: ' + run.notifyError }) : null,
      steps.length ? h('details', {}, h('summary', {}, FB.icon('chevron', 14), 'Detail langkah (' + steps.length + ')'), h('ol', { class: 'steps' }, steps)) : null,
      h(
        'div',
        { class: 'history-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => copyReport(run) }, FB.icon('copy', 13), 'Salin laporan'),
        failed ? h('a', { class: 'btn sm quiet', href: ISSUE_URL, target: '_blank', rel: 'noopener' }, FB.icon('external', 13), 'Laporkan masalah') : null,
      ),
    ),
  );
}

function renderHistory() {
  const list = $('#history-list');
  list.replaceChildren(...state.runs.map(historyItem));
  $('#history-empty').hidden = state.runs.length > 0;
  $('#btn-clear-history').hidden = state.runs.length === 0;
}

function browserLabel() {
  const m = navigator.userAgent.match(/Chrome\/(\d+)/);
  return (m ? 'Chrome ' + m[1] : 'Chromium') + ' · ' + (navigator.platform || '-');
}

async function copyReport(run) {
  const text = FB.buildRunReport(run, { version: chrome.runtime.getManifest().version, browser: browserLabel() });
  try {
    await navigator.clipboard.writeText(text);
    toast('Laporan disalin. Tempel di GitHub Issue.', 'good');
  } catch (_) {
    toast('Gagal menyalin ke clipboard.', 'bad');
  }
}

// ── Render umum ───────────────────────────────────────────────────────────────

function renderAll() {
  renderHero();
  renderWarnings();
  renderTasks();
  renderHistory();
  tick();
}

function tick() {
  const now = serverNow();
  FB.ui.tickCountdowns(now);
  $('#server-clock').textContent = FB.ui.clock(now);
}

// ── Form task ─────────────────────────────────────────────────────────────────

function setFieldErrors(errors) {
  for (const field of $$('#task-form [data-field]')) {
    const msg = (errors && errors[field.dataset.field]) || '';
    field.classList.toggle('invalid', Boolean(msg));
    $('.error', field).textContent = msg;
  }
}

function nextOccurrence(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now() + 60000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function isDryRun() {
  return !$('#f-mode-buy').checked;
}

function updateUrlPreview() {
  const value = $('#f-url').value.trim();
  const preview = $('#url-preview');
  preview.classList.remove('ok');
  if (!value) {
    preview.textContent = 'Salin dari address bar saat membuka halaman produk.';
    return;
  }
  const parsed = FB.parseProductUrl(value);
  preview.textContent = parsed.ok ? 'Produk: ' + (FB.productNameFromUrl(parsed.url) || 'ID ' + parsed.itemId) : parsed.error;
  preview.classList.toggle('ok', parsed.ok);
}

function formatPriceInput() {
  const input = $('#f-maxprice');
  const digits = input.value.replace(/[^\d]/g, '');
  input.value = digits ? FB.formatRupiah(Number(digits)).replace('Rp', '') : '';
}

/** Kalimat ringkasan "apa yang akan dilakukan bot" di bawah form. */
function updateSummary() {
  const out = $('#form-summary');
  const parsed = FB.parseProductUrl($('#f-url').value);
  const time = FB.fromDatetimeLocal($('#f-time').value);
  if (!parsed.ok || time == null) {
    out.textContent = '';
    return;
  }
  const name = $('#f-name').value.trim() || FB.productNameFromUrl(parsed.url) || 'produk ini';
  const qty = Math.max(1, parseInt($('#f-qty').value, 10) || 1);
  const variants = FB.splitList($('#f-variants').value, ',');
  const payment = FB.splitList($('#f-payment').value, '>').join(' › ');
  const max = Number($('#f-maxprice').value.replace(/[^\d]/g, ''));
  const b = (text) => h('b', { text });

  out.replaceChildren(
    isDryRun() ? 'Uji ' : 'Beli ',
    b(qty + '× ' + name),
    variants.length ? ' (' + variants.join(', ') + ')' : '',
    ' pada ',
    b(FB.formatDateTime(time)),
    payment ? ', bayar dengan ' : ', pembayaran default',
    payment ? b(payment) : '',
    max ? ', batal bila total lebih dari ' : '. Tanpa batas harga.',
    max ? b(FB.formatRupiah(max)) : '',
    max ? '.' : '',
    isDryRun() ? ' Berhenti sebelum Buat Pesanan.' : ' Pesanan akan benar-benar dibuat.',
  );
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
  $(task && !task.dryRun ? '#f-mode-buy' : '#f-mode-test').checked = true;
  const time = task && task.saleTime > Date.now() ? task.saleTime : nextOccurrence(12);
  $('#f-time').value = FB.toDatetimeLocal(time);
  updateUrlPreview();
  updateSummary();
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
    dryRun: isDryRun(),
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
      'Mode Beli sungguhan.\n\nBot akan BENAR-BENAR membuat pesanan saat flash sale dimulai. ' +
        'Pastikan sudah mencoba “Uji” dan harga maksimal sudah diisi.\n\nLanjutkan?',
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
  toast('Tersimpan. Berjalan otomatis ' + FB.formatDateTime(res.task.saleTime) + '.', 'good');
}

async function testTask(task) {
  const res = await send('ui:testTask', { id: task.id });
  if (res.ok) toast('Uji dimulai di tab baru. Pesanan tidak akan dibuat.', 'good');
  else toast(res.error || 'Gagal memulai uji.', 'bad');
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
  if (res.ok) toast('Notifikasi disimpan.', 'good');
  else toast(res.error || 'Gagal menyimpan.', 'bad');
}

async function testTelegram() {
  const btn = $('#btn-test-telegram');
  btn.disabled = true;
  const res = await send('ui:testTelegram', { telegram: notifyFormValues() });
  btn.disabled = false;
  if (res.ok) toast('Pesan tes terkirim. Cek Telegram kamu.', 'good');
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

function toggleToken() {
  const input = $('#n-token');
  const btn = $('#btn-show-token');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.replaceChildren(FB.icon(show ? 'eyeOff' : 'eye', 16));
  btn.setAttribute('aria-label', show ? 'Sembunyikan token' : 'Lihat token');
}

// ── Lanjutan ──────────────────────────────────────────────────────────────────

function buildTextFields() {
  $('#texts-grid').replaceChildren(
    ...TEXT_FIELDS.map(([key, label]) =>
      h('label', { class: 'field' }, h('span', { class: 'label', text: label }), h('textarea', { id: 't-' + key, rows: 3, spellcheck: 'false' })),
    ),
  );
}

function fillAdvancedForm() {
  const s = state.settings;
  $('#a-lead').value = s.leadSeconds;
  $('#a-delay').value = s.reloadDelayMs;
  $('#a-reloads').value = s.maxReloads;
  $('#a-timeout').value = Math.round(s.stepTimeoutMs / 1000);
  $('#a-timesync').checked = s.timeSync;
  for (const [key] of TEXT_FIELDS) {
    const lines = s.texts[key] || [];
    const area = $('#t-' + key);
    area.value = lines.join('\n');
    area.rows = Math.max(3, lines.length + 1);
  }
  renderTimeSync();
}

function renderTimeSync(text) {
  const sync = state.timeSync;
  $('#time-result').textContent =
    text || (sync ? FB.describeOffset(sync) + ' Dicek ' + FB.formatDateTime(sync.at) + '.' : 'Bot memakai jam server, jadi jam komputer yang meleset tidak masalah.');
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
  for (const item of $$('.nav-item')) item.addEventListener('click', () => showView(item.dataset.view));
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
      $('.error', field).textContent = '';
    }
    updateSummary();
  });
  $('#task-form').addEventListener('change', updateSummary);
  $('#f-maxprice').addEventListener('blur', formatPriceInput);

  $('#tz-hint').textContent = timeZoneLabel();
  $('#quick-times').replaceChildren(
    ...QUICK_HOURS.map((hour) =>
      h('button', {
        type: 'button',
        text: String(hour).padStart(2, '0') + ':00',
        onclick: () => {
          $('#f-time').value = FB.toDatetimeLocal(nextOccurrence(hour));
          updateSummary();
        },
      }),
    ),
  );

  $('#notify-form').addEventListener('submit', saveNotify);
  $('#btn-test-telegram').addEventListener('click', testTelegram);
  $('#btn-detect-chat').addEventListener('click', detectChat);
  $('#btn-show-token').addEventListener('click', toggleToken);

  $('#advanced-form').addEventListener('submit', saveAdvanced);
  $('#btn-reset-texts').addEventListener('click', resetTexts);
  $('#btn-check-time').addEventListener('click', checkTime);

  $('#btn-clear-history').addEventListener('click', async () => {
    if (!state.runs.length || !confirm('Hapus semua riwayat?')) return;
    await send('ui:clearHistory');
  });
}

async function init() {
  FB.hydrateIcons();
  $('#version').textContent = 'v' + chrome.runtime.getManifest().version;
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
  setInterval(tick, 250);
  document.body.dataset.ready = 'true';
}

init();
