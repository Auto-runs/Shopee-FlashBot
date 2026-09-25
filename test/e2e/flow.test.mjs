// Skenario end-to-end: extension asli di Chromium asli, melawan Shopee tiruan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, describeRun } from './harness.mjs';

const TG = { enabled: true, botToken: 'GOOD:TOKEN', chatId: '555' };
const BASE = { leadSeconds: 5, telegram: TG, notifyOnArm: true };

async function withBrowser(opts, fn) {
  const b = await launch(opts);
  try {
    await b.settings(BASE);
    await fn(b);
    assert.deepEqual(b.errors, [], 'tidak boleh ada error JavaScript di halaman');
  } finally {
    await b.close();
  }
}

test('beli sungguhan tepat T=0 walau jam komputer meleset 4 detik', async (t) => {
  await withBrowser({ skewMs: 4000 }, async (b) => {
    const saleTime = b.mock.serverNow() + 9000;
    const p = b.mock.addProduct({ name: 'Kaos Flash', saleTime, variants: [{ name: 'Hitam' }, { name: 'Putih' }] });
    const task = await b.addTask({ url: p.url, variants: 'Hitam', quantity: 2, saleTime, dryRun: false, maxPrice: 300000 });

    const run = await b.waitForRun(task.id);
    assert.equal(run.status, 'success', describeRun(run));
    assert.equal(run.total, 99000 * 2 + 12000);

    const loads = b.mock.eventsOf('product_load', p.key);
    assert.ok(loads.some((l) => !l.active), 'tab produk dibuka sebelum flash sale');
    const firstActive = loads.find((l) => l.active);
    const lag = firstActive.at - saleTime;
    assert.ok(lag >= 0 && lag < 1500, `halaman dimuat ulang ${lag} ms setelah T=0 (jam server)`);
    t.diagnostic(`muat ulang tiba di server ${lag} ms setelah T=0; order dibuat ${b.mock.eventsOf('place_order')[0].at - saleTime} ms setelah T=0`);

    const buys = b.mock.eventsOf('buy_now', p.key);
    assert.equal(buys.length, 1);
    assert.deepEqual(
      { active: buys[0].active, price: buys[0].price, variant: buys[0].variant, qty: buys[0].qty },
      { active: true, price: 99000, variant: 'Hitam', qty: 2 },
    );
    const orders = b.mock.eventsOf('place_order', p.key);
    assert.equal(orders.length, 1, 'pesanan dibuat tepat sekali');

    await b.waitFor(() => b.mock.telegram.length >= 2);
    assert.match(b.mock.telegram[0].text, /Bot siap/);
    assert.match(b.mock.telegram.at(-1).text, /Pesanan berhasil dibuat/);
    assert.match(b.mock.telegram.at(-1).text, /Kaos Flash/);

    const s = await b.state();
    assert.equal(s.tasks[0].enabled, false, 'task sekali jalan dinonaktifkan');
    assert.equal(s.tasks[0].lastRun.status, 'success');
    assert.equal(s.timeSync.source, 'shopee');
    assert.ok(Math.abs(s.timeSync.offsetMs - 4000) <= s.timeSync.errorMs + 5, JSON.stringify(s.timeSync));
  });
});

test('mode uji coba terjadwal: semua langkah jalan, pesanan tidak dibuat', async () => {
  await withBrowser({}, async (b) => {
    const saleTime = b.mock.serverNow() + 8000;
    const p = b.mock.addProduct({ name: 'Sepatu Uji', saleTime });
    const task = await b.addTask({ url: p.url, saleTime, dryRun: true, payment: 'COD - Cek Dulu', maxPrice: '150.000' });

    const run = await b.waitForRun(task.id);
    assert.equal(run.status, 'dry_run_ok', describeRun(run));
    assert.equal(run.total, 99000 + 12000 + 2500);
    assert.equal(b.mock.eventsOf('place_order').length, 0, 'tidak ada pesanan');
    assert.ok(b.mock.eventsOf('payment_select').some((e) => e.payment === 'COD - Cek Dulu'));
    await b.waitFor(() => b.mock.telegram.some((m) => /Uji coba berhasil/.test(m.text)));
  });
});

