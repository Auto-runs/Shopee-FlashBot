/*
 * background.js — service worker FlashBot.
 *
 * Tugas:
 *  • Menjadwalkan task (chrome.alarms + timer presisi saat mendekati waktu).
 *  • Membuka tab produk sebelum flash sale, lalu memuat ulang tepat di T=0
 *    berdasarkan jam server Shopee (header HTTP Date).
 *  • Menjadi "sumber kebenaran" status run; content script bertanya
 *    "apa tugas saya?" setiap kali halaman berganti.
 *  • Mendeteksi hasil (pindah dari halaman checkout = pesanan dibuat),
 *    menyimpan riwayat, dan mengirim notifikasi Telegram.
 *
 * Semua perubahan state dilakukan sinkron di memori lalu disimpan ke
 * chrome.storage.local secara berurutan, jadi tidak ada race antar handler.
 */
importScripts('lib/core.js');

const S = {
  settings: FB.mergeSettings(),
  tasks: [],
  runs: [],
  active: {},
  timeSync: null,
  lastNotifyError: null,
};

const armTimers = new Map(); // taskId → timeout (hanya bila waktu arm sudah dekat)
const fireTimers = new Map(); // runId  → timeout menuju T=0
const startingTasks = new Set();
let syncInFlight = null;
let persistChain = Promise.resolve();

const PRECISE_ARM_WINDOW_MS = 5 * 60 * 1000;
const PREWAKE_MS = 4 * 60 * 1000;

// ── Penyimpanan ───────────────────────────────────────────────────────────────

function persist() {
  persistChain = persistChain
    .then(() =>
      chrome.storage.local.set({
        settings: S.settings,
        tasks: S.tasks,
        runs: S.runs,
        active: S.active,
        timeSync: S.timeSync,
        lastNotifyError: S.lastNotifyError,
      }),
    )
    .catch((err) => console.warn('[FlashBot] gagal menyimpan state', err));
  updateBadge();
  return persistChain;
}

const ready = (async () => {
  const d = await chrome.storage.local.get(['settings', 'tasks', 'runs', 'active', 'timeSync', 'lastNotifyError']);
  S.settings = FB.mergeSettings(d.settings);
  S.tasks = Array.isArray(d.tasks) ? d.tasks : [];
  S.runs = Array.isArray(d.runs) ? d.runs : [];
  S.active = d.active && typeof d.active === 'object' ? d.active : {};
  S.timeSync = d.timeSync || null;
  S.lastNotifyError = d.lastNotifyError || null;
  await recoverActiveRuns();
  reconcileAll();
  chrome.alarms.create('watchdog', { periodInMinutes: 0.5 });
  persist();
  refreshTimeSync(10 * 60 * 1000);
})();

// ── Util ──────────────────────────────────────────────────────────────────────

function findTask(id) {
  return S.tasks.find((t) => t.id === id) || null;
}

function runForTab(tabId) {
  if (tabId == null) return null;
  return Object.values(S.active).find((r) => r.tabId === tabId) || null;
}

function runForTask(taskId) {
  return Object.values(S.active).find((r) => r.taskId === taskId) || null;
}

function serverNow(run) {
  return Date.now() + ((run && run.offsetMs) || 0);
}

function addStep(run, msg) {
  if (!msg) return;
  run.steps.push({ at: Date.now(), msg: String(msg).slice(0, 300) });
  if (run.steps.length > FB.STEP_LIMIT) run.steps.splice(0, run.steps.length - FB.STEP_LIMIT);
}

function log(run, msg) {
  addStep(run, msg);
  persist();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function updateBadge() {
  const active = Object.keys(S.active).length;
  const scheduled = S.tasks.filter((t) => t.enabled).length;
  const text = active ? 'ON' : scheduled ? String(scheduled) : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: active ? '#ee4d2d' : '#555555' }).catch(() => {});
}

// Service worker MV3 dimatikan setelah ±30 detik idle. Memanggil API extension
// secara berkala menjaga worker tetap hidup selama ada run / jadwal yang dekat.
setInterval(() => {
  if (Object.keys(S.active).length || armTimers.size) chrome.runtime.getPlatformInfo().catch(() => {});
}, 20000);

