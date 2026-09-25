const test = require('node:test');
const assert = require('node:assert/strict');
const FB = require('../../extension/src/lib/core.js');

test('normalizeText: huruf kecil, spasi rapat, tanpa zero-width', () => {
  assert.equal(FB.normalizeText('  Beli​   SEKARANG \n'), 'beli sekarang');
  assert.equal(FB.normalizeText(null), '');
});

test('matchScore: exact / prefix / contains', () => {
  assert.equal(FB.matchScore('Beli Sekarang', ['beli sekarang'], 'exact'), 3);
  assert.equal(FB.matchScore('Checkout (1)', ['checkout'], 'exact'), 0);
  assert.equal(FB.matchScore('Checkout (1)', ['checkout'], 'prefix'), 2);
  assert.equal(FB.matchScore('Bayar pakai ShopeePay', ['shopeepay'], 'prefix'), 0);
  assert.equal(FB.matchScore('Bayar pakai ShopeePay', ['shopeepay'], 'contains'), 1);
  assert.equal(FB.matchScore('', ['x'], 'contains'), 0);
});

test('parseRupiah', () => {
  assert.equal(FB.parseRupiah('Rp1.234.567'), 1234567);
  assert.equal(FB.parseRupiah('Total: Rp 99.000'), 99000);
  assert.equal(FB.parseRupiah('rp12.500,50'), 12500);
  assert.equal(FB.parseRupiah('Rp150.000.'), 150000);
  assert.equal(FB.parseRupiah('gratis'), null);
  assert.equal(FB.formatRupiah(1234567), 'Rp1.234.567');
  assert.equal(FB.formatRupiah(null), '-');
});

test('parseProductUrl: format slug dan /product/', () => {
  const a = FB.parseProductUrl('https://shopee.co.id/Kaos-Polos-Hitam-i.12345.678901?sp_atk=abc#x');
  assert.equal(a.ok, true);
  assert.equal(a.shopId, '12345');
  assert.equal(a.itemId, '678901');
  assert.equal(a.url, 'https://shopee.co.id/Kaos-Polos-Hitam-i.12345.678901?sp_atk=abc');

  const b = FB.parseProductUrl('http://www.shopee.co.id/product/111/222');
  assert.equal(b.ok, true);
  assert.equal(b.url, 'https://shopee.co.id/product/111/222');

  assert.equal(FB.parseProductUrl('https://tokopedia.com/x-i.1.2').ok, false);
  assert.equal(FB.parseProductUrl('https://shopee.co.id/cart').ok, false);
  assert.equal(FB.parseProductUrl('bukan url').ok, false);
});

test('sameProduct mengabaikan query & slug', () => {
  assert.equal(FB.sameProduct('https://shopee.co.id/a-i.1.2?x=1', 'https://shopee.co.id/product/1/2'), true);
  assert.equal(FB.sameProduct('https://shopee.co.id/a-i.1.2', 'https://shopee.co.id/a-i.1.3'), false);
});

test('pageType', () => {
  assert.equal(FB.pageType('https://shopee.co.id/Barang-i.1.2'), 'product');
  assert.equal(FB.pageType('https://shopee.co.id/cart'), 'cart');
  assert.equal(FB.pageType('https://shopee.co.id/checkout?state=1'), 'checkout');
  assert.equal(FB.pageType('https://shopee.co.id/buyer/login?next=x'), 'login');
  assert.equal(FB.pageType('https://shopee.co.id/verify/traffic'), 'verify');
  assert.equal(FB.pageType('https://shopee.co.id/user/purchase'), 'other');
  assert.equal(FB.pageType('https://pay.example.com/'), 'external');
});

test('productNameFromUrl', () => {
  assert.equal(FB.productNameFromUrl('https://shopee.co.id/Kaos-Polos%20Hitam-i.1.2'), 'Kaos Polos Hitam');
  assert.equal(FB.productNameFromUrl('https://shopee.co.id/product/1/2'), '');
});

test('datetime-local bolak-balik', () => {
  const ms = new Date(2026, 8, 26, 12, 0, 5).getTime();
  assert.equal(FB.toDatetimeLocal(ms), '2026-09-26T12:00:05');
  assert.equal(FB.fromDatetimeLocal('2026-09-26T12:00:05'), ms);
  assert.equal(FB.fromDatetimeLocal('2026-09-26T12:00'), ms - 5000);
  assert.equal(FB.fromDatetimeLocal('2026-02-30T12:00'), null);
  assert.equal(FB.fromDatetimeLocal(''), null);
});

