/*
 * dom.js — helper DOM untuk content script.
 *
 * Semua pencarian elemen berbasis TEKS yang terlihat (bukan nama class),
 * karena class Shopee diacak dan sering berubah. Daftar teks bisa diubah
 * dari halaman pengaturan tanpa update kode.
 */
(function (root) {
  'use strict';

  const FB = root.FB || (root.FB = {});
  const { normalizeText, matchScore, parseRupiah } = FB;

  const INTERACTIVE = [
    'button',
    '[role="button"]',
    '[role="radio"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="menuitem"]',
    'a[href]',
    'label',
    'input[type="button"]',
    'input[type="submit"]',
  ].join(',');

  const ALERT_SELECTOR = [
    '[role="alert"]',
    '[role="alertdialog"]',
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[class*="toast" i]',
    '[class*="popup" i]',
    '[class*="modal" i]',
    '[class*="snackbar" i]',
  ].join(',');

  const MAX_LABEL_LENGTH = 80;

  class Aborted extends Error {
    constructor() {
      super('aborted');
      this.name = 'Aborted';
    }
  }

  // ── Status elemen ───────────────────────────────────────────────────────────

  function defaultIsVisible(el) {
    if (!el || !el.isConnected) return false;
    const view = el.ownerDocument.defaultView;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const st = view.getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  const config = { isVisible: defaultIsVisible };

  function isVisible(el) {
    return config.isVisible(el);
  }

  function classText(el) {
    const c = el.getAttribute && el.getAttribute('class');
    return c ? c.toLowerCase() : '';
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return /disabled/.test(classText(el));
  }

  function isSelected(el) {
    if (!el) return false;
    for (const attr of ['aria-checked', 'aria-pressed', 'aria-selected']) {
      if (el.getAttribute(attr) === 'true') return true;
    }
    return /selected/.test(classText(el));
  }

  function labelsOf(el) {
    const out = [];
    const aria = el.getAttribute('aria-label');
    if (aria) out.push(aria);
    const value = el.tagName === 'INPUT' ? el.value : '';
    if (value) out.push(value);
    const text = el.textContent;
    if (text && text.length <= MAX_LABEL_LENGTH * 3) out.push(text);
    return out;
  }

  function bestScore(el, patterns, mode) {
    let best = 0;
    for (const label of labelsOf(el)) {
      if (normalizeText(label).length > MAX_LABEL_LENGTH) continue;
      best = Math.max(best, matchScore(label, patterns, mode));
      if (best === 3) break;
    }
    return best;
  }

  /** Buang kandidat yang membungkus kandidat lain (ambil yang paling dalam). */
  function innermost(list) {
    return list.filter((a) => !list.some((b) => b.el !== a.el && a.el.contains(b.el)));
  }

  function pointerElements(doc, patterns, mode) {
    // Cadangan untuk tombol berbentuk <div> dengan cursor:pointer.
    const view = doc.defaultView;
    const out = [];
    for (const el of doc.body ? doc.body.querySelectorAll('div, span') : []) {
      if (el.children.length > 3) continue;
      const score = bestScore(el, patterns, mode);
      if (!score) continue;
      let node = el;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        if (view.getComputedStyle(node).cursor === 'pointer') break;
      }
      if (node && view.getComputedStyle(node).cursor === 'pointer') out.push({ el: node, score });
    }
    return out;
  }

  /**
   * Cari elemen yang bisa diklik dengan teks cocok.
   * Prioritas: skor kecocokan → yang aktif (tidak disabled) → urutan dokumen.
   */
  function findClickable(doc, patterns, opts) {
    const mode = (opts && opts.mode) || 'prefix';
    let found = [];
    for (const el of doc.querySelectorAll(INTERACTIVE)) {
      const score = bestScore(el, patterns, mode);
      if (score && isVisible(el)) found.push({ el, score });
    }
    if (!found.length) found = pointerElements(doc, patterns, mode).filter((c) => isVisible(c.el));
    found = innermost(found);
    if (!found.length) return null;
    found.sort((a, b) => b.score - a.score || Number(isDisabled(a.el)) - Number(isDisabled(b.el)));
    return found[0].el;
  }

  // ── Varian ──────────────────────────────────────────────────────────────────

  function variantCandidates(doc) {
    const set = new Set(doc.querySelectorAll(INTERACTIVE + ',[aria-label]'));
    return Array.from(set).filter((el) => el.tagName !== 'A' && isVisible(el));
  }

  /** Cari tombol varian berdasarkan nama (persis; cadangan: mengandung, jika unik). */
  function findVariant(doc, name) {
    const candidates = variantCandidates(doc);
    let exact = innermost(
      candidates.map((el) => ({ el, score: bestScore(el, [name], 'exact') })).filter((c) => c.score === 3),
    );
    if (!exact.length) {
      const partial = innermost(
        candidates.map((el) => ({ el, score: bestScore(el, [name], 'contains') })).filter((c) => c.score > 0),
      );
      if (partial.length === 1) exact = partial;
      else return null;
    }
    // Utamakan yang bisa dipilih.
    exact.sort((a, b) => Number(isDisabled(a.el)) - Number(isDisabled(b.el)));
    const el = exact[0].el;
    return { el, disabled: isDisabled(el), selected: isSelected(el) };
  }

  /** Daftar pilihan varian yang terlihat — untuk pesan error yang membantu. */
  function listVariantOptions(doc, exclude) {
    const skip = (exclude || []).map(normalizeText);
    const names = [];
    for (const el of doc.querySelectorAll('button, [role="radio"], [role="option"]')) {
      if (!isVisible(el)) continue;
      const label = normalizeText(el.getAttribute('aria-label') || el.textContent);
      if (!label || label.length > 40 || skip.some((s) => label.startsWith(s))) continue;
      if (!names.includes(label)) names.push(label);
      if (names.length >= 20) break;
    }
    return names;
  }

  // ── Kuantitas ───────────────────────────────────────────────────────────────

  function isQuantityInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'number', 'tel'].includes(type) && isVisible(el);
  }

  function findQuantityInput(doc, labels) {
    const all = doc.body ? doc.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.children.length > 2) continue;
      if (matchScore(el.textContent, labels, 'exact') !== 3) continue;
      let node = el.parentElement;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        const input = Array.from(node.querySelectorAll('input')).find(isQuantityInput);
        if (input) return input;
      }
    }
    const spin = Array.from(doc.querySelectorAll('input[role="spinbutton"]')).find(isQuantityInput);
    if (spin) return spin;
    const numbers = Array.from(doc.querySelectorAll('input[type="number"]')).filter(isQuantityInput);
    return numbers.length === 1 ? numbers[0] : null;
  }

  /** Isi input yang dikontrol framework (React dkk.) supaya perubahan terdeteksi. */
  function setInputValue(input, value) {
    const view = input.ownerDocument.defaultView;
    const desc = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value');
    input.focus();
    if (desc && desc.set) desc.set.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
    input.blur();
  }

  // ── Teks halaman ────────────────────────────────────────────────────────────

  function visibleText(doc) {
    const body = doc.body;
    if (!body) return '';
    const text = typeof body.innerText === 'string' ? body.innerText : body.textContent;
    return normalizeText(text);
  }

  /** Pola pertama yang muncul di teks halaman, atau null. */
  function pageHasText(doc, patterns) {
    const text = visibleText(doc);
    for (const raw of patterns || []) {
      const p = normalizeText(raw);
      if (p && text.includes(p)) return p;
    }
    return null;
  }

  /** Baca angka "Total Pembayaran Rp…" di halaman checkout. */
  function readTotal(doc, labels) {
    const all = doc.body ? doc.body.querySelectorAll('*') : [];
    const norm = (labels || []).map(normalizeText).filter(Boolean);
    for (const el of all) {
      if (el.children.length > 4 || !isVisible(el)) continue;
      const own = normalizeText(el.textContent);
      if (own.length > 60) continue;
      const label = norm.find((l) => own.startsWith(l));
      if (!label) continue;
      let node = el;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        const text = normalizeText(node.textContent);
        const idx = text.indexOf(label);
        if (idx < 0) continue;
        const value = parseRupiah(text.slice(idx + label.length));
        if (value != null) return value;
      }
    }
    return null;
  }

  /** Teks pop-up / toast / dialog yang sedang terlihat. */
  function collectAlerts(doc) {
    const out = [];
    for (const el of doc.querySelectorAll(ALERT_SELECTOR)) {
      if (!isVisible(el)) continue;
      const text = normalizeText(el.textContent);
      if (!text || text.length > 300 || out.includes(text)) continue;
      out.push(text);
    }
    return out;
  }

  /** Pop-up baru yang belum ada di `before`. */
  function newAlert(doc, before) {
    const seen = new Set(before || []);
    return collectAlerts(doc).find((t) => !seen.has(t)) || null;
  }

  // ── Aksi ────────────────────────────────────────────────────────────────────

  function click(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_) {
      /* elemen tanpa layout */
    }
    el.click();
  }

  function highlight(el) {
    try {
      el.style.outline = '3px dashed #ee4d2d';
      el.style.outlineOffset = '3px';
    } catch (_) {
      /* abaikan */
    }
  }

  /**
   * Tunggu sampai fn() mengembalikan nilai truthy.
   * - Dicek ulang setiap ada perubahan DOM (MutationObserver tidak di-throttle
   *   di tab latar belakang) dan tiap 100 ms sebagai cadangan.
   * - Timeout → resolve(null).
   * - alive() false (mis. pindah halaman) → reject(Aborted).
   */
  function waitFor(fn, opts) {
    const timeout = (opts && opts.timeout) || 10000;
    const alive = (opts && opts.alive) || (() => true);
    const doc = (opts && opts.doc) || root.document;
    return new Promise((resolve, reject) => {
      let done = false;
      let observer = null;
      let interval = null;
      let timer = null;
      let queued = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        clearInterval(interval);
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };
      const check = () => {
        queued = false;
        if (done) return;
        if (!alive()) return finish(new Aborted());
        let value;
        try {
          value = fn();
        } catch (err) {
          return finish(err);
        }
        if (value) finish(null, value);
      };
      check();
      if (done) return;
      const View = doc.defaultView;
      observer = new View.MutationObserver(() => {
        if (!queued) {
          queued = true;
          Promise.resolve().then(check);
        }
      });
      observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      interval = setInterval(check, 100);
      timer = setTimeout(() => {
        if (!alive()) finish(new Aborted());
        else finish(null, null);
      }, timeout);
    });
  }

  function sleep(ms, alive, doc) {
    return waitFor(() => false, { timeout: ms, alive, doc });
  }

  FB.dom = {
    config,
    Aborted,
    isVisible,
    isDisabled,
    isSelected,
    findClickable,
    findVariant,
    listVariantOptions,
    findQuantityInput,
    setInputValue,
    visibleText,
    pageHasText,
    readTotal,
    collectAlerts,
    newAlert,
    click,
    highlight,
    waitFor,
    sleep,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = FB.dom;
})(typeof globalThis !== 'undefined' ? globalThis : this);