// ── Sinkronisasi jam ──────────────────────────────────────────────────────────

async function sampleServerClock() {
  const samples = [];
  let failures = 0;
  const started = Date.now();
  while (samples.length < 15 && Date.now() - started < 3000 && failures < 3) {
    const t0 = Date.now();
    try {
      const res = await fetch('https://shopee.co.id/', { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
      const t1 = Date.now();
      const server = Date.parse(res.headers.get('date') || '');
      if (Number.isFinite(server)) samples.push({ t0, t1, server });
      else failures++;
    } catch (_) {
      failures++;
    }
    const span = samples.length ? samples[samples.length - 1].t1 - samples[0].t0 : 0;
    if (samples.length >= 6 && span > 1100) break;
    await sleep(80);
  }
  return samples;
}

/** Hitung selisih jam komputer vs server Shopee. Hasil di-cache 30 detik. */
async function syncTime(force) {
  if (!force && S.timeSync && S.timeSync.source === 'shopee' && Date.now() - S.timeSync.at < 30000) {
    return S.timeSync;
  }
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const samples = await sampleServerClock();
    const est = samples.length >= 3 ? FB.estimateOffset(samples) : null;
    S.timeSync = est
      ? { offsetMs: est.offsetMs, errorMs: est.errorMs, samples: est.samples, source: 'shopee', at: Date.now() }
      : {
          offsetMs: 0,
          errorMs: null,
          samples: samples.length,
          source: 'local',
          at: Date.now(),
          error: 'Gagal membaca jam server Shopee — memakai jam komputer.',
        };
    persist();
    return S.timeSync;
  })();
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

// ── Notifikasi ────────────────────────────────────────────────────────────────

async function notify(text) {
  const tg = S.settings.telegram;
  if (!tg.enabled || !tg.botToken || !tg.chatId) return { ok: false, skipped: true };
  const res = await FB.sendTelegram(fetch, tg, text);
  S.lastNotifyError = res.ok ? null : { at: Date.now(), error: res.error };
  persist();
  return res;
}

// ── Penjadwalan ───────────────────────────────────────────────────────────────

function clearArm(taskId) {
  clearTimeout(armTimers.get(taskId));
  armTimers.delete(taskId);
  chrome.alarms.clear('arm:' + taskId).catch(() => {});
  chrome.alarms.clear('prewake:' + taskId).catch(() => {});
}

/** Selisih jam server − komputer yang terakhir diketahui (0 bila sinkron dimatikan). */
function knownOffset() {
  return S.settings.timeSync && S.timeSync ? S.timeSync.offsetMs || 0 : 0;
}

function reconcileTask(task) {
  clearArm(task.id);
  if (runForTask(task.id)) return;
  // Jadwal task memakai jam server Shopee; alarm Chrome memakai jam komputer.
  const offset = knownOffset();
  const now = Date.now() + offset;
  const decision = FB.scheduleDecision(task, now, S.settings);
  if (decision.action === 'missed') {
    markMissed(task);
  } else if (decision.action === 'arm_now') {
    startRun(task.id, 'scheduled');
  } else if (decision.action === 'schedule') {
    const delay = decision.armAt - now;
    chrome.alarms.create('arm:' + task.id, { when: decision.armAt - offset });
    if (delay > PRECISE_ARM_WINDOW_MS) {
      chrome.alarms.create('prewake:' + task.id, { when: decision.armAt - offset - PREWAKE_MS });
    } else {
      armTimers.set(task.id, setTimeout(() => onArmDue(task.id), delay));
    }
  }
}

function reconcileAll() {
  for (const task of S.tasks) reconcileTask(task);
  updateBadge();
}

/**
 * Perbarui selisih jam bila sudah basi, lalu hitung ulang jadwal bila
 * selisihnya berubah cukup besar. Dipanggil saat task disimpan / menjelang arm.
 */
async function refreshTimeSync(maxAgeMs) {
  if (!S.settings.timeSync || !S.tasks.some((t) => t.enabled)) return;
  const fresh = S.timeSync && S.timeSync.source === 'shopee' && Date.now() - S.timeSync.at < maxAgeMs;
  if (fresh) return;
  const before = knownOffset();
  await syncTime(true);
  if (Math.abs(knownOffset() - before) > 250) reconcileAll();
}

function onArmDue(taskId) {
  clearArm(taskId);
  const task = findTask(taskId);
  if (task && task.enabled && !runForTask(taskId)) startRun(taskId, 'scheduled');
}

function markMissed(task) {
  const now = Date.now();
  const record = {
    id: FB.makeId('run'),
    taskId: task.id,
    taskName: task.name,
    kind: 'scheduled',
    dryRun: task.dryRun,
    status: 'missed',
    message: 'Browser/komputer tidak aktif saat flash sale dimulai.',
    saleTime: task.saleTime,
    startedAt: now,
    finishedAt: now,
    steps: [],
  };
  task.enabled = false;
  task.lastRun = { status: 'missed', message: record.message, at: now, runId: record.id, kind: 'scheduled' };
  pushHistory(record);
  persist();
  notify(FB.buildRunMessage(record));
}

function pushHistory(record) {
  S.runs.unshift(record);
  if (S.runs.length > FB.HISTORY_LIMIT) S.runs.length = FB.HISTORY_LIMIT;
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function startRun(taskId, kind) {
  const task = findTask(taskId);
  if (!task) return { ok: false, error: 'Task tidak ditemukan.' };
  if (runForTask(taskId) || startingTasks.has(taskId)) return { ok: false, error: 'Task ini sedang berjalan.' };
  startingTasks.add(taskId);
  try {
    clearArm(taskId);
    const sync = S.settings.timeSync ? await syncTime(false) : { offsetMs: 0, source: 'off' };
    // Pakai batas bawah perkiraan selisih jam: lebih baik terlambat beberapa ms
    // daripada memuat ulang sebelum flash sale benar-benar dimulai.
    const offsetMs = (sync.offsetMs || 0) - (sync.source === 'shopee' ? sync.errorMs || 0 : 0);
    const isTest = kind === 'test';
    const saleTime = isTest ? Date.now() + offsetMs : task.saleTime;
    const late = !isTest && Date.now() + offsetMs >= saleTime + S.settings.reloadDelayMs;

    const tab = await chrome.tabs.create({ url: task.url, active: true });
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});

    const run = {
      id: FB.makeId('run'),
      taskId: task.id,
      taskName: task.name,
      kind: isTest ? 'test' : 'scheduled',
      dryRun: isTest || task.dryRun,
      task: {
        url: task.url,
        variants: task.variants.slice(),
        quantity: task.quantity,
        payment: task.payment,
        maxPrice: task.maxPrice,
      },
      tabId: tab.id,
      phase: isTest || late ? 'buying' : 'armed',
      saleTime,
      offsetMs,
      reloads: 0,
      total: null,
      lastUrl: task.url,
      startedAt: Date.now(),
      steps: [],
    };
    S.active[run.id] = run;

    if (isTest) addStep(run, 'Uji sekarang dimulai — pesanan TIDAK akan dibuat.');
    else addStep(run, 'Tab produk dibuka. Flash sale: ' + FB.formatDateTime(saleTime));
    if (S.settings.timeSync) addStep(run, FB.describeOffset(sync));
    if (late) addStep(run, 'Waktu flash sale sudah lewat — langsung mencoba membeli.');
    persist();

    if (run.phase === 'armed') {
      scheduleFire(run);
      if (S.settings.notifyOnArm) notify(FB.buildArmMessage(run, task));
    }
    return { ok: true, runId: run.id };
  } catch (err) {
    return { ok: false, error: 'Gagal memulai: ' + (err && err.message ? err.message : err) };
  } finally {
    startingTasks.delete(taskId);
  }
}

