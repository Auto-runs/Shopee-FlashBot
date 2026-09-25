/*
 * core.js — logika murni FlashBot (tanpa DOM, tanpa chrome.*).
 *
 * Dipakai bersama oleh service worker (importScripts), content script,
 * halaman pengaturan/popup, dan unit test Node (require).
 */
(function (root) {
  'use strict';

  const FB = root.FB || (root.FB = {});

  // ── Konstanta ───────────────────────────────────────────────────────────────

  const SHOPEE_HOSTS = ['shopee.co.id', 'www.shopee.co.id'];

  // Setelah waktu flash sale lewat selama ini tanpa run berjalan → dianggap terlewat.
  const MISS_GRACE_MS = 2 * 60 * 1000;

  // Run yang belum selesai selama ini setelah T=0 → dihentikan oleh watchdog.
  const RUN_TIMEOUT_MS = 4 * 60 * 1000;

  const HISTORY_LIMIT = 50;
  const STEP_LIMIT = 60;

  const DEFAULT_TEXTS = {
    buyNow: ['beli sekarang', 'buy now'],
    cartCheckout: ['checkout'],
    placeOrder: ['buat pesanan', 'place order'],
    soldOut: ['stok habis', 'habis terjual', 'sold out', 'produk tidak tersedia', 'barang tidak tersedia'],
    notStarted: ['dimulai dalam', 'segera dimulai'],
    totalLabel: ['total pembayaran', 'total payment'],
    quantityLabel: ['kuantitas', 'quantity', 'jumlah'],
  };

  // Daftar teks yang boleh dikosongkan pengguna (untuk mematikan pengecekan).
  const OPTIONAL_TEXT_KEYS = ['soldOut', 'notStarted'];

  const DEFAULT_SETTINGS = {
    leadSeconds: 60,
    reloadDelayMs: 100,
    maxReloads: 3,
    stepTimeoutMs: 15000,
    timeSync: true,
    notifyOnArm: true,
    telegram: { enabled: false, botToken: '', chatId: '' },
    texts: DEFAULT_TEXTS,
  };

  const SETTING_LIMITS = {
    leadSeconds: [5, 900],
    reloadDelayMs: [0, 5000],
    maxReloads: [0, 10],
    stepTimeoutMs: [3000, 60000],
  };

  const STATUS = {
    success: { label: 'Pesanan berhasil dibuat', icon: '✅', tone: 'good' },
    dry_run_ok: { label: 'Uji coba berhasil (pesanan tidak dibuat)', icon: '🧪', tone: 'good' },
    failed: { label: 'Gagal', icon: '❌', tone: 'bad' },
    missed: { label: 'Terlewat', icon: '⏰', tone: 'bad' },
    cancelled: { label: 'Dibatalkan', icon: '⛔', tone: 'muted' },
    unknown: { label: 'Perlu dicek manual', icon: '⚠️', tone: 'warn' },
  };

  const PHASE_LABELS = {
    armed: 'Menunggu waktu flash sale',
    buying: 'Memilih varian & klik Beli Sekarang',
    to_checkout: 'Menuju checkout',
    cart: 'Di keranjang',
    checkout: 'Di halaman checkout',
    placing: 'Membuat pesanan',
  };

  // ── Teks ────────────────────────────────────────────────────────────────────

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Cocokkan teks dengan daftar pola (sudah/akan dinormalisasi).
   * mode 'exact'  : sama persis
   * mode 'prefix' : sama persis atau diawali pola (mis. "checkout (1)")
   * mode 'contains': mengandung pola
   * Mengembalikan skor (3 = exact, 2 = prefix, 1 = contains, 0 = tidak cocok).
   */
  function matchScore(text, patterns, mode) {
    const t = normalizeText(text);
    if (!t) return 0;
    let best = 0;
    for (const raw of patterns || []) {
      const p = normalizeText(raw);
      if (!p) continue;
      if (t === p) return 3;
      if ((mode === 'prefix' || mode === 'contains') && t.startsWith(p)) best = Math.max(best, 2);
      else if (mode === 'contains' && t.includes(p)) best = Math.max(best, 1);
    }
    return best;
  }

  function splitList(value, separator) {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    return String(value == null ? '' : value)
      .split(separator)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Harga ───────────────────────────────────────────────────────────────────

  /** "Rp1.234.567" → 1234567. Mengembalikan null bila tidak ada angka rupiah. */
  function parseRupiah(value) {
    const m = String(value == null ? '' : value).match(/rp\s*([\d][\d.,]*)/i);
    if (!m) return null;
    let digits = m[1].replace(/[.,]+$/, '');
    // Koma diikuti 1–2 digit di akhir = desimal (jarang di Shopee, tapi aman).
    digits = digits.replace(/,\d{1,2}$/, '');
    digits = digits.replace(/[.,]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  function formatRupiah(n) {
    if (n == null || !Number.isFinite(Number(n))) return '-';
    return 'Rp' + Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  // ── URL Shopee ──────────────────────────────────────────────────────────────

  function safeUrl(value) {
    try {
      return new URL(String(value).trim());
    } catch (_) {
      return null;
    }
  }

  function isShopeeHost(host) {
    return SHOPEE_HOSTS.includes(String(host || '').toLowerCase());
  }

  function productIds(pathname) {
    let m = pathname.match(/-i\.(\d+)\.(\d+)(?:[/?#]|$)/);
    if (m) return { shopId: m[1], itemId: m[2] };
    m = pathname.match(/^\/product\/(\d+)\/(\d+)(?:[/?#]|$)/);
    if (m) return { shopId: m[1], itemId: m[2] };
    return null;
  }

  /** Validasi & uraikan link produk Shopee Indonesia. */
  function parseProductUrl(value) {
    const u = safeUrl(value);
    if (!u || !/^https?:$/.test(u.protocol)) return { ok: false, error: 'Link tidak valid.' };
    if (!isShopeeHost(u.hostname)) return { ok: false, error: 'Link harus dari shopee.co.id.' };
    const ids = productIds(u.pathname);
    if (!ids) return { ok: false, error: 'Link ini bukan halaman produk Shopee.' };
    u.protocol = 'https:';
    u.hostname = 'shopee.co.id';
    u.hash = '';
    return { ok: true, url: u.toString(), shopId: ids.shopId, itemId: ids.itemId };
  }

  function sameProduct(a, b) {
    const pa = parseProductUrl(a);
    const pb = parseProductUrl(b);
    return pa.ok && pb.ok && pa.shopId === pb.shopId && pa.itemId === pb.itemId;
  }

  /** Jenis halaman: product | cart | checkout | login | verify | other | external. */
  function pageType(value) {
    const u = safeUrl(value);
    if (!u) return 'other';
    if (!isShopeeHost(u.hostname)) return 'external';
    const path = u.pathname.toLowerCase();
    if (path.startsWith('/buyer/login') || path.startsWith('/buyer/signup')) return 'login';
    if (path.startsWith('/verify') || path.includes('/captcha') || path.includes('/antibot')) return 'verify';
    if (path === '/cart' || path.startsWith('/cart/')) return 'cart';
    if (path === '/checkout' || path.startsWith('/checkout/')) return 'checkout';
    if (productIds(u.pathname)) return 'product';
    return 'other';
  }

  function productNameFromUrl(value) {
    const u = safeUrl(value);
    if (!u) return '';
    const m = u.pathname.match(/^\/(.+?)-i\.\d+\.\d+/);
    if (!m) return '';
    let slug = m[1];
    try {
      slug = decodeURIComponent(slug);
    } catch (_) {
      /* biarkan apa adanya */
    }
    const name = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return name.length > 60 ? name.slice(0, 57).trimEnd() + '…' : name;
  }

  // ── Waktu ───────────────────────────────────────────────────────────────────

  function pad(n, w) {
    return String(n).padStart(w || 2, '0');
  }

  /** epoch ms → "YYYY-MM-DDTHH:MM:SS" (zona waktu lokal) untuk input datetime-local. */
  function toDatetimeLocal(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    );
  }

  /** "YYYY-MM-DDTHH:MM[:SS]" (zona waktu lokal) → epoch ms, atau null. */
  function fromDatetimeLocal(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0);
    if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    return d.getTime();
  }

  /** Durasi ms → "MM:SS", "HH:MM:SS", atau "N hari HH:MM:SS". */
  function formatDuration(ms) {
    const neg = ms < 0;
    let s = Math.floor(Math.abs(ms) / 1000);
    const days = Math.floor(s / 86400);
    s -= days * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    let out;
    if (days > 0) out = days + ' hari ' + pad(h) + ':' + pad(m) + ':' + pad(s);
    else if (h > 0) out = pad(h) + ':' + pad(m) + ':' + pad(s);
    else out = pad(m) + ':' + pad(s);
    return neg ? '-' + out : out;
  }

  function formatDateTime(ms) {
    if (!Number.isFinite(ms)) return '-';
    const d = new Date(ms);
    const days = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    return (
      days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    );
  }

  /**
   * Perkiraan selisih jam (server − lokal) dari header HTTP Date.
   *
   * Header Date hanya berpresisi 1 detik. Setiap sampel {t0, t1, server}
   * (t0/t1 = jam lokal sebelum/sesudah request, server = Date header dalam ms)
   * membatasi offset ke rentang [server − t1, server + 1000 − t0]. Irisan
   * banyak sampel yang melewati pergantian detik mempersempit rentang itu
   * hingga kira-kira sebesar waktu tempuh jaringan.
   */
  function estimateOffset(samples) {
    const valid = (samples || []).filter(
      (s) => s && Number.isFinite(s.t0) && Number.isFinite(s.t1) && Number.isFinite(s.server) && s.t1 >= s.t0,
    );
    if (valid.length === 0) return null;
    let lo = -Infinity;
    let hi = Infinity;
    for (const s of valid) {
      lo = Math.max(lo, s.server - s.t1);
      hi = Math.min(hi, s.server + 1000 - s.t0);
    }
    if (lo <= hi) {
      return { offsetMs: Math.round((lo + hi) / 2), errorMs: Math.round((hi - lo) / 2), samples: valid.length };
    }
    // Sampel saling bertentangan (jam server melompat) → median kasar.
    const mids = valid.map((s) => s.server + 500 - (s.t0 + s.t1) / 2).sort((a, b) => a - b);
    const mid = mids[Math.floor(mids.length / 2)];
    return { offsetMs: Math.round(mid), errorMs: 500, samples: valid.length };
  }

  /** Kalimat ramah tentang hasil sinkronisasi jam. */
  function describeOffset(sync) {
    if (!sync) return 'Belum pernah dicek.';
    if (sync.source !== 'shopee') return sync.error || 'Memakai jam komputer.';
    const secs = Math.abs(sync.offsetMs) / 1000;
    const base = 'Jam server Shopee tersinkron (akurasi ±' + sync.errorMs + ' ms).';
    if (secs < 0.05) return base + ' Jam komputer sudah tepat.';
    const dir = sync.offsetMs > 0 ? 'lebih lambat' : 'lebih cepat';
    return base + ' Jam komputer ' + dir + ' ' + secs.toFixed(secs < 10 ? 2 : 0) + ' detik — bot memakai jam server.';
  }

  // ── Pengaturan ──────────────────────────────────────────────────────────────

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeTexts(raw) {
    const out = {};
    for (const key of Object.keys(DEFAULT_TEXTS)) {
      const hasValue = raw && Object.prototype.hasOwnProperty.call(raw, key);
      const list = hasValue ? splitList(raw[key], /\r?\n|,/).map(normalizeText).filter(Boolean) : null;
      if (list && (list.length > 0 || OPTIONAL_TEXT_KEYS.includes(key))) out[key] = Array.from(new Set(list));
      else out[key] = DEFAULT_TEXTS[key].slice();
    }
    return out;
  }

  function mergeSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const key of Object.keys(SETTING_LIMITS)) {
      const [min, max] = SETTING_LIMITS[key];
      out[key] = clampInt(r[key], min, max, DEFAULT_SETTINGS[key]);
    }
    out.timeSync = r.timeSync === undefined ? DEFAULT_SETTINGS.timeSync : Boolean(r.timeSync);
    out.notifyOnArm = r.notifyOnArm === undefined ? DEFAULT_SETTINGS.notifyOnArm : Boolean(r.notifyOnArm);
    const tg = r.telegram && typeof r.telegram === 'object' ? r.telegram : {};
    out.telegram = {
      enabled: Boolean(tg.enabled),
      botToken: String(tg.botToken || '').trim(),
      chatId: String(tg.chatId || '').trim(),
    };
    out.texts = normalizeTexts(r.texts);
    return out;
  }

  // ── Task ────────────────────────────────────────────────────────────────────

  function makeId(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Validasi & normalisasi input task dari form.
   * input.saleTime boleh epoch ms atau string datetime-local.
   * Mengembalikan { ok, task, errors: {field: pesan} }.
   */
  function validateTask(input, opts) {
    const now = (opts && opts.now) || Date.now();
    const i = input || {};
    const errors = {};

    const parsed = parseProductUrl(i.url || '');
    if (!parsed.ok) errors.url = parsed.error;

    const variants = splitList(i.variants, ',');
    if (variants.length > 4) errors.variants = 'Maksimal 4 pilihan varian.';

    const quantity = Math.round(Number(i.quantity === '' || i.quantity == null ? 1 : i.quantity));
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) errors.quantity = 'Jumlah harus 1–99.';

    let saleTime = typeof i.saleTime === 'number' ? i.saleTime : fromDatetimeLocal(i.saleTime);
    if (!Number.isFinite(saleTime)) {
      errors.saleTime = 'Isi tanggal & jam flash sale.';
      saleTime = null;
    }

    const enabled = i.enabled === undefined ? true : Boolean(i.enabled);
    if (saleTime != null && enabled && !(opts && opts.allowPast) && saleTime <= now) {
      errors.saleTime = 'Waktu flash sale sudah lewat.';
    }

    const payment = splitList(i.payment, '>').join(' > ');

    let maxPrice = null;
    const rawMax = typeof i.maxPrice === 'string' ? i.maxPrice.replace(/[^\d]/g, '') : i.maxPrice;
    if (rawMax !== '' && rawMax != null) {
      maxPrice = Math.round(Number(rawMax));
      if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
        errors.maxPrice = 'Harga maksimal tidak valid.';
        maxPrice = null;
      }
    }

    const name = String(i.name || '').trim() || productNameFromUrl(parsed.url || i.url) || 'Task flash sale';

    const ok = Object.keys(errors).length === 0;
    const task = {
      id: i.id || makeId('task'),
      name: name.slice(0, 80),
      url: parsed.ok ? parsed.url : String(i.url || ''),
      variants,
      quantity: Number.isFinite(quantity) ? quantity : 1,
      saleTime,
      payment,
      maxPrice,
      dryRun: i.dryRun === undefined ? true : Boolean(i.dryRun),
      enabled,
      createdAt: i.createdAt || now,
      updatedAt: now,
      lastRun: i.lastRun || null,
    };
    return { ok, task, errors };
  }

  /**
   * Tentukan apa yang harus dilakukan dengan task sekarang.
   * → { action: 'none' | 'missed' | 'arm_now' | 'schedule', armAt? }
   */
  function scheduleDecision(task, now, settings) {
    if (!task || !task.enabled || !Number.isFinite(task.saleTime)) return { action: 'none' };
    const lead = (settings && settings.leadSeconds ? settings.leadSeconds : DEFAULT_SETTINGS.leadSeconds) * 1000;
    const armAt = task.saleTime - lead;
    if (now > task.saleTime + MISS_GRACE_MS) return { action: 'missed' };
    if (now >= armAt) return { action: 'arm_now', armAt };
    return { action: 'schedule', armAt };
  }

  /** Pasangan task aktif yang waktunya berdekatan (< 3 menit) → peringatan di UI. */
  function findCloseTasks(tasks, windowMs) {
    const w = windowMs || 3 * 60 * 1000;
    const active = (tasks || []).filter((t) => t.enabled && Number.isFinite(t.saleTime))
      .sort((a, b) => a.saleTime - b.saleTime);
    const pairs = [];
    for (let i = 1; i < active.length; i++) {
      if (active[i].saleTime - active[i - 1].saleTime < w) pairs.push([active[i - 1], active[i]]);
    }
    return pairs;
  }

  // ── Telegram ────────────────────────────────────────────────────────────────

  function describeStatus(status) {
    return STATUS[status] || { label: status, icon: '•', tone: 'muted' };
  }

  function buildRunMessage(run) {
    const st = describeStatus(run.status);
    const lines = [
      st.icon + ' <b>' + escapeHtml(st.label) + '</b>',
      '<b>Task:</b> ' + escapeHtml(run.taskName),
    ];
    if (run.kind === 'test') lines.push('<i>Mode: uji sekarang (tanpa membuat pesanan)</i>');
    else if (run.dryRun) lines.push('<i>Mode: uji coba (tanpa membuat pesanan)</i>');
    if (run.message) lines.push(escapeHtml(run.message));
    if (Number.isFinite(run.total)) lines.push('<b>Total:</b> ' + escapeHtml(formatRupiah(run.total)));
    if (Number.isFinite(run.saleTime) && run.kind !== 'test') {
      lines.push('<b>Jadwal:</b> ' + escapeHtml(formatDateTime(run.saleTime)));
    }
    if (run.status === 'success') lines.push('Segera selesaikan pembayaran di tab Shopee.');
    return lines.join('\n');
  }

  function buildArmMessage(run, task) {
    return [
      '⏳ <b>Bot siap</b>',
      '<b>Task:</b> ' + escapeHtml(task.name),
      '<b>Flash sale:</b> ' + escapeHtml(formatDateTime(run.saleTime)),
      run.dryRun ? '<i>Mode uji coba — pesanan tidak akan dibuat.</i>' : 'Jangan tutup tab Shopee yang terbuka.',
    ].join('\n');
  }

  /**
   * Laporan teks (Markdown) satu run untuk ditempel ke GitHub Issue.
   * Tidak memuat token Telegram, cookie, atau query string link produk.
   */
  function buildRunReport(run, meta) {
    const m = meta || {};
    const st = describeStatus(run.status);
    const parsed = parseProductUrl(run.task && run.task.url ? run.task.url : '');
    const url = parsed.ok ? parsed.url.split('?')[0] : '-';
    const start = run.startedAt || (run.steps && run.steps.length ? run.steps[0].at : 0);
    const mode = run.kind === 'test' ? 'uji sekarang' : run.dryRun ? 'terjadwal, uji coba' : 'terjadwal, beli sungguhan';
    const lines = [
      '**Status:** ' + st.label + (run.message ? ' — ' + run.message : ''),
      '**Mode:** ' + mode,
      '**Produk:** ' + url,
    ];
    if (run.task) {
      lines.push(
        '**Varian:** ' + (run.task.variants && run.task.variants.length ? run.task.variants.join(', ') : '-') +
          ' · **Jumlah:** ' + (run.task.quantity || 1) +
          ' · **Pembayaran:** ' + (run.task.payment || 'default') +
          ' · **Harga maks:** ' + (run.task.maxPrice ? formatRupiah(run.task.maxPrice) : '-'),
      );
    }
    lines.push('**Versi extension:** ' + (m.version || '-') + ' · **Browser:** ' + (m.browser || '-'));
    lines.push('', '```');
    for (const step of run.steps || []) {
      const rel = Math.max(0, step.at - start);
      lines.push('+' + String(rel).padStart(6, ' ') + ' ms  ' + step.msg);
    }
    lines.push('```');
    return lines.join('\n');
  }

  function telegramErrorHint(description) {
    const d = String(description || '').toLowerCase();
    if (d.includes('unauthorized')) return 'Token bot salah.';
    if (d.includes('chat not found')) return 'Chat ID tidak ditemukan. Kirim /start ke bot kamu dulu.';
    if (d.includes('bot was blocked')) return 'Bot diblokir oleh akun kamu. Buka blokirnya dulu.';
    if (d.includes('not enough rights')) return 'Bot tidak punya izin kirim pesan di chat ini.';
    return description || 'Gagal mengirim pesan.';
  }

  /** Kirim pesan Telegram. fetchImpl diinjeksi supaya bisa dites. */
  async function sendTelegram(fetchImpl, telegram, text) {
    if (!telegram || !telegram.botToken || !telegram.chatId) {
      return { ok: false, error: 'Token bot / Chat ID belum diisi.' };
    }
    try {
      const res = await fetchImpl('https://api.telegram.org/bot' + telegram.botToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {
        /* bukan JSON */
      }
      if (res.ok && data && data.ok) return { ok: true };
      return { ok: false, error: telegramErrorHint(data && data.description) };
    } catch (err) {
      return { ok: false, error: 'Tidak bisa menghubungi Telegram: ' + (err && err.message ? err.message : err) };
    }
  }

  /** Ambil chat ID dari pesan terakhir yang dikirim ke bot (getUpdates). */
  async function detectTelegramChat(fetchImpl, botToken) {
    if (!botToken) return { ok: false, error: 'Isi token bot dulu.' };
    try {
      const res = await fetchImpl('https://api.telegram.org/bot' + botToken + '/getUpdates');
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) return { ok: false, error: telegramErrorHint(data && data.description) };
      const updates = (data.result || []).slice().reverse();
      for (const u of updates) {
        const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
        const chat = msg && msg.chat;
        if (chat && chat.id != null) {
          const who = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '';
          return { ok: true, chatId: String(chat.id), name: who };
        }
      }
      return { ok: false, error: 'Belum ada pesan. Buka bot kamu di Telegram, kirim /start, lalu coba lagi.' };
    } catch (err) {
      return { ok: false, error: 'Tidak bisa menghubungi Telegram: ' + (err && err.message ? err.message : err) };
    }
  }

  Object.assign(FB, {
    SHOPEE_HOSTS,
    MISS_GRACE_MS,
    RUN_TIMEOUT_MS,
    HISTORY_LIMIT,
    STEP_LIMIT,
    DEFAULT_TEXTS,
    DEFAULT_SETTINGS,
    SETTING_LIMITS,
    STATUS,
    PHASE_LABELS,
    normalizeText,
    matchScore,
    splitList,
    escapeHtml,
    parseRupiah,
    formatRupiah,
    parseProductUrl,
    sameProduct,
    pageType,
    productNameFromUrl,
    toDatetimeLocal,
    fromDatetimeLocal,
    formatDuration,
    formatDateTime,
    estimateOffset,
    describeOffset,
    mergeSettings,
    normalizeTexts,
    makeId,
    validateTask,
    scheduleDecision,
    findCloseTasks,
    describeStatus,
    buildRunMessage,
    buildArmMessage,
    buildRunReport,
    telegramErrorHint,
    sendTelegram,
    detectTelegramChat,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = FB;
})(typeof globalThis !== 'undefined' ? globalThis : this);
