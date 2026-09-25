// Harness Playwright: jalankan Chromium dengan extension FlashBot terpasang.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { MockShopee } from './mock-shopee.mjs';

export const EXT_PATH =
  process.env.FLASHBOT_EXT_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

function executablePath() {
  // Opsional: pakai Chromium tertentu (mis. bila browser Playwright tidak diunduh).
  const custom = process.env.CHROMIUM_PATH;
  return custom && existsSync(custom) ? custom : undefined;
}

export async function launch({ skewMs = 0 } = {}) {
  const mock = await new MockShopee({ skewMs }).start();
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    executablePath: executablePath(),
    ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, ...mock.chromiumArgs()],
  });

  const errors = [];
  const watchPage = (p) => {
    p.on('pageerror', (err) => errors.push(`[pageerror] ${p.url()} ${err.message}`));
    p.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = p.url();
      // Hanya error dari halaman extension & shopee tiruan yang relevan.
      if (url.startsWith('chrome-extension://') || url.includes('shopee.co.id')) {
        errors.push(`[console] ${url} ${msg.text()}`);
      }
    });
  };
  context.on('page', watchPage);
  context.pages().forEach(watchPage);

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => self.__flashbot.ready);

  const api = {
    context,
    mock,
    sw,
    extId,
    errors,
    ui: (msg) => sw.evaluate((m) => self.__flashbot.handleUi(m), msg),
    state: () => sw.evaluate(() => JSON.parse(JSON.stringify(self.__flashbot.S))),
    async settings(settings) {
      const res = await api.ui({ type: 'ui:saveSettings', settings });
      if (!res.ok) throw new Error('saveSettings gagal: ' + JSON.stringify(res));
      return res.settings;
    },
    async addTask(task) {
      const res = await api.ui({ type: 'ui:saveTask', task });
      if (!res.ok) throw new Error('saveTask gagal: ' + JSON.stringify(res));
      return res.task;
    },
    /** Tunggu run untuk task selesai (masuk riwayat). */
    async waitForRun(taskId, { timeout = 45000, kind } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const runs = await sw.evaluate(() => self.__flashbot.S.runs);
        const run = runs.find((r) => r.taskId === taskId && (!kind || r.kind === kind));
        if (run) return run;
        await new Promise((r) => setTimeout(r, 200));
      }
      const s = await api.state();
      throw new Error('Run tidak selesai dalam batas waktu. Aktif: ' + JSON.stringify(s.active, null, 2));
    },
    async waitFor(fn, { timeout = 10000, interval = 100 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const v = await fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error('waitFor: batas waktu habis');
    },
    async close() {
      await context.close();
      await mock.stop();
    },
  };
  return api;
}

/** Ringkas langkah run untuk pesan assert yang informatif. */
export function describeRun(run) {
  return JSON.stringify({ status: run.status, message: run.message, steps: (run.steps || []).map((s) => s.msg) }, null, 2);
}