/** Timer presisi menuju T=0 (+ jeda reload), memakai jam server. */
function scheduleFire(run) {
  clearTimeout(fireTimers.get(run.id));
  const target = run.saleTime + S.settings.reloadDelayMs;
  const tick = () => {
    const current = S.active[run.id];
    if (!current || current.phase !== 'armed') return;
    const remaining = target - serverNow(current);
    if (remaining > 40) {
      fireTimers.set(run.id, setTimeout(tick, Math.min(remaining - 30, 15000)));
      return;
    }
    // Sisa ≤ 40 ms: tunggu aktif agar presisi (setTimeout bisa meleset beberapa ms).
    while (target - serverNow(current) > 0) {
      /* spin */
    }
    fire(current);
  };
  tick();
}

function fire(run) {
  fireTimers.delete(run.id);
  if (!S.active[run.id] || run.phase !== 'armed') return;
  run.phase = 'buying';
  run.firedAt = Date.now();
  const onProduct = FB.sameProduct(run.lastUrl, run.task.url);
  const nav = onProduct
    ? chrome.tabs.reload(run.tabId, { bypassCache: true })
    : chrome.tabs.update(run.tabId, { url: run.task.url });
  addStep(run, 'T=0 — memuat ulang halaman produk');
  persist();
  nav.catch((err) => finishRun(run.id, 'cancelled', 'Tab Shopee tidak bisa dimuat ulang: ' + err.message));
}