test('uji sekarang: pembayaran bertingkat, flash sale belum mulai tetap diuji, jadwal tetap aktif', async () => {
  await withBrowser({}, async (b) => {
    const saleTime = b.mock.serverNow() + 3600e3;
    const p = b.mock.addProduct({ name: 'Headset', saleTime, variants: [{ name: 'Biru' }] });
    const task = await b.addTask({
      url: p.url,
      variants: 'biru',
      saleTime,
      dryRun: false,
      payment: 'Transfer Bank > Bank BCA',
      maxPrice: 300000,
    });

    const res = await b.ui({ type: 'ui:testTask', id: task.id });
    assert.equal(res.ok, true, JSON.stringify(res));
    const run = await b.waitForRun(task.id, { kind: 'test' });
    assert.equal(run.status, 'dry_run_ok', describeRun(run));
    assert.equal(run.total, 250000 + 12000 + 1000, 'harga normal karena flash sale belum mulai');
    assert.equal(b.mock.eventsOf('place_order').length, 0, 'uji sekarang tidak pernah membuat pesanan');
    assert.deepEqual(
      b.mock.eventsOf('payment_select').map((e) => e.payment),
      ['Transfer Bank', 'Bank BCA'],
    );
    const s = await b.state();
    assert.equal(s.tasks[0].enabled, true, 'jadwal asli tetap aktif');
    assert.equal(s.tasks[0].lastRun.kind, 'test');
  });
});

test('harga maksimal terlampaui → batal sebelum Buat Pesanan', async () => {
  await withBrowser({}, async (b) => {
    const saleTime = b.mock.serverNow() + 7000;
    const p = b.mock.addProduct({ name: 'Mahal', saleTime, flashPrice: 180000 });
    const task = await b.addTask({ url: p.url, saleTime, dryRun: false, maxPrice: 150000 });
    const run = await b.waitForRun(task.id);
    assert.equal(run.status, 'failed', describeRun(run));
    assert.match(run.message, /melebihi harga maksimal/);
    assert.equal(b.mock.eventsOf('place_order').length, 0);
  });
});

test('varian habis & varian tidak ada → pesan jelas', async () => {
  await withBrowser({}, async (b) => {
    const p = b.mock.addProduct({
      name: 'Celana',
      saleTime: b.mock.serverNow() + 3600e3,
      variants: [{ name: 'S' }, { name: 'M', disabled: true }, { name: 'L' }],
    });
    const later = b.mock.serverNow() + 3600e3;
    const soldOut = await b.addTask({ url: p.url, variants: 'M', saleTime: later });
    const missing = await b.addTask({ url: p.url, variants: 'XXL', saleTime: later });

    await b.ui({ type: 'ui:testTask', id: soldOut.id });
    const r1 = await b.waitForRun(soldOut.id);
    assert.equal(r1.status, 'failed', describeRun(r1));
    assert.match(r1.message, /Varian "M" habis/);

    await b.ui({ type: 'ui:testTask', id: missing.id });
    const r2 = await b.waitForRun(missing.id);
    assert.equal(r2.status, 'failed', describeRun(r2));
    assert.match(r2.message, /Varian "XXL" tidak ditemukan/);
    assert.match(r2.message, /Pilihan yang terlihat: .*\bs\b.*\bl\b/);
  });
});

test('Shopee menolak pesanan → gagal dengan pesan Shopee, klik tepat sekali', async () => {
  await withBrowser({}, async (b) => {
    b.mock.placeResult = 'error';
    const saleTime = b.mock.serverNow() + 7000;
    const p = b.mock.addProduct({ name: 'Rebutan', saleTime });
    const task = await b.addTask({ url: p.url, saleTime, dryRun: false });
    const run = await b.waitForRun(task.id, { timeout: 60000 });
    assert.equal(run.status, 'failed', describeRun(run));
    assert.match(run.message, /stok produk flash sale sudah habis/);
    assert.equal(b.mock.eventsOf('place_order').length, 1);
  });
});

