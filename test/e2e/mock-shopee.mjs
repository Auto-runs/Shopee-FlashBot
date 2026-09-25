// Shopee tiruan untuk pengujian end-to-end.
//
// Server HTTPS lokal. Chromium dijalankan dengan --host-resolver-rules sehingga
// shopee.co.id dan api.telegram.org diarahkan ke server ini. Extension berjalan
// persis seperti di situs asli (content script, host permission, service
// worker, jam server) tanpa menyentuh Shopee sungguhan.
//
// Perilaku yang ditiru:
//  • Jam server bisa dibuat meleset dari jam komputer (skewMs) — header Date.
//  • Status flash sale ditentukan jam SERVER saat halaman diminta: sebelum
//    T=0 halaman menampilkan "Dimulai dalam" dan harga normal.
//  • Varian (bisa habis), kuantitas dengan batas pembelian, toast error.
//  • "Beli Sekarang" → keranjang lewat history.pushState (SPA, tanpa reload)
//    → "Checkout (1)" → halaman checkout (navigasi penuh).
//  • Checkout: pembayaran bertingkat, Total Pembayaran, "Buat Pesanan" yang
//    sukses (pindah halaman) atau ditolak (dialog).

import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/** Sertifikat self-signed sekali pakai untuk shopee.co.id & api.telegram.org. */
function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'flashbot-cert-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=shopee.co.id',
      '-addext', 'subjectAltName=DNS:shopee.co.id,DNS:api.telegram.org',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export class MockShopee {
  constructor({ skewMs = 0, headDelayMs = 0 } = {}) {
    this.skewMs = skewMs;
    this.headDelayMs = headDelayMs; // meniru jaringan lambat saat sinkron jam
    this.products = new Map();
    this.placeResult = 'success';
    this.loggedIn = true;
    this.events = [];
    this.telegram = [];
    this.headRequests = 0;
  }

  serverNow() {
    return Date.now() + this.skewMs;
  }

  addProduct(p) {
    const product = {
      shopId: 1000,
      itemId: 2000 + this.products.size,
      name: 'Produk Tes',
      normalPrice: 250000,
      flashPrice: 99000,
      saleTime: this.serverNow() + 60000,
      variants: [],
      maxQty: 2,
      ...p,
    };
    product.key = product.shopId + '.' + product.itemId;
    product.url = 'https://shopee.co.id/' + product.name.replace(/\s+/g, '-') + '-i.' + product.key;
    this.products.set(product.key, product);
    return product;
  }

  eventsOf(type, key) {
    return this.events.filter((e) => e.type === type && (!key || e.key === key));
  }

  async start() {
    this.server = https.createServer(makeCert(), (req, res) => this.onRequest(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** Argumen Chromium untuk mengarahkan domain ke server ini. */
  chromiumArgs() {
    return [
      `--host-resolver-rules=MAP shopee.co.id 127.0.0.1:${this.port}, MAP api.telegram.org 127.0.0.1:${this.port}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ];
  }

  async onRequest(req, res) {
    const body = await readBody(req);
    const host = String(req.headers.host || '').split(':')[0];
    const url = new URL(req.url, 'https://' + host);
    if (req.method === 'HEAD' && this.headDelayMs) await new Promise((r) => setTimeout(r, this.headDelayMs));
    let out;
    try {
      out = host === 'api.telegram.org' ? this.telegramResponse(url, body) : this.shopeeResponse(req.method, url, body);
    } catch (err) {
      out = { status: 500, body: String(err && err.stack) };
    }
    res.writeHead(out.status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      date: new Date(this.serverNow()).toUTCString(),
      ...(out.headers || {}),
    });
    res.end(req.method === 'HEAD' ? undefined : out.body);
  }

  record(type, data) {
    this.events.push({ type, at: this.serverNow(), ...data });
  }

  shopeeResponse(method, url, body) {
    if (method === 'HEAD') {
      this.headRequests++;
      return { status: 200, body: '' };
    }
    if (url.pathname === '/__mock/event' && method === 'POST') {
      const data = JSON.parse(body || '{}');
      this.record(data.type, data);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
    }
    const m = url.pathname.match(/-i\.(\d+\.\d+)$/);
    if (m && this.products.has(m[1])) {
      const product = this.products.get(m[1]);
      const active = this.serverNow() >= product.saleTime;
      this.record('product_load', { key: product.key, active });
      return { status: 200, body: this.productHtml(product, active) };
    }
    if (url.pathname === '/checkout') {
      this.record('checkout_load', { key: url.searchParams.get('item') });
      return { status: 200, body: this.checkoutHtml(url.searchParams) };
    }
    if (url.pathname.startsWith('/payment/')) {
      return { status: 200, body: page('Pembayaran', '<h1>Selesaikan pembayaran</h1>') };
    }
    if (url.pathname === '/cart') {
      return { status: 200, body: page('Keranjang', '<h1>Keranjang Belanja</h1><p>Keranjang kosong</p>') };
    }
    if (url.pathname.startsWith('/verify/')) {
      return { status: 200, body: page('Verifikasi', '<h1>Verifikasi keamanan</h1>') };
    }
    if (url.pathname.startsWith('/buyer/login')) {
      return { status: 200, body: page('Login', '<h1>Log In</h1><input placeholder="No. Handphone">') };
    }
    if (url.pathname === '/favicon.ico') return { status: 204, body: '' };
    return { status: 404, body: page('404', '<h1>Halaman tidak ditemukan</h1>') };
  }

  telegramResponse(url, body) {
    const [, botPart, method] = url.pathname.split('/');
    const token = (botPart || '').replace(/^bot/, '');
    const ok = (data) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    if (token !== 'GOOD:TOKEN') {
      return {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":false,"error_code":401,"description":"Unauthorized"}',
      };
    }
    if (method === 'getUpdates') {
      return ok({ ok: true, result: [{ update_id: 1, message: { chat: { id: 555, first_name: 'Penguji' }, text: '/start' } }] });
    }
    if (method === 'sendMessage') {
      this.telegram.push(JSON.parse(body || '{}'));
      return ok({ ok: true, result: { message_id: this.telegram.length } });
    }
    return ok({ ok: false, description: 'Not Found' });
  }

  productHtml(product, active) {
    const data = {
      key: product.key,
      name: product.name,
      price: active ? product.flashPrice : product.normalPrice,
      active,
      variants: product.variants,
      maxQty: product.maxQty,
      loggedIn: this.loggedIn,
      countdown: Math.max(0, Math.round((product.saleTime - this.serverNow()) / 1000)),
    };
    return page(
      product.name,
      `<div id="main">Memuat…</div>
<script>
const P = ${json(data)};
const post = (type, extra) => fetch('/__mock/event', { method: 'POST', keepalive: true, body: JSON.stringify({ type, key: P.key, ...extra }) });
const fmt = (n) => 'Rp' + String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.');
let selected = null;

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast__container';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

function renderProduct() {
  const main = document.getElementById('main');
  main.innerHTML = \`
    <header>\${P.loggedIn ? '<span>Akun Saya</span>' : '<a href="/buyer/signup">Daftar</a> | <a href="/buyer/login">Log In</a>'}</header>
    <h1>\${P.name}</h1>
    <div class="flash">\${P.active ? 'FLASH SALE · Berakhir dalam 01:59:59' : 'FLASH SALE · Dimulai dalam ' + P.countdown + ' detik'}</div>
    <div class="price">\${fmt(P.price)}</div>
    \${P.variants.length ? '<section class="variation"><div>Warna</div><div id="variants"></div></section>' : ''}
    <section class="qty"><div>Kuantitas</div><div><button id="minus">-</button><input id="qty" type="text" role="spinbutton" value="1"><button id="plus">+</button></div><div>Maks. \${P.maxQty} per pembeli</div></section>
    <button class="btn btn-tinted">masukkan keranjang</button>
    <button class="btn btn-solid-primary" id="buy">beli sekarang</button>\`;
  const box = document.getElementById('variants');
  for (const v of P.variants) {
    const b = document.createElement('button');
    b.className = 'product-variation' + (v.disabled ? ' product-variation--disabled' : '');
    b.setAttribute('aria-label', v.name);
    b.setAttribute('aria-disabled', String(Boolean(v.disabled)));
    b.textContent = v.name;
    b.addEventListener('click', () => {
      if (v.disabled) return;
      selected = v.name;
      for (const other of box.children) {
        const on = other === b;
        other.classList.toggle('product-variation--selected', on);
        other.setAttribute('aria-checked', String(on));
      }
    });
    box && box.append(b);
  }
  const qty = document.getElementById('qty');
  qty.addEventListener('input', () => {
    const n = Math.max(1, Math.min(P.maxQty, parseInt(qty.value, 10) || 1));
    if (String(n) !== qty.value) qty.value = String(n);
  });
  document.getElementById('buy').addEventListener('click', async () => {
    if (P.variants.length && !selected) return toast('Silakan pilih variasi produk terlebih dahulu');
    if (!P.loggedIn) { location.href = '/buyer/login?next=' + encodeURIComponent(location.pathname); return; }
    const order = { variant: selected, qty: parseInt(qty.value, 10), price: P.price, active: P.active };
    await post('buy_now', order);
    history.pushState({}, '', '/cart');
    renderCart(order);
  });
}

function renderCart(order) {
  const main = document.getElementById('main');
  main.innerHTML = \`
    <h1>Keranjang Belanja</h1>
    <div class="cart-item"><input type="checkbox" checked> \${P.name} \${order.variant || ''} x\${order.qty} · \${fmt(order.price * order.qty)}</div>
    <div class="cart-footer"><span>Total (1 produk): \${fmt(order.price * order.qty)}</span>
    <button class="shopee-button-solid" id="co">Checkout (1)</button></div>\`;
  document.getElementById('co').addEventListener('click', () => {
    const q = new URLSearchParams({ item: P.key, name: P.name, variant: order.variant || '', qty: order.qty, price: order.price });
    setTimeout(() => (location.href = '/checkout?' + q), 150);
  });
}

setTimeout(renderProduct, 300);
</script>`,
    );
  }

  checkoutHtml(params) {
    const data = {
      key: params.get('item'),
      name: params.get('name'),
      variant: params.get('variant'),
      qty: Number(params.get('qty')),
      price: Number(params.get('price')),
      result: this.placeResult,
    };
    return page(
      'Checkout',
      `<div id="main">Memuat…</div>
<script>
const C = ${json(data)};
const post = (type, extra) => fetch('/__mock/event', { method: 'POST', keepalive: true, body: JSON.stringify({ type, key: C.key, ...extra }) });
const fmt = (n) => 'Rp' + String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.');
const SHIPPING = 12000;
let payment = 'ShopeePay';
const fees = { 'ShopeePay': 0, 'COD - Cek Dulu': 2500, 'Bank BCA': 1000, 'Bank Mandiri': 1000 };
const total = () => C.price * C.qty + SHIPPING + (fees[payment] || 0);

function render() {
  document.getElementById('main').innerHTML = \`
    <h1>Checkout</h1>
    <section><div>Alamat Pengiriman</div><div>Penguji (+62) 812-0000 · Jl. Contoh No. 1</div></section>
    <section class="item">\${C.name} · \${C.variant} · x\${C.qty} · \${fmt(C.price)}</section>
    <section class="payment"><div>Metode Pembayaran</div>
      <button class="pay" data-pay="ShopeePay">ShopeePay</button>
      <button class="pay" data-pay="COD - Cek Dulu">COD - Cek Dulu</button>
      <button class="pay" data-pay="Transfer Bank">Transfer Bank</button>
      <div id="banks" style="display:none"><button class="pay" data-pay="Bank BCA">Bank BCA</button><button class="pay" data-pay="Bank Mandiri">Bank Mandiri</button></div>
    </section>
    <section class="summary">
      <div>Subtotal untuk Produk <span>\${fmt(C.price * C.qty)}</span></div>
      <div>Total Ongkos Kirim <span>\${fmt(SHIPPING)}</span></div>
      <div class="row"><div>Total Pembayaran:</div><div class="total" id="total"></div></div>
    </section>
    <button class="stardust-button stardust-button--primary" id="place">Buat Pesanan</button>\`;
  for (const b of document.querySelectorAll('.pay')) {
    b.addEventListener('click', () => {
      const p = b.dataset.pay;
      if (p === 'Transfer Bank') { document.getElementById('banks').style.display = 'block'; payment = null; }
      else payment = p;
      post('payment_select', { payment: p });
      refresh();
    });
  }
  document.getElementById('place').addEventListener('click', async () => {
    if (!payment) return;
    await post('place_order', { payment, total: total() });
    if (C.result === 'success') {
      setTimeout(() => (location.href = '/payment/success?orderid=' + Date.now()), 200);
    } else if (C.result === 'back_to_cart') {
      setTimeout(() => (location.href = '/cart'), 200);
    } else if (C.result === 'verify') {
      setTimeout(() => (location.href = '/verify/traffic'), 200);
    } else {
      const d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.textContent = 'Maaf, stok produk flash sale sudah habis.';
      document.body.append(d);
    }
  });
  refresh();
}

function refresh() {
  document.getElementById('total').textContent = payment ? fmt(total()) : '-';
  for (const b of document.querySelectorAll('.pay')) b.classList.toggle('selected', b.dataset.pay === payment);
  document.getElementById('place').disabled = !payment;
}

setTimeout(render, 300);
</script>`,
    );
  }
}

function page(title, body) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:20px} button{margin:4px;padding:6px 10px} .toast__container{position:fixed;top:40%;left:40%;background:#000;color:#fff;padding:12px}</style>
</head><body>${body}</body></html>`;
}