/** Selesaikan run (idempoten). Notifikasi dikirim di latar belakang. */
function finishRun(runId, status, message, extra) {
  const run = S.active[runId];
  if (!run) return false;
  delete S.active[runId];
  clearTimeout(fireTimers.get(runId));
  fireTimers.delete(runId);

  run.status = status;
  run.message = message || '';
  run.finishedAt = Date.now();
  if (extra && Number.isFinite(extra.total)) run.total = extra.total;
  addStep(run, FB.describeStatus(status).label + (message ? ' — ' + message : ''));
  pushHistory(run);

  const task = findTask(run.taskId);
  if (task) {
    task.lastRun = { status, message: run.message, at: run.finishedAt, runId: run.id, kind: run.kind };
    if (run.kind === 'scheduled') task.enabled = false;
  }
  persist();
  if (task) reconcileTask(task);

  notify(FB.buildRunMessage(run)).then((res) => {
    if (!res.ok && !res.skipped) {
      run.notifyError = res.error;
      persist();
    }
  });
  return true;
}

async function recoverActiveRuns() {
  for (const run of Object.values(S.active)) {
    let tabOk = true;
    try {
      await chrome.tabs.get(run.tabId);
    } catch (_) {
      tabOk = false;
    }
    if (!tabOk) {
      finishRun(run.id, 'cancelled', 'Tab Shopee tertutup atau browser dimulai ulang sebelum selesai.');
    } else if (run.phase === 'armed') {
      scheduleFire(run);
    }
  }
}

function watchdog() {
  const now = Date.now();
  for (const run of Object.values(S.active)) {
    if (run.phase === 'armed' && !fireTimers.has(run.id)) scheduleFire(run);
    if (now + (run.offsetMs || 0) > run.saleTime + FB.RUN_TIMEOUT_MS) {
      const label = FB.PHASE_LABELS[run.phase] || run.phase;
      if (run.phase === 'placing') {
        finishRun(run.id, 'unknown', 'Tidak ada konfirmasi setelah klik "Buat Pesanan". Cek menu Pesanan Saya.');
      } else {
        finishRun(run.id, 'failed', 'Waktu habis di tahap: ' + label + '.');
      }
    }
  }
}

// ── Pesan dari content script ─────────────────────────────────────────────────

function ownRun(msg, sender) {
  const run = S.active[msg.runId];
  if (!run || !sender.tab || run.tabId !== sender.tab.id) return null;
  return run;
}

const CONTENT_STATUSES = ['failed', 'dry_run_ok', 'unknown'];
const PHASES = ['buying', 'to_checkout', 'cart', 'checkout', 'placing'];