test('dua task di jam yang sama berjalan bersamaan di tab terpisah', async () => {
  await withBrowser({}, async (b) => {
    const saleTime = b.mock.serverNow() + 9000;
    const p1 = b.mock.addProduct({ name: 'Barang Satu', saleTime });
    const p2 = b.mock.addProduct({ name: 'Barang Dua', saleTime, variants: [{ name: 'Merah' }] });
    const t1 = await b.addTask({ url: p1.url, saleTime, dryRun: false });
    const t2 = await b.addTask({ url: p2.url, variants: 'Merah', saleTime, dryRun: false });
    const [r1, r2] = await Promise.all([b.waitForRun(t1.id), b.waitForRun(t2.id)]);
    assert.equal(r1.status, 'success', describeRun(r1));
    assert.equal(r2.status, 'success', describeRun(r2));
    assert.equal(b.mock.eventsOf('place_order', p1.key).length, 1);
    assert.equal(b.mock.eventsOf('place_order', p2.key).length, 1);
    for (const p of [p1, p2]) {
      assert.equal(b.mock.eventsOf('buy_now', p.key)[0].active, true, 'dibeli di harga flash sale');
    }
  });
});

test('belum login → berhenti dengan pesan login', async () => {
  await withBrowser({}, async (b) => {
    b.mock.loggedIn = false;
    const saleTime = b.mock.serverNow() + 7000;
    const p = b.mock.addProduct({ name: 'Perlu Login', saleTime });
    const task = await b.addTask({ url: p.url, saleTime, dryRun: false });
    const run = await b.waitForRun(task.id);
    assert.equal(run.status, 'failed', describeRun(run));
    assert.match(run.message, /login/i);
    assert.equal(b.mock.eventsOf('place_order').length, 0);
  });
});

test('tab ditutup / dibatalkan saat menunggu → run berhenti, tidak ada muat ulang', async () => {
  await withBrowser({}, async (b) => {
    const saleTime = b.mock.serverNow() + 12000;
    const p1 = b.mock.addProduct({ name: 'Ditutup', saleTime });
    const p2 = b.mock.addProduct({ name: 'Dibatalkan', saleTime });
    const t1 = await b.addTask({ url: p1.url, saleTime, dryRun: false });
    const t2 = await b.addTask({ url: p2.url, saleTime, dryRun: false });

    const armed = await b.waitFor(async () => {
      const s = await b.state();
      const runs = Object.values(s.active);
      return runs.length === 2 && runs.every((r) => r.phase === 'armed') ? runs : null;
    }, { timeout: 15000 });

    const r1 = armed.find((r) => r.taskId === t1.id);
    await b.sw.evaluate((tabId) => chrome.tabs.remove(tabId), r1.tabId);
    const r2 = armed.find((r) => r.taskId === t2.id);
    const res = await b.ui({ type: 'ui:cancelRun', runId: r2.id });
    assert.equal(res.ok, true);

    const done1 = await b.waitForRun(t1.id);
    const done2 = await b.waitForRun(t2.id);
    assert.equal(done1.status, 'cancelled');
    assert.equal(done2.status, 'cancelled');

    // Lewati T=0: tidak boleh ada muat ulang / pembelian.
    await new Promise((r) => setTimeout(r, Math.max(0, saleTime - b.mock.serverNow()) + 1500));
    assert.equal(b.mock.eventsOf('product_load').filter((e) => e.active).length, 0);
    assert.equal(b.mock.eventsOf('buy_now').length, 0);
  });
});

test('jadwal terlewat (browser mati) → tercatat & dikabari', async () => {
  await withBrowser({}, async (b) => {
    const p = b.mock.addProduct({ name: 'Terlewat' });
    await b.sw.evaluate((url) => {
      const S = self.__flashbot.S;
      S.tasks.push({
        id: 'task_missed',
        name: 'Terlewat',
        url,
        variants: [],
        quantity: 1,
        saleTime: Date.now() - 10 * 60 * 1000,
        payment: '',
        maxPrice: null,
        dryRun: false,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastRun: null,
      });
      self.__flashbot.reconcileAll();
    }, p.url);
    const run = await b.waitForRun('task_missed');
    assert.equal(run.status, 'missed');
    await b.waitFor(() => b.mock.telegram.some((m) => /Terlewat/.test(m.text)));
    const s = await b.state();
    assert.equal(s.tasks[0].enabled, false);
  });
});

