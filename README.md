<div align="center">
  <img src="extension/icons/icon128.png" width="72" alt="" />

# FlashBot Checkout

Chrome extension untuk **checkout otomatis flash sale Shopee Indonesia tepat waktu**,
langsung dari browser dan akun Shopee kamu sendiri.

<img src="https://img.shields.io/badge/Chrome-Manifest%20V3-orange?style=flat-square"/>
<img src="https://img.shields.io/badge/license-MIT-green?style=flat-square"/>

</div>

---

## ✨ Fitur

- 🕐 **Tepat T=0 menurut jam server Shopee.** Selisih jam komputer dihitung otomatis dari server, jadi jam komputer yang meleset tidak masalah.
- 🛒 **Alur beli lengkap.** Pilih varian → atur jumlah → **Beli Sekarang** → **Checkout** → pilih metode pembayaran → **Buat Pesanan**.
- 🧪 **Mode uji coba & tombol "Uji sekarang".** Jalankan semua langkah di akunmu kapan saja, berhenti tepat sebelum "Buat Pesanan".
- 🛡️ **Pengaman:**
  - **Harga maksimal**: batal kalau total melebihi batas.
  - **Tidak membeli di harga normal** bila flash sale belum mulai.
  - **"Buat Pesanan" tidak pernah diklik dua kali.**
- 📋 **Banyak task sekaligus.** Beberapa produk dan jadwal, masing-masing di tab sendiri.
- 📲 **Notifikasi Telegram** saat bot siap, berhasil, gagal, atau jadwal terlewat.
- ⚙️ **Tampilan pengaturan lengkap**, plus riwayat dengan detail tiap langkah (sampai milidetik).
- 🔧 **Tahan perubahan tampilan Shopee.** Tombol dicari berdasarkan teksnya; teks bisa diubah dari halaman pengaturan tanpa update kode.
- 🔒 **Aman:** tidak ada password atau cookie yang disalin atau dikirim ke mana pun. Semua berjalan di browser pengguna.

## 📦 Cara pasang (untuk pengguna)

1. Ekstrak file `flashbot-checkout-v1.0.0.zip` ke sebuah folder (jangan dihapus setelah dipasang).
2. Buka Chrome → ketik `chrome://extensions` di address bar.
3. Aktifkan **Developer mode** (pojok kanan atas).
4. Klik **Load unpacked** → pilih folder hasil ekstrak.
5. Halaman pengaturan FlashBot terbuka otomatis. Pin ikon ⚡ di toolbar supaya mudah diakses.

## ▶️ Cara pakai

1. **Login Shopee** di Chrome yang sama, lalu pastikan **alamat utama** sudah benar.
2. Buka FlashBot → **+ Tambah task** → isi:
   - link produk
   - jam flash sale
   - varian (opsional)
   - jumlah
   - harga maksimal (disarankan)
   - metode pembayaran (opsional)
3. Klik **Uji sekarang**. Bot membuka tab baru dan menjalankan semua langkah tanpa membuat pesanan. Cek hasilnya di tab **Riwayat**.
4. Kalau uji coba berhasil: **Edit** task → matikan **Mode uji coba** → Simpan.
5. Biarkan komputer menyala dan Chrome terbuka. Sekitar 60 detik sebelum flash sale, bot membuka tab produk. Tepat di T=0 halaman dimuat ulang dan pembelian berjalan otomatis.
6. Setelah berhasil, selesaikan pembayaran di tab Shopee.

**Tips**
- Metode pembayaran bertingkat ditulis dengan `>`, misalnya `Transfer Bank > Bank BCA` atau `Ubah > ShopeePay`.
- Kosongkan item lain yang tercentang di keranjang supaya hanya produk target yang di-checkout.

## 📲 Notifikasi Telegram

1. Di Telegram buka **@BotFather** → `/newbot` → salin token.
2. Tempel token di tab **Notifikasi**, buka bot kamu dan kirim `/start`.
3. Klik **Deteksi otomatis** → centang **Aktifkan** → **Simpan** → **Kirim pesan tes**.

## ❓ Kalau gagal