function handleContent(msg, sender) {
  switch (msg.type) {
    case 'getJob': {
      const run = runForTab(sender.tab && sender.tab.id);
      if (!run) return null;
      return {
        run: {
          id: run.id,
          kind: run.kind,
          phase: run.phase,
          saleTime: run.saleTime,
          offsetMs: run.offsetMs,
          dryRun: run.dryRun,
          reloads: run.reloads,
          task: run.task,
        },
        settings: {
          texts: S.settings.texts,
          stepTimeoutMs: S.settings.stepTimeoutMs,
          maxReloads: S.settings.maxReloads,
        },
      };
    }
    case 'log': {
      const run = ownRun(msg, sender);
      if (!run) return { ok: false };
      log(run, msg.msg);
      return { ok: true };
    }
    case 'setPhase': {
      const run = ownRun(msg, sender);
      if (!run || !PHASES.includes(msg.phase)) return { ok: false };
      run.phase = msg.phase;
      if (msg.extra && Number.isFinite(msg.extra.total)) run.total = msg.extra.total;
      addStep(run, msg.msg);
      persist();
      return { ok: true };
    }
    case 'retryReload': {
      const run = ownRun(msg, sender);
      if (!run) return { allowed: false };
      if (run.reloads >= S.settings.maxReloads) return { allowed: false, reloads: run.reloads };
      run.reloads += 1;
      addStep(run, (msg.reason || 'Muat ulang') + ' — muat ulang ' + run.reloads + '/' + S.settings.maxReloads);
      persist();
      return { allowed: true, reloads: run.reloads, max: S.settings.maxReloads };
    }
    case 'finish': {
      const run = ownRun(msg, sender);
      if (!run || !CONTENT_STATUSES.includes(msg.status)) return { ok: false };
      finishRun(run.id, msg.status, msg.message, msg.extra);
      return { ok: true };
    }
    default:
      return undefined;
  }
}

// ── Pesan dari halaman pengaturan / popup ─────────────────────────────────────

async function handleUi(msg) {
  switch (msg.type) {
    case 'ui:saveTask': {
      const input = msg.task || {};
      if (input.id && runForTask(input.id)) return { ok: false, error: 'Task sedang berjalan — batalkan dulu sebelum mengubah.' };
      const existing = input.id ? findTask(input.id) : null;
      const { ok, task, errors } = FB.validateTask(
        { ...input, createdAt: existing && existing.createdAt, lastRun: existing && existing.lastRun },
        { allowPast: input.enabled === false },
      );
      if (!ok) return { ok: false, errors };
      if (existing) Object.assign(existing, task);
      else S.tasks.push(task);
      persist();
      reconcileTask(existing || task);
      // Sinkron jam di latar belakang; jadwal dihitung ulang bila selisihnya berubah.
      refreshTimeSync(10 * 60 * 1000);
      return { ok: true, task: existing || task };
    }
    case 'ui:deleteTask': {
      if (runForTask(msg.id)) return { ok: false, error: 'Task sedang berjalan — batalkan dulu.' };
      clearArm(msg.id);
      S.tasks = S.tasks.filter((t) => t.id !== msg.id);
      persist();
      return { ok: true };
    }
    case 'ui:toggleTask': {
      const task = findTask(msg.id);
      if (!task) return { ok: false, error: 'Task tidak ditemukan.' };
      if (runForTask(task.id)) return { ok: false, error: 'Task sedang berjalan.' };
      if (msg.enabled && !(task.saleTime > Date.now())) {
        return { ok: false, error: 'Waktu flash sale sudah lewat — ubah jadwalnya dulu.' };
      }
      task.enabled = Boolean(msg.enabled);
      task.updatedAt = Date.now();
      persist();
      reconcileTask(task);
      if (task.enabled) refreshTimeSync(10 * 60 * 1000);
      return { ok: true };
    }
    case 'ui:testTask':
      return startRun(msg.id, 'test');
    case 'ui:cancelRun':
      return { ok: finishRun(msg.runId, 'cancelled', 'Dibatalkan oleh pengguna.') };
    case 'ui:saveSettings': {
      const incoming = msg.settings || {};
      S.settings = FB.mergeSettings({
        ...S.settings,
        ...incoming,
        telegram: { ...S.settings.telegram, ...(incoming.telegram || {}) },
        texts: incoming.texts ? { ...S.settings.texts, ...incoming.texts } : S.settings.texts,
      });
      persist();
      reconcileAll();
      return { ok: true, settings: S.settings };
    }
    case 'ui:resetTexts': {
      S.settings = FB.mergeSettings({ ...S.settings, texts: FB.DEFAULT_TEXTS });
      persist();
      return { ok: true, settings: S.settings };
    }
    case 'ui:testTelegram': {
      const tg = { ...S.settings.telegram, ...(msg.telegram || {}) };
      const res = await FB.sendTelegram(
        fetch,
        tg,
        '🔔 <b>Tes notifikasi FlashBot berhasil!</b>\nKamu akan menerima kabar di sini saat task berjalan.',
      );
      return res;
    }
    case 'ui:detectChat':
      return FB.detectTelegramChat(fetch, String(msg.botToken || S.settings.telegram.botToken || '').trim());
    case 'ui:checkTime': {
      const sync = await syncTime(true);
      return { ok: true, sync, text: FB.describeOffset(sync) };
    }
    case 'ui:clearHistory':
      S.runs = [];
      persist();
      return { ok: true };
    default:
      return { ok: false, error: 'Perintah tidak dikenal: ' + msg.type };
  }
}

