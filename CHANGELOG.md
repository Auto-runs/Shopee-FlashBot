# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/).

## [Unreleased]

## [1.0.0]

Rilis publik pertama.

### Ditambahkan
- Chrome extension yang berjalan di browser dan akun Shopee pengguna sendiri, pengganti prototipe Python.
- Jadwal flash sale: tab produk dibuka menjelang waktu, lalu dimuat ulang tepat T=0 menurut jam server Shopee.
- Alur varian → jumlah → Beli Sekarang → Checkout → metode pembayaran → Buat Pesanan.
- Mode uji coba dan tombol **Uji** yang berhenti sebelum Buat Pesanan.
- Pengaman: harga maksimal, tidak membeli di harga normal bila flash sale belum mulai, Buat Pesanan tidak pernah diklik dua kali.
- Banyak task bersamaan, notifikasi Telegram, dan riwayat per langkah dengan tombol **Salin laporan** untuk GitHub Issue.
- Teks tombol Shopee bisa diubah dari halaman pengaturan.
- Tampilan dengan hitung mundur, progres langkah, dan mode gelap.

### Diperbaiki
- Waktu muat ulang kini memakai batas bawah perkiraan jam server. Sebelumnya, di jaringan lambat bot bisa memuat ulang sedikit terlalu cepat lalu terlambat ±3,5 detik karena harus menunggu dan memuat ulang lagi.
- Muat ulang ulang saat flash sale ternyata belum dimulai kini lebih cepat (±1 detik, sebelumnya ±3 detik).
