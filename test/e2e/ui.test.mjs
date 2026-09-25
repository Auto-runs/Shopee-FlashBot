// Uji tampilan: halaman pengaturan & popup benar-benar bisa dipakai tanpa error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

const SHOTS = process.env.FLASHBOT_SCREENSHOTS; // folder opsional untuk tangkapan layar

/** Tangkapan layar untuk dokumentasi: dari atas halaman, tanpa toast. */
async function shot(page, name) {
  if (!SHOTS) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector('#toast.show'), null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function openOptions(b, hash = 'tasks') {
  const page = await b.context.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`chrome-extension://${b.extId}/src/options/options.html#${hash}`);
  await page.waitForSelector('body[data-ready="true"]');
  return page;
}

test('halaman pengaturan: tambah, validasi, edit, nonaktifkan, hapus task', async () => {
  const b = await launch();
  try {
    const page = await openOptions(b);
    await page.setViewportSize({ width: 1100, height: 900 });
    assert.equal(await page.isVisible('#empty'), true, 'tampilan kosong muncul');

    // Validasi
    await page.click('#btn-add');
    await page.fill('#f-url', 'https://tokopedia.com/abc');
    await page.click('#btn-save-task');
    assert.match(await page.textContent('[data-field="url"] .field-error'), /shopee\.co\.id/);

    // Tambah task valid
    const p = b.mock.addProduct({ name: 'Jaket Keren' });
    await page.fill('#f-url', p.url);
    assert.match(await page.textContent('#url-preview'), /Jaket Keren/);
    await page.click('#quick-times button:has-text("21:00")');
    await page.fill('#f-variants', 'Hitam, L');
    await page.fill('#f-qty', '2');
    await page.fill('#f-maxprice', '175000');
    await page.fill('#f-payment', 'ShopeePay');
    await shot(page, '1-form-task');
    await page.click('#btn-save-task');
    await page.waitForSelector('article.task');
    const card = await page.textContent('article.task');
    assert.match(card, /Jaket Keren/);
    assert.match(card, /Terjadwal/);
    assert.match(card, /Varian: Hitam, L/);
    assert.match(card, /Maks Rp175\.000/);
    assert.match(card, /Mode uji coba/);
    assert.match(card, /21:00:00/);

    let s = await b.state();
    assert.equal(s.tasks.length, 1);
    assert.deepEqual(s.tasks[0].variants, ['Hitam', 'L']);
    assert.equal(s.tasks[0].maxPrice, 175000);
    assert.equal(s.tasks[0].dryRun, true);

    // Edit: matikan uji coba (dialog konfirmasi diterima otomatis)
    await page.click('article.task button:has-text("Edit")');
    assert.equal(await page.inputValue('#f-qty'), '2');
    await page.uncheck('#f-dryrun');
    await page.click('#btn-save-task');
    await page.waitForSelector('article.task:has-text("Beli sungguhan")');
    s = await b.state();
    assert.equal(s.tasks[0].dryRun, false);
    await shot(page, '2-daftar-task');

    // Nonaktifkan lewat saklar
    await page.click('article.task .switch span');
    await page.waitForSelector('article.task:has-text("Nonaktif")');
    s = await b.state();
    assert.equal(s.tasks[0].enabled, false);

    // Hapus
    await page.click('article.task button:has-text("Hapus")');
    await page.waitForSelector('#empty', { state: 'visible' });
    s = await b.state();
    assert.equal(s.tasks.length, 0);

    assert.deepEqual(b.errors, []);
  } finally {
    await b.close();
  }
});