| Pesan | Solusi |
|---|---|
| Varian "…" tidak ditemukan | Samakan tulisan varian dengan tombol di halaman produk (pesan error menampilkan pilihan yang terlihat). |
| Tombol "…" tidak ditemukan | Shopee mengganti tulisan tombol → perbarui di **Lanjutan › Teks tombol**. |
| Shopee meminta login / verifikasi | Selesaikan manual di tab itu. FlashBot **tidak** melewati captcha/verifikasi. |
| Flash sale belum dimulai | Cek lagi jam flash sale di task. |
| Total melebihi harga maksimal | Harga saat itu lebih mahal dari batasmu, jadi pesanan sengaja tidak dibuat. |

## ⚠️ Batasan & disclaimer

- Komputer harus menyala dan Chrome terbuka saat flash sale. Kalau terlewat, kamu akan dikabari.
- Stok flash sale sangat terbatas: **keberhasilan membeli tidak dijamin.**
- FlashBot **tidak berafiliasi dengan Shopee**. Penggunaan alat otomatis dapat bertentangan dengan Syarat & Ketentuan Shopee dan berisiko pada akun; gunakan dengan tanggung jawab sendiri.
- FlashBot sengaja **tidak** membongkar proteksi Shopee, tidak melewati captcha, dan tidak menyembunyikan diri dari deteksi. FlashBot hanya mengklik tombol yang sama seperti yang kamu klik manual.

---

## 🛠️ Untuk pengembang / penjual

### Struktur

```
extension/                 ← isi yang dibagikan ke pengguna
├── manifest.json
├── icons/
└── src/
    ├── background.js      service worker: jadwal, jam server, T=0, hasil, Telegram
    ├── content.js         langkah di halaman Shopee (produk → keranjang → checkout)
    ├── lib/core.js        logika murni (validasi, waktu, harga, URL, Telegram)
    ├── lib/dom.js         pencarian tombol berbasis teks, tunggu elemen, baca total
    ├── options/           halaman pengaturan
    ├── popup/             popup toolbar
    └── ui/theme.css       tema bersama (terang/gelap)
scripts/                   make-icons.mjs, pack.mjs
test/unit/                 unit test (node:test + jsdom)
test/e2e/                  end-to-end: Chromium asli + Shopee tiruan (server HTTPS lokal)
legacy-python/             prototipe lama berbasis API (tidak dipakai)
```

### Cara kerja singkat

1. Task disimpan → background menghitung selisih jam server Shopee (header HTTP `Date`, dipersempit dari beberapa sampel hingga ± waktu tempuh jaringan).
2. `leadSeconds` sebelum T=0 → tab produk dibuka, lalu timer presisi di service worker menunggu T=0 (+`reloadDelayMs`) menurut jam server → tab dimuat ulang.
3. Content script bertanya ke background "apa tugas tab ini?" setiap URL berubah (termasuk navigasi SPA). Fase disimpan di background **sebelum** setiap klik penting, jadi muat ulang halaman tidak mengulang klik.
4. Sukses terdeteksi saat tab meninggalkan halaman checkout setelah "Buat Pesanan". Pop-up penolakan dicatat sebagai gagal.

### Perintah

```bash
npm install          # dependensi pengembangan (Playwright, jsdom, ESLint)
npm run lint         # ESLint
npm test             # unit test
npm run test:e2e     # end-to-end di Chromium (butuh openssl untuk sertifikat tes)
npm run pack         # → dist/flashbot-checkout-v<versi>.zip untuk dibagikan
```

Test end-to-end menjalankan extension asli di Chromium melawan Shopee tiruan. Skenario yang dicakup:
- beli tepat waktu dengan jam komputer meleset
- mode uji coba
- pembayaran bertingkat
- harga maksimal
- varian habis
- pesanan ditolak
- dua task bersamaan
- belum login
- tab ditutup atau dibatalkan
- jadwal terlewat
- pengaman harga normal
- seluruh halaman pengaturan dan popup

### Checklist sebelum rilis

- [ ] Naikkan `version` di `extension/manifest.json` (dan `package.json`).
- [ ] `npm run lint && npm test && npm run test:e2e` lulus.
- [ ] **Uji di Shopee asli** dengan akun sungguhan: jalankan **Uji sekarang** untuk minimal satu produk tanpa varian, satu dengan varian, dan satu dengan metode pembayaran bertingkat. Cek Riwayat.
- [ ] `npm run pack` → bagikan zip dari `dist/`.

## 📄 Lisensi

MIT