test('formatDuration', () => {
  assert.equal(FB.formatDuration(65000), '01:05');
  assert.equal(FB.formatDuration(3723000), '01:02:03');
  assert.equal(FB.formatDuration(90061000), '1 hari 01:01:01');
  assert.equal(FB.formatDuration(-5000), '-00:05');
});

test('estimateOffset: menyempit ke offset sebenarnya', () => {
  // Server 1234 ms lebih cepat dari jam lokal, RTT 40 ms, sampel tiap 90 ms.
  const trueOffset = 1234;
  const samples = [];
  for (let i = 0; i < 14; i++) {
    const t0 = 1_700_000_000_000 + i * 90 + 7;
    const t1 = t0 + 40;
    const serverAt = t0 + 20 + trueOffset; // server menulis Date di tengah perjalanan
    samples.push({ t0, t1, server: Math.floor(serverAt / 1000) * 1000 });
  }
  const est = FB.estimateOffset(samples);
  assert.ok(Math.abs(est.offsetMs - trueOffset) <= est.errorMs, JSON.stringify(est));
  assert.ok(est.errorMs <= 70, 'akurasi harus mendekati RTT: ' + est.errorMs);
});

test('estimateOffset: offset negatif & sampel kosong', () => {
  const trueOffset = -3500;
  const samples = [];
  for (let i = 0; i < 14; i++) {
    const t0 = 1_700_000_000_500 + i * 90;
    const t1 = t0 + 30;
    samples.push({ t0, t1, server: Math.floor((t0 + 15 + trueOffset) / 1000) * 1000 });
  }
  const est = FB.estimateOffset(samples);
  assert.ok(Math.abs(est.offsetMs - trueOffset) <= est.errorMs);
  assert.equal(FB.estimateOffset([]), null);
});

test('estimateOffset: sampel bertentangan → median, bukan crash', () => {
  const est = FB.estimateOffset([
    { t0: 0, t1: 10, server: 5000 },
    { t0: 20, t1: 30, server: 90000 },
  ]);
  assert.equal(est.errorMs, 500);
  assert.ok(Number.isFinite(est.offsetMs));
});

test('mergeSettings: batas angka, default, teks', () => {
  const s = FB.mergeSettings({
    leadSeconds: 1,
    reloadDelayMs: 'abc',
    maxReloads: 99,
    texts: { buyNow: 'Beli Sekarang\nBUY NOW\n', soldOut: '', placeOrder: '' },
    telegram: { enabled: 1, botToken: ' 123:abc ', chatId: 42 },
  });
  assert.equal(s.leadSeconds, 5);
  assert.equal(s.reloadDelayMs, FB.DEFAULT_SETTINGS.reloadDelayMs);
  assert.equal(s.maxReloads, 10);
  assert.deepEqual(s.texts.buyNow, ['beli sekarang', 'buy now']);
  assert.deepEqual(s.texts.soldOut, [], 'teks opsional boleh dikosongkan');
  assert.deepEqual(s.texts.placeOrder, FB.DEFAULT_TEXTS.placeOrder, 'teks wajib kembali ke default');
  assert.deepEqual(s.telegram, { enabled: true, botToken: '123:abc', chatId: '42' });
  assert.equal(FB.mergeSettings(undefined).timeSync, true);
});

test('validateTask: input valid', () => {
  const now = Date.now();
  const { ok, task, errors } = FB.validateTask(
    {
      url: 'https://shopee.co.id/Kaos-i.1.2',
      variants: 'Hitam, XL ,',
      quantity: '2',
      saleTime: now + 3600e3,
      payment: 'Transfer Bank >  Bank BCA',
      maxPrice: '150.000',
    },
    { now },
  );
  assert.equal(ok, true, JSON.stringify(errors));
  assert.deepEqual(task.variants, ['Hitam', 'XL']);
  assert.equal(task.quantity, 2);
  assert.equal(task.payment, 'Transfer Bank > Bank BCA');
  assert.equal(task.maxPrice, 150000);
  assert.equal(task.dryRun, true, 'default uji coba harus aktif');
  assert.equal(task.enabled, true);
  assert.equal(task.name, 'Kaos');
});

