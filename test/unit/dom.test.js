const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

// core.js & dom.js memasang diri ke globalThis.FB.
require('../../extension/src/lib/core.js');
const dom = require('../../extension/src/lib/dom.js');

// jsdom tidak punya layout; anggap elemen terlihat kecuali disembunyikan lewat style.
dom.config.isVisible = (el) => {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden || n.style.display === 'none' || n.style.visibility === 'hidden') return false;
  }
  return el.isConnected;
};

function page(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('findClickable: cocok teks, ambil elemen terdalam & yang aktif', () => {
  const doc = page(`
    <div role="button" id="wrap"><button id="a" disabled>Beli Sekarang</button></div>
    <button id="b"><span>beli   sekarang</span></button>
    <button id="c" style="display:none">Beli Sekarang</button>`);
  const el = dom.findClickable(doc, ['beli sekarang']);
  assert.equal(el.id, 'b');
});

test('findClickable: prefix "Checkout (1)" & cadangan div cursor:pointer', () => {
  const doc = page('<button id="x">Checkout (1)</button>');
  assert.equal(dom.findClickable(doc, ['checkout']).id, 'x');
  const doc2 = page('<div id="d" style="cursor:pointer"><span>Buat Pesanan</span></div>');
  assert.equal(dom.findClickable(doc2, ['buat pesanan']).id, 'd');
  assert.equal(dom.findClickable(page('<p>Buat Pesanan</p>'), ['buat pesanan']), null);
});

test('findVariant: aria-label, status disabled/selected, cocok sebagian unik', () => {
  const doc = page(`
    <button aria-label="Hitam" class="product-variation">Hitam</button>
    <button aria-label="Putih" class="product-variation product-variation--disabled">Putih</button>
    <button aria-label="XL" aria-checked="true">XL</button>
    <button>Merah Marun</button>`);
  const hitam = dom.findVariant(doc, 'hitam');
  assert.equal(hitam.el.textContent, 'Hitam');
  assert.equal(hitam.disabled, false);
  assert.equal(hitam.selected, false);
  assert.equal(dom.findVariant(doc, 'Putih').disabled, true);
  assert.equal(dom.findVariant(doc, 'XL').selected, true);
  assert.equal(dom.findVariant(doc, 'marun').el.textContent, 'Merah Marun');
  assert.equal(dom.findVariant(doc, 'Biru'), null);
});

test('listVariantOptions mengabaikan tombol aksi', () => {
  const doc = page('<button>Hitam</button><button>Putih</button><button>Beli Sekarang</button>');
  assert.deepEqual(dom.listVariantOptions(doc, ['beli sekarang']), ['hitam', 'putih']);
});

test('findQuantityInput lewat label "Kuantitas" & setInputValue memicu event', () => {
  const doc = page(`
    <section><div>Kuantitas</div><div><button>-</button><input type="text" value="1"><button>+</button></div></section>
    <input type="text" id="search" value="">`);
  const input = dom.findQuantityInput(doc, ['kuantitas']);
  assert.ok(input);
  assert.equal(input.value, '1');
  const events = [];
  input.addEventListener('input', () => events.push('input'));
  input.addEventListener('change', () => events.push('change'));
  dom.setInputValue(input, 3);
  assert.equal(input.value, '3');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(dom.findQuantityInput(page('<input role="spinbutton" id="s">'), ['kuantitas']).id, 's');
});

test('readTotal membaca angka setelah label', () => {
  const doc = page(`
    <div>Subtotal Produk <span>Rp100.000</span></div>
    <div class="row"><div>Total Pembayaran</div><div class="big">Rp112.500</div></div>`);
  assert.equal(dom.readTotal(doc, ['total pembayaran']), 112500);
  assert.equal(dom.readTotal(page('<div>Total Pembayaran</div>'), ['total pembayaran']), null);
});

test('pageHasText & collectAlerts/newAlert', () => {
  const doc = page('<div>Flash Sale Dimulai Dalam 00:10</div><div role="alert">Lama</div>');
  assert.equal(dom.pageHasText(doc, ['dimulai dalam']), 'dimulai dalam');
  assert.equal(dom.pageHasText(doc, ['berakhir dalam']), null);
  const before = dom.collectAlerts(doc);
  assert.deepEqual(before, ['lama']);
  assert.equal(dom.newAlert(doc, before), null);
  const dlg = doc.createElement('div');
  dlg.setAttribute('role', 'dialog');
  dlg.textContent = 'Stok habis';
  doc.body.append(dlg);
  assert.equal(dom.newAlert(doc, before), 'stok habis');
});

test('waitFor: resolve saat DOM berubah, null saat timeout, Aborted saat tidak hidup', async () => {
  const doc = page('<div id="root"></div>');
  setTimeout(() => {
    const b = doc.createElement('button');
    b.textContent = 'Buat Pesanan';
    doc.getElementById('root').append(b);
  }, 30);
  const el = await dom.waitFor(() => dom.findClickable(doc, ['buat pesanan']), { timeout: 2000, doc });
  assert.equal(el.textContent, 'Buat Pesanan');

  const none = await dom.waitFor(() => false, { timeout: 50, doc });
  assert.equal(none, null);

  let alive = true;
  setTimeout(() => (alive = false), 30);
  await assert.rejects(dom.waitFor(() => false, { timeout: 2000, doc, alive: () => alive }), (e) => e.name === 'Aborted');
});