test('notifikasi: deteksi chat ID, simpan, kirim tes, token salah', async () => {
  const b = await launch();
  try {
    const page = await openOptions(b, 'notify');
    await page.fill('#n-token', 'GOOD:TOKEN');
    await page.click('#btn-detect-chat');
    await page.waitForFunction(() => document.querySelector('#n-chat').value === '555');
    await page.check('#n-enabled');
    await page.click('#notify-form button[type="submit"]');
    await page.waitForSelector('#toast.show.good');
    const s = await b.state();
    assert.deepEqual(s.settings.telegram, { enabled: true, botToken: 'GOOD:TOKEN', chatId: '555' });

    await page.click('#btn-test-telegram');
    await b.waitFor(() => b.mock.telegram.some((m) => /Tes notifikasi/.test(m.text)));
    assert.equal(b.mock.telegram[0].chat_id, '555');

    await page.fill('#n-token', 'SALAH:TOKEN');
    await page.click('#btn-test-telegram');
    await page.waitForSelector('#toast.show.bad:has-text("Token bot salah")');
    await shot(page, '3-notifikasi');
    assert.deepEqual(b.errors, []);
  } finally {
    await b.close();
  }
});

test('lanjutan: cek jam server & simpan teks tombol', async () => {
  const b = await launch({ skewMs: 1500 });
  try {
    const page = await openOptions(b, 'advanced');
    await page.click('#btn-check-time');
    await page.waitForFunction(() => /tersinkron/.test(document.querySelector('#time-result').textContent));
    assert.match(await page.textContent('#time-result'), /lebih lambat 1\.\d+ detik/);

    await page.fill('#t-buyNow', 'Beli Sekarang\nBeli Langsung');
    await page.fill('#a-lead', '90');
    await page.click('#advanced-form button[type="submit"]');
    await page.waitForSelector('#toast.show.good');
    let s = await b.state();
    assert.deepEqual(s.settings.texts.buyNow, ['beli sekarang', 'beli langsung']);
    assert.equal(s.settings.leadSeconds, 90);
    await shot(page, '4-lanjutan');

    await page.click('#btn-reset-texts');
    await page.waitForFunction(() => document.querySelector('#t-buyNow').value === 'beli sekarang\nbuy now');
    s = await b.state();
    assert.deepEqual(s.settings.texts.buyNow, ['beli sekarang', 'buy now']);
    assert.deepEqual(b.errors, []);
  } finally {
    await b.close();
  }
});

test('riwayat & popup menampilkan hasil dan jadwal', async () => {
  const b = await launch();
  try {
    await b.settings({ leadSeconds: 5 });
    const later = b.mock.serverNow() + 2 * 3600e3;
    const p = b.mock.addProduct({ name: 'Tas Ransel', saleTime: later, variants: [{ name: 'Hitam' }] });
    const task = await b.addTask({ url: p.url, variants: 'Hitam', saleTime: later, maxPrice: 400000 });

    const page = await openOptions(b, 'tasks');
    await page.click('article.task button:has-text("Uji sekarang")');
    await b.waitForRun(task.id);
    await page.click('.tab[data-view="history"]');
    await page.waitForSelector('.history-item');
    const item = await page.textContent('.history-item');
    assert.match(item, /Uji coba berhasil/);
    assert.match(item, /Tas Ransel/);
    await page.click('.history-item summary');
    assert.ok((await page.$$('.steps li')).length >= 5, 'detail langkah tercatat');
    await page.evaluate(() => {
      navigator.clipboard.writeText = async (text) => {
        window.__copied = text;
      };
    });
    await page.click('.history-item button:has-text("Salin laporan")');
    await page.waitForSelector('#toast.show.good');
    const report = await page.evaluate(() => window.__copied);
    assert.match(report, /\*\*Status:\*\* Uji coba berhasil/);
    assert.match(report, /\*\*Versi extension:\*\* 1\.0\.0/);
    assert.match(report, /ms {2}Klik "Beli Sekarang"/);
    await shot(page, '5-riwayat');

    const popup = await b.context.newPage();
    await popup.setViewportSize({ width: 364, height: 520 });
    await popup.goto(`chrome-extension://${b.extId}/src/popup/popup.html`);
    await popup.waitForSelector('body[data-ready="true"]');
    const text = await popup.textContent('body');
    assert.match(text, /Tas Ransel/);
    assert.match(text, /Hasil terakhir/);
    await popup.waitForFunction(() => /\d\d:\d\d:\d\d/.test(document.querySelector('#upcoming .countdown').textContent));
    await shot(popup, '6-popup');
    assert.deepEqual(b.errors, []);
  } finally {
    await b.close();
  }
});