test('jam komputer kecepatan & sinkron mati → tidak membeli di harga normal, muat ulang sampai mulai', async () => {
  await withBrowser({ skewMs: -2500 }, async (b) => {
    await b.settings({ timeSync: false, maxReloads: 3 });
    const saleTime = b.mock.serverNow() + 9000;
    const p = b.mock.addProduct({ name: 'Kecepatan', saleTime });
    const task = await b.addTask({ url: p.url, saleTime, dryRun: false });
    const run = await b.waitForRun(task.id);
    assert.equal(run.status, 'success', describeRun(run));
    const loads = b.mock.eventsOf('product_load', p.key);
    assert.ok(loads.filter((l) => !l.active).length >= 2, 'ada muat ulang saat flash sale belum mulai');
    const buys = b.mock.eventsOf('buy_now', p.key);
    assert.equal(buys.length, 1);
    assert.equal(buys[0].active, true, 'hanya membeli setelah flash sale mulai');
    assert.equal(buys[0].price, 99000);
  });
});

test('flash sale tidak kunjung mulai → berhenti tanpa membeli', async () => {
  await withBrowser({ skewMs: -60000 }, async (b) => {
    await b.settings({ timeSync: false, maxReloads: 1 });
    const saleTime = b.mock.serverNow() + 66000; // = 6 detik lagi menurut jam komputer
    const p = b.mock.addProduct({ name: 'Belum Mulai', saleTime });
    const task = await b.addTask({ url: p.url, saleTime, dryRun: false });
    const run = await b.waitForRun(task.id);
    assert.equal(run.status, 'failed', describeRun(run));
    assert.match(run.message, /belum dimulai/);
    assert.equal(b.mock.eventsOf('buy_now').length, 0, 'tidak pernah klik Beli Sekarang');
  });
});

test('uji sekarang sebelum flash sale: harga normal > harga maksimal hanya jadi catatan', async () => {
  await withBrowser({}, async (b) => {
    const saleTime = b.mock.serverNow() + 3600e3;
    const p = b.mock.addProduct({ name: 'Diskon Besar', saleTime });
    const task = await b.addTask({ url: p.url, saleTime, dryRun: false, maxPrice: 150000 });
    await b.ui({ type: 'ui:testTask', id: task.id });
    const run = await b.waitForRun(task.id);
    assert.equal(run.status, 'dry_run_ok', describeRun(run));
    assert.match(run.message, /Catatan: Total Rp262\.000 melebihi harga maksimal Rp150\.000/);
    assert.equal(b.mock.eventsOf('place_order').length, 0);
  });
});

test('setelah Buat Pesanan Shopee kembali ke keranjang / minta verifikasi → "perlu dicek manual", bukan sukses', async () => {
  for (const [result, pattern] of [
    ['back_to_cart', /kembali ke halaman keranjang/],
    ['verify', /meminta verifikasi setelah klik "Buat Pesanan"/],
  ]) {
    await withBrowser({}, async (b) => {
      b.mock.placeResult = result;
      const saleTime = b.mock.serverNow() + 7000;
      const p = b.mock.addProduct({ name: 'Cek Manual', saleTime });
      const task = await b.addTask({ url: p.url, saleTime, dryRun: false });
      const run = await b.waitForRun(task.id);
      assert.equal(run.status, 'unknown', describeRun(run));
      assert.match(run.message, pattern);
      assert.equal(b.mock.eventsOf('place_order').length, 1);
    });
  }
});

test('jam komputer meleset + sinkron jam lambat → tetap dimuat ulang tepat T=0', async () => {
  // Meniru run CI yang pernah gagal: jadwal dihitung sebelum selisih jam diketahui.
  await withBrowser({ skewMs: 4000, headDelayMs: 300 }, async (b) => {
    const saleTime = b.mock.serverNow() + 9000;
    const p = b.mock.addProduct({ name: 'Sinkron Lambat', saleTime });
    const task = await b.addTask({ url: p.url, saleTime, dryRun: true });
    const run = await b.waitForRun(task.id);
    assert.equal(run.status, 'dry_run_ok', describeRun(run));
    const loads = b.mock.eventsOf('product_load', p.key);
    assert.ok(loads.some((l) => !l.active), 'tab dibuka sebelum flash sale, bukan terlambat');
    const lag = loads.find((l) => l.active).at - saleTime;
    assert.ok(lag >= 0 && lag < 1500, `halaman dimuat ulang ${lag} ms setelah T=0\n` + describeRun(run));
  });
});