// ── Listener (harus didaftarkan sinkron di top level) ─────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  (async () => {
    await ready;
    if (msg.type.startsWith('ui:')) return handleUi(msg);
    return handleContent(msg, sender);
  })()
    .then((res) => sendResponse(res === undefined ? null : res))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === 'watchdog') {
    watchdog();
    return;
  }
  const [kind, taskId] = alarm.name.split(':');
  const task = findTask(taskId);
  if (!task) return;
  if (kind === 'arm') onArmDue(taskId);
  else if (kind === 'prewake') {
    await refreshTimeSync(60 * 1000);
    reconcileTask(task);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  await ready;
  const run = runForTab(tabId);
  if (!run) return;
  if (info.url) run.lastUrl = info.url;
  const url = info.url || (info.status === 'loading' ? tab.url : undefined);

  const type = url ? FB.pageType(url) : null;

  if (run.phase === 'placing') {
    // Setelah klik "Buat Pesanan": pindah ke halaman pembayaran / pesanan = berhasil.
    const leftShopee = info.status === 'loading' && !url; // domain lain (mis. gerbang pembayaran)
    if (leftShopee || type === 'other' || type === 'external') {
      finishRun(run.id, 'success', 'Pesanan dibuat — lanjutkan pembayaran di tab Shopee.', { total: run.total });
    } else if (type === 'login' || type === 'verify') {
      finishRun(
        run.id,
        'unknown',
        'Shopee meminta ' + (type === 'login' ? 'login' : 'verifikasi') +
          ' setelah klik "Buat Pesanan". Selesaikan di tab Shopee untuk melanjutkan pesanan.',
        { total: run.total },
      );
    } else if (type === 'cart' || type === 'product') {
      finishRun(
        run.id,
        'unknown',
        'Setelah klik "Buat Pesanan", Shopee kembali ke halaman ' + (type === 'cart' ? 'keranjang' : 'produk') +
          '. Cek menu Pesanan Saya.',
        { total: run.total },
      );
    }
    return;
  }

  if (type && run.phase !== 'armed') {
    if (type === 'login') {
      finishRun(run.id, 'failed', 'Shopee meminta login. Login dulu di tab ini, lalu jalankan ulang task.');
    } else if (type === 'verify') {
      finishRun(run.id, 'failed', 'Shopee meminta verifikasi (captcha). Selesaikan manual, lalu jalankan ulang task.');
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const run = runForTab(tabId);
  if (run) finishRun(run.id, 'cancelled', 'Tab Shopee ditutup sebelum selesai.');
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  /* membangunkan worker; `ready` menangani pemulihan & penjadwalan ulang */
});

// Untuk pengujian otomatis.
self.__flashbot = { S, ready, startRun, syncTime, handleUi, finishRun, reconcileAll };