test('validateTask: pesan error per kolom', () => {
  const now = Date.now();
  const { ok, errors } = FB.validateTask(
    { url: 'https://example.com', quantity: 0, saleTime: now - 1000, maxPrice: '0', variants: 'a,b,c,d,e' },
    { now },
  );
  assert.equal(ok, false);
  assert.ok(errors.url && errors.quantity && errors.saleTime && errors.maxPrice && errors.variants);
  const past = FB.validateTask({ url: 'https://shopee.co.id/x-i.1.2', saleTime: now - 1000, enabled: false }, { now });
  assert.equal(past.ok, true, 'task nonaktif boleh berwaktu lampau');
  const noTime = FB.validateTask({ url: 'https://shopee.co.id/x-i.1.2', saleTime: '' }, { now });
  assert.ok(noTime.errors.saleTime);
});

test('scheduleDecision', () => {
  const now = 1_000_000_000;
  const settings = { leadSeconds: 60 };
  const t = (saleTime, enabled = true) => ({ enabled, saleTime });
  assert.deepEqual(FB.scheduleDecision(t(now + 120e3, false), now, settings), { action: 'none' });
  assert.equal(FB.scheduleDecision(t(now + 120e3), now, settings).action, 'schedule');
  assert.equal(FB.scheduleDecision(t(now + 120e3), now, settings).armAt, now + 60e3);
  assert.equal(FB.scheduleDecision(t(now + 30e3), now, settings).action, 'arm_now');
  assert.equal(FB.scheduleDecision(t(now - 30e3), now, settings).action, 'arm_now');
  assert.equal(FB.scheduleDecision(t(now - FB.MISS_GRACE_MS - 1), now, settings).action, 'missed');
});

test('findCloseTasks', () => {
  const tasks = [
    { name: 'A', enabled: true, saleTime: 0 },
    { name: 'B', enabled: true, saleTime: 60e3 },
    { name: 'C', enabled: true, saleTime: 3600e3 },
    { name: 'D', enabled: false, saleTime: 3601e3 },
  ];
  const pairs = FB.findCloseTasks(tasks);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].map((t) => t.name), ['A', 'B']);
});

test('buildRunMessage meng-escape HTML', () => {
  const text = FB.buildRunMessage({
    status: 'success',
    taskName: '<b>Kaos & Topi</b>',
    message: 'ok',
    total: 99000,
    saleTime: Date.now(),
    kind: 'scheduled',
  });
  assert.ok(text.includes('&lt;b&gt;Kaos &amp; Topi&lt;/b&gt;'));
  assert.ok(text.includes('Rp99.000'));
  assert.ok(text.startsWith('✅'));
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('sendTelegram: sukses & isi request', async () => {
  const f = fakeFetch(() => ({ body: { ok: true } }));
  const res = await FB.sendTelegram(f, { botToken: 'T', chatId: '9' }, 'halo');
  assert.deepEqual(res, { ok: true });
  assert.equal(f.calls[0].url, 'https://api.telegram.org/botT/sendMessage');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.chat_id, '9');
  assert.equal(body.parse_mode, 'HTML');
});

test('sendTelegram: pesan error yang ramah', async () => {
  const unauthorized = fakeFetch(() => ({ status: 401, body: { ok: false, description: 'Unauthorized' } }));
  assert.equal((await FB.sendTelegram(unauthorized, { botToken: 'x', chatId: '1' }, 'x')).error, 'Token bot salah.');
  const noChat = fakeFetch(() => ({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }));
  assert.match((await FB.sendTelegram(noChat, { botToken: 'x', chatId: '1' }, 'x')).error, /Chat ID/);
  const offline = async () => {
    throw new Error('offline');
  };
  assert.match((await FB.sendTelegram(offline, { botToken: 'x', chatId: '1' }, 'x')).error, /offline/);
  assert.equal((await FB.sendTelegram(offline, { botToken: '', chatId: '' }, 'x')).ok, false);
});

test('detectTelegramChat: ambil chat terbaru', async () => {
  const f = fakeFetch(() => ({
    body: {
      ok: true,
      result: [
        { message: { chat: { id: 1, first_name: 'Lama' } } },
        { message: { chat: { id: 777, first_name: 'Budi', last_name: 'S' } } },
      ],
    },
  }));
  assert.deepEqual(await FB.detectTelegramChat(f, 'T'), { ok: true, chatId: '777', name: 'Budi S' });
  const empty = fakeFetch(() => ({ body: { ok: true, result: [] } }));
  assert.match((await FB.detectTelegramChat(empty, 'T')).error, /\/start/);
});
