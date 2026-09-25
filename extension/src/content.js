/*
 * content.js — berjalan di halaman shopee.co.id.
 *
 * Setiap kali URL berubah (muat ulang penuh maupun navigasi SPA), script ini
 * bertanya ke background "apa tugas tab ini?". Jika tab ini bukan milik run
 * FlashBot, script diam saja. Jika ya, langkah dijalankan sesuai jenis
 * halaman dan fase run:
 *
 *   produk   : pilih varian → atur jumlah → klik "Beli Sekarang"
 *   keranjang: klik "Checkout"
 *   checkout : pilih pembayaran → cek harga maksimal → klik "Buat Pesanan"
 *              (mode uji coba berhenti tepat sebelum klik)
 *
 * Fase disimpan di background SEBELUM setiap klik penting, jadi halaman yang
 * termuat ulang tidak akan pernah mengklik "Buat Pesanan" dua kali.
 */
(function () {
  'use strict';

  if (window.__flashbotContent) return;
  window.__flashbotContent = true;

  const dom = FB.dom;
  const { Aborted } = dom;

  let routeSeq = 0;
  let lastHref = null;
  let countdownTimer = null;

  // ── Komunikasi ──────────────────────────────────────────────────────────────

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (_) {
      // Extension di-reload/diupdate: konteks lama tidak valid lagi.
      return Promise.resolve(null);
    }
  }

  // ── Overlay status (Shadow DOM supaya tidak bentrok dengan halaman) ─────────

  let overlay = null;

  function showOverlay(text, tone, count) {
    if (!overlay) {
      const host = document.createElement('div');
      host.setAttribute('data-flashbot', 'overlay');
      host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML =
        '<style>' +
        '.box{box-sizing:border-box;width:300px;padding:12px 14px 12px 16px;border-radius:8px;background:#161615;' +
        'color:#ededea;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
        'box-shadow:0 8px 28px rgba(0,0,0,.28),inset 3px 0 0 #c6f135;}' +
        '.box.good{box-shadow:0 8px 28px rgba(0,0,0,.28),inset 3px 0 0 #4cc987}' +
        '.box.bad{box-shadow:0 8px 28px rgba(0,0,0,.28),inset 3px 0 0 #ff7a70}' +
        '.box.warn{box-shadow:0 8px 28px rgba(0,0,0,.28),inset 3px 0 0 #f0b04a}' +
        '.title{color:#a3a39b;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}' +
        '.count{margin-top:4px;font:500 28px/1 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;' +
        'font-variant-numeric:tabular-nums;letter-spacing:-.02em}' +
        '.count:empty{display:none}' +
        '.msg{margin-top:4px;white-space:pre-wrap;word-break:break-word;color:#d6d6d1}' +
        '</style><div class="box"><div class="title">FlashBot</div><div class="count"></div><div class="msg"></div></div>';
      document.documentElement.appendChild(host);
      overlay = { host, box: shadow.querySelector('.box'), count: shadow.querySelector('.count'), msg: shadow.querySelector('.msg') };
    }
    overlay.box.className = 'box' + (tone ? ' ' + tone : '');
    overlay.count.textContent = count || '';
    overlay.msg.textContent = text;
  }

  function hideOverlay() {
    if (overlay) {
      overlay.host.remove();
      overlay = null;
    }
  }

  // ── Routing ─────────────────────────────────────────────────────────────────

  function checkRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    onRoute();
  }

  async function onRoute() {
    const seq = ++routeSeq;
    clearInterval(countdownTimer);
    const job = await send({ type: 'getJob' });
    if (seq !== routeSeq) return;
    if (!job || !job.run) {
      hideOverlay();
      return;
    }
    const ctx = createCtx(job, seq);
    try {
      await runPage(ctx);
    } catch (err) {
      if (err instanceof Aborted || (err && err.name === 'Aborted')) return;
      await ctx.finish('failed', 'Error tak terduga: ' + ((err && err.message) || err));
    }
  }

  function createCtx(job, seq) {
    const run = job.run;
    const alive = () => seq === routeSeq;
    const ctx = {
      run,
      task: run.task,
      texts: job.settings.texts,
      stepTimeout: job.settings.stepTimeoutMs,
      alive,
      serverNow: () => Date.now() + (run.offsetMs || 0),
      log(msg) {
        showOverlay(msg);
        return send({ type: 'log', runId: run.id, msg });
      },
      async phase(phase, msg, extra) {
        if (!alive()) throw new Aborted();
        showOverlay(msg);
        const res = await send({ type: 'setPhase', runId: run.id, phase, msg, extra });
        // Run dibatalkan / sudah selesai → berhenti sebelum klik apa pun.
        if (!res || !res.ok) throw new Aborted();
        run.phase = phase;
      },
      async finish(status, message, extra) {
        const st = FB.describeStatus(status);
        showOverlay(st.label + (message ? '\n' + message : ''), st.tone);
        await send({ type: 'finish', runId: run.id, status, message, extra });
      },
      wait(fn, timeout) {
        return dom.waitFor(fn, { timeout, alive });
      },
      sleep(ms) {
        return dom.sleep(ms, alive);
      },
    };
    return ctx;
  }

  async function runPage(ctx) {
    const page = FB.pageType(location.href);
    const phase = ctx.run.phase;

    if (page === 'login' || page === 'verify') {
      if (phase === 'armed') {
        showOverlay('Kamu perlu login dulu sebelum flash sale dimulai.', 'warn');
        return;
      }
      if (phase === 'placing') {
        return ctx.finish(
          'unknown',
          'Shopee meminta ' + (page === 'login' ? 'login' : 'verifikasi') +
            ' setelah klik "Buat Pesanan". Selesaikan di tab ini untuk melanjutkan pesanan.',
        );
      }
      return ctx.finish(
        'failed',
        page === 'login'
          ? 'Shopee meminta login. Login dulu di tab ini, lalu jalankan ulang task.'
          : 'Shopee meminta verifikasi (captcha). Selesaikan manual, lalu jalankan ulang task.',
      );
    }

    if (phase === 'armed') return showCountdown(ctx, page);

    if (page === 'product') {
      if (phase === 'to_checkout') {
        // Halaman produk termuat lagi setelah klik "Beli Sekarang": beri waktu, lalu laporkan.
        await ctx.sleep(ctx.stepTimeout);
        return ctx.finish('failed', 'Tidak pindah ke keranjang/checkout setelah klik "Beli Sekarang".');
      }
      if (phase !== 'buying') return;
      if (!FB.sameProduct(location.href, ctx.task.url)) {
        showOverlay('Tab ini sedang dipakai FlashBot — kembali ke halaman produk target.', 'warn');
        return;
      }
      return doProduct(ctx);
    }
    if (page === 'cart' && ['buying', 'to_checkout', 'cart'].includes(phase)) return doCart(ctx);
    if (page === 'checkout') {
      if (phase === 'placing') {
        return ctx.finish(
          'unknown',
          'Halaman checkout termuat ulang setelah klik "Buat Pesanan". Cek menu Pesanan Saya di Shopee.',
        );
      }
      if (['buying', 'to_checkout', 'cart', 'checkout'].includes(phase)) return doCheckout(ctx);
    }
    showOverlay((FB.PHASE_LABELS[phase] || 'Berjalan') + '…');
  }

  // ── Menunggu T=0 ────────────────────────────────────────────────────────────

  function showCountdown(ctx, page) {
    const loggedOut = page === 'product' && dom.findClickable(document, ['log in', 'login'], { mode: 'exact' });
    const note = loggedOut ? 'Sepertinya kamu belum login Shopee.' : 'Jangan tutup tab ini.';
    const label = ctx.run.dryRun ? 'Menunggu flash sale · uji coba' : 'Menunggu flash sale';
    const render = () => {
      const left = ctx.run.saleTime - ctx.serverNow();
      showOverlay(label + '\n' + note, loggedOut ? 'warn' : '', FB.formatDuration(Math.max(0, left)));
    };
    render();
    countdownTimer = setInterval(render, 250);
  }

  // ── Halaman produk ──────────────────────────────────────────────────────────

  async function retryReload(ctx, reason) {
    const res = await send({ type: 'retryReload', runId: ctx.run.id, reason });
    if (!res || !res.allowed) return false;
    showOverlay(reason + ' — muat ulang (' + res.reloads + '/' + res.max + ')', 'warn');
    await ctx.sleep(700);
    location.reload();
    return true;
  }

  async function doProduct(ctx) {
    const { texts } = ctx;
    ctx.log('Halaman produk termuat — mencari tombol "Beli Sekarang"');

    const ready = await ctx.wait(
      () => dom.findClickable(document, texts.buyNow) || dom.pageHasText(document, texts.soldOut),
      ctx.stepTimeout,
    );
    if (!ready) {
      if (await retryReload(ctx, 'Tombol "Beli Sekarang" belum muncul')) return;
      return ctx.finish(
        'failed',
        'Tombol "Beli Sekarang" tidak ditemukan. Cek teks tombol di Pengaturan › Lanjutan.',
      );
    }

    // Flash sale belum mulai? (mis. jam komputer/jadwal meleset) — jangan beli di harga normal.
    const notStarted = dom.pageHasText(document, texts.notStarted);
    if (notStarted) {
      if (ctx.run.kind === 'test') {
        ctx.log('Info: halaman menampilkan "' + notStarted + '" (wajar saat uji sekarang).');
      } else {
        const gone = await ctx.wait(() => !dom.pageHasText(document, texts.notStarted), 2500);
        if (!gone) {
          if (await retryReload(ctx, 'Flash sale belum dimulai ("' + notStarted + '")')) return;
          return ctx.finish(
            'failed',
            'Flash sale belum dimulai setelah ' + ctx.run.reloads + ' kali muat ulang ("' + notStarted +
              '"). Pesanan tidak dibuat supaya tidak membeli di harga normal. Cek jadwal task.',
          );
        }
      }
    }

    // Varian
    for (const name of ctx.task.variants) {
      const found = await ctx.wait(() => dom.findVariant(document, name), 5000);
      if (!found) {
        const options = dom.listVariantOptions(document, texts.buyNow.concat(['masukkan keranjang', 'chat']));
        return ctx.finish(
          'failed',
          'Varian "' + name + '" tidak ditemukan.' +
            (options.length ? ' Pilihan yang terlihat: ' + options.slice(0, 12).join(', ') : ''),
        );
      }
      if (found.disabled) return ctx.finish('failed', 'Varian "' + name + '" habis atau tidak bisa dipilih.');
      if (!found.selected) {
        const observable = ['aria-checked', 'aria-pressed', 'aria-selected'].some((a) => found.el.hasAttribute(a)) ||
          /variation|option|variant/i.test(found.el.getAttribute('class') || '');
        dom.click(found.el);
        if (observable) {
          const ok = await ctx.wait(() => {
            const v = dom.findVariant(document, name);
            return v && v.selected;
          }, 600);
          if (!ok) ctx.log('Varian "' + name + '" diklik (status terpilih tidak terbaca).');
        } else {
          await ctx.sleep(80);
        }
      }
      ctx.log('Varian "' + name + '" dipilih');
    }

    // Jumlah
    if (ctx.task.quantity > 1) {
      const input = await ctx.wait(() => dom.findQuantityInput(document, texts.quantityLabel), 3000);
      if (!input) return ctx.finish('failed', 'Kolom jumlah (kuantitas) tidak ditemukan.');
      dom.setInputValue(input, ctx.task.quantity);
      await ctx.sleep(200);
      const got = parseInt(input.value, 10);
      if (got === ctx.task.quantity) ctx.log('Jumlah diatur: ' + got);
      else if (Number.isFinite(got) && got >= 1) ctx.log('Shopee membatasi jumlah menjadi ' + got + '.');
      else return ctx.finish('failed', 'Gagal mengatur jumlah.');
    }

    // Beli Sekarang
    let btn = dom.findClickable(document, texts.buyNow);
    if (!btn || dom.isDisabled(btn)) {
      btn = await ctx.wait(() => {
        const b = dom.findClickable(document, texts.buyNow);
        return b && !dom.isDisabled(b) ? b : null;
      }, 3000);
    }
    if (!btn) {
      const soldOut = dom.pageHasText(document, texts.soldOut);
      return ctx.finish(
        'failed',
        soldOut ? 'Stok habis ("' + soldOut + '").' : 'Tombol "Beli Sekarang" tidak aktif.',
      );
    }

    const before = dom.collectAlerts(document);
    await ctx.phase('to_checkout', 'Klik "Beli Sekarang"');
    dom.click(btn);
    return waitForNavigation(ctx, before, 'Tidak pindah ke keranjang/checkout setelah klik "Beli Sekarang".');
  }

  /**
   * Setelah klik yang seharusnya memindahkan halaman: tunggu URL berubah
   * (→ Aborted, ditangani route berikutnya). Bila malah muncul pop-up dan
   * halaman tetap di tempat, laporkan isi pop-up itu.
   */
  async function waitForNavigation(ctx, before, fallbackMessage) {
    const alert = await ctx.wait(() => dom.newAlert(document, before), ctx.stepTimeout);
    if (alert) {
      await ctx.sleep(4000); // beri waktu kalau pop-up hanya info sebelum pindah halaman
      return ctx.finish('failed', 'Shopee menampilkan pesan: "' + alert + '"');
    }
    return ctx.finish('failed', fallbackMessage);
  }

  // ── Keranjang ───────────────────────────────────────────────────────────────

  async function doCart(ctx) {
    const { texts } = ctx;
    if (ctx.run.phase !== 'cart') await ctx.phase('cart', 'Di keranjang — mencari tombol "Checkout"');
    const btn = await ctx.wait(() => {
      const b = dom.findClickable(document, texts.cartCheckout);
      return b && !dom.isDisabled(b) ? b : null;
    }, ctx.stepTimeout);
    if (!btn) {
      return ctx.finish('failed', 'Tombol "Checkout" di keranjang tidak ditemukan atau tidak aktif (tidak ada produk terpilih?).');
    }
    const before = dom.collectAlerts(document);
    await ctx.phase('to_checkout', 'Klik "Checkout"');
    dom.click(btn);
    return waitForNavigation(ctx, before, 'Tidak pindah ke halaman checkout setelah klik "Checkout".');
  }

  // ── Checkout ────────────────────────────────────────────────────────────────

  async function doCheckout(ctx) {
    const { texts } = ctx;
    if (ctx.run.phase !== 'checkout') await ctx.phase('checkout', 'Halaman checkout termuat');

    const findPlace = () => dom.findClickable(document, texts.placeOrder);
    let place = await ctx.wait(findPlace, ctx.stepTimeout);
    if (!place) return ctx.finish('failed', 'Tombol "Buat Pesanan" tidak ditemukan. Cek teks tombol di Pengaturan › Lanjutan.');

    // Metode pembayaran, mis. "Transfer Bank > Bank BCA"
    for (const step of FB.splitList(ctx.task.payment, '>')) {
      const el = await ctx.wait(() => dom.findClickable(document, [step], { mode: 'contains' }), 5000);
      if (!el) return ctx.finish('failed', 'Metode pembayaran "' + step + '" tidak ditemukan.');
      if (dom.isDisabled(el)) return ctx.finish('failed', 'Metode pembayaran "' + step + '" tidak tersedia untuk pesanan ini.');
      if (!dom.isSelected(el)) dom.click(el);
      await ctx.sleep(400);
      ctx.log('Pembayaran: "' + step + '" dipilih');
    }

    // Harga maksimal
    let priceNote = '';
    let total = dom.readTotal(document, texts.totalLabel);
    if (ctx.task.maxPrice) {
      if (total == null) total = await ctx.wait(() => dom.readTotal(document, texts.totalLabel), 5000);
      if (total == null) {
        return ctx.finish(
          'failed',
          'Tidak bisa membaca "Total Pembayaran". Pesanan tidak dibuat demi keamanan karena harga maksimal aktif.',
        );
      }
      if (total > ctx.task.maxPrice) {
        const over = 'Total ' + FB.formatRupiah(total) + ' melebihi harga maksimal ' + FB.formatRupiah(ctx.task.maxPrice);
        if (ctx.run.kind !== 'test') return ctx.finish('failed', over + ' — pesanan tidak dibuat.', { total });
        // Uji sekarang biasanya berjalan sebelum flash sale (harga normal) → cukup peringatan.
        priceNote = ' Catatan: ' + over + '; saat flash sale nanti pesanan otomatis dibatalkan bila harganya masih setinggi ini.';
        ctx.log(over + ' (wajar saat uji sebelum flash sale).');
      }
    }
    if (total != null) ctx.log('Total pembayaran: ' + FB.formatRupiah(total));

    place = findPlace() || place;

    if (ctx.run.dryRun) {
      dom.highlight(place);
      return ctx.finish(
        'dry_run_ok',
        'Semua langkah berhasil sampai tombol "Buat Pesanan". Pesanan TIDAK dibuat.' + priceNote,
        { total },
      );
    }

    if (dom.isDisabled(place)) {
      place = await ctx.wait(() => {
        const b = findPlace();
        return b && !dom.isDisabled(b) ? b : null;
      }, 5000);
      if (!place) return ctx.finish('failed', 'Tombol "Buat Pesanan" tidak aktif.');
    }

    const before = dom.collectAlerts(document);
    await ctx.phase('placing', 'Klik "Buat Pesanan"', { total });
    dom.click(place);

    // Sukses dideteksi background saat tab pindah dari halaman checkout.
    // Di sini kita hanya mencatat pop-up penolakan selama 20 detik.
    const deadline = Date.now() + 20000;
    let lastAlert = null;
    while (Date.now() < deadline) {
      const alert = await ctx.wait(() => dom.newAlert(document, before), Math.max(1, deadline - Date.now()));
      if (!alert) break;
      lastAlert = alert;
      before.push(alert);
    }
    if (lastAlert) {
      return ctx.finish(
        'failed',
        'Setelah klik "Buat Pesanan", Shopee menampilkan: "' + lastAlert + '". Cek tab Shopee untuk memastikan.',
        { total },
      );
    }
    return ctx.finish('unknown', 'Tidak ada konfirmasi dari Shopee dalam 20 detik. Cek menu Pesanan Saya.', { total });
  }

  // ── Mulai ───────────────────────────────────────────────────────────────────

  setInterval(checkRoute, 200);
  new MutationObserver(checkRoute).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', checkRoute);
  checkRoute();
})();
