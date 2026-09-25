# Berkontribusi

Kontribusi dalam bentuk apa pun diterima: laporan masalah, perbaikan teks tombol, kode, atau dokumentasi.

## Kontribusi paling berguna: Shopee berubah

Tampilan Shopee sering berubah. Kalau sebuah tombol tidak lagi ditemukan:

1. Coba dulu ubah teksnya di **Pengaturan › Lanjutan › Teks tombol**.
2. Kalau berhasil, buka Pull Request yang menambahkan teks baru itu ke `DEFAULT_TEXTS` di `extension/src/lib/core.js`, supaya semua pengguna ikut terbantu.
3. Kalau tidak berhasil, buat [issue](../../issues/new?template=bug_report.yml) dengan hasil **Salin laporan** dari Riwayat.

## Menjalankan proyek

Butuh Node.js 20+ dan `openssl` (untuk sertifikat test).

```bash
npm install
npx playwright install chromium   # sekali saja
npm run lint
npm test            # unit test
npm run test:e2e    # extension asli di Chromium melawan Shopee tiruan
npm run pack        # → dist/flashbot-checkout-v<versi>.zip
```

Pasang versi pengembangan: `chrome://extensions` → aktifkan **Developer mode** → **Load unpacked** → pilih folder `extension/`. Setelah mengubah kode, klik ikon muat ulang di kartu extension.

## Struktur

| Lokasi | Isi |
|---|---|
| `extension/src/background.js` | Service worker: jadwal, jam server, T=0, hasil, Telegram |
| `extension/src/content.js` | Langkah di halaman Shopee (produk → keranjang → checkout) |
| `extension/src/lib/core.js` | Logika murni: validasi, waktu, harga, URL, pesan |
| `extension/src/lib/dom.js` | Cari tombol berdasarkan teks, tunggu elemen, baca total |
| `extension/src/options/`, `popup/` | Tampilan |
| `test/e2e/mock-shopee.mjs` | Shopee tiruan untuk test |

## Aturan Pull Request

- Semua perintah di atas harus lulus. CI menjalankannya otomatis.
- Perubahan perilaku disertai test. Untuk alur di halaman Shopee, tambahkan skenario di `test/e2e/flow.test.mjs` dan tiru tampilannya di `mock-shopee.mjs`.
- Catat perubahan di bagian `[Unreleased]` pada `CHANGELOG.md`.

## Yang tidak diterima

Kontribusi untuk melewati captcha/verifikasi, membongkar atau meniru header keamanan Shopee, menyembunyikan otomatisasi dari deteksi, atau memakai banyak akun untuk mengakali batas pembelian. FlashBot hanya mengklik tombol yang sama seperti pengguna.

## Merilis versi baru (maintainer)

1. Naikkan `version` di `extension/manifest.json` dan `package.json`.
2. Pindahkan isi `[Unreleased]` di `CHANGELOG.md` ke bagian versi baru.
3. `git tag v<versi> && git push origin v<versi>`. Workflow **Release** menjalankan semua test lalu menerbitkan zip ke halaman Releases.
