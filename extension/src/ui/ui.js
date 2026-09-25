/*
 * ui.js — helper tampilan bersama untuk halaman pengaturan & popup.
 * Membutuhkan core.js dan icons.js.
 */
(function (root) {
  'use strict';

  const FB = root.FB;

  /** Buat elemen DOM tanpa innerHTML (aman dari data pengguna). */
  function h(tag, attrs, ...children) {
    const el = root.document.createElement(tag);
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
      el.append(child instanceof root.Node ? child : root.document.createTextNode(String(child)));
    }
    return el;
  }

  const STATUS_UI = {
    success: { icon: 'ok', tone: 'ok' },
    dry_run_ok: { icon: 'flask', tone: 'ok' },
    failed: { icon: 'fail', tone: 'bad' },
    missed: { icon: 'clock', tone: 'bad' },
    cancelled: { icon: 'ban', tone: 'muted' },
    unknown: { icon: 'warn', tone: 'warn' },
  };

  /** Ikon status berwarna. */
  function statusIcon(status, size) {
    const ui = STATUS_UI[status] || { icon: 'warn', tone: 'muted' };
    const el = FB.icon(ui.icon, size || 16);
    el.classList.add('tone-' + ui.tone);
    el.setAttribute('title', FB.describeStatus(status).label);
    return el;
  }

  const STEPS = ['Menunggu T=0', 'Halaman produk', 'Checkout', 'Buat pesanan'];
  const PHASE_STEP = { armed: 0, buying: 1, to_checkout: 1, cart: 2, checkout: 2, placing: 3 };

  /** Progres 4 langkah untuk run yang sedang berjalan. */
  function stepper(phase) {
    const current = PHASE_STEP[phase] == null ? 0 : PHASE_STEP[phase];
    return h(
      'ol',
      { class: 'stepper', 'aria-label': 'Progres' },
      STEPS.map((label, i) =>
        h('li', { class: i < current ? 'done' : i === current ? 'current' : '', 'aria-current': i === current ? 'step' : null }, label),
      ),
    );
  }

  function modeTag(task) {
    return task.dryRun ? h('span', { class: 'tag', text: 'Uji coba' }) : h('span', { class: 'tag buy', text: 'Beli sungguhan' });
  }

  function lastStep(run) {
    return run.steps && run.steps.length ? run.steps[run.steps.length - 1].msg : '';
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function clock(ms) {
    const d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function dayLabel(ms) {
    const d = new Date(ms);
    const days = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, today)) return 'Hari ini';
    if (same(d, tomorrow)) return 'Besok';
    return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()];
  }

  /** Waktu server terbaik yang diketahui halaman ini. */
  function serverNow(timeSync) {
    return Date.now() + (timeSync && timeSync.source === 'shopee' ? timeSync.offsetMs : 0);
  }

  /** Perbarui semua [data-countdown] (nilai = epoch ms target). */
  function tickCountdowns(now, scope) {
    for (const el of (scope || root.document).querySelectorAll('[data-countdown]')) {
      const left = Number(el.dataset.countdown) - now;
      const prefix = el.dataset.prefix || '';
      el.textContent = left > 0 ? prefix + FB.formatDuration(left) : el.dataset.done || 'dimulai';
    }
  }

  FB.ui = { h, statusIcon, stepper, modeTag, lastStep, clock, dayLabel, serverNow, tickCountdowns, STATUS_UI };
})(globalThis);
