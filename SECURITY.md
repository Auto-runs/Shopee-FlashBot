# Keamanan & privasi

## Data apa yang disimpan

Semua data (task, pengaturan, riwayat, token Telegram) disimpan di `chrome.storage.local` di komputer pengguna. Tidak ada server FlashBot.

## Ke mana extension terhubung

- `shopee.co.id`: halaman yang dibuka pengguna, plus request `HEAD` ke halaman utama untuk membaca jam server.
- `api.telegram.org`: hanya bila notifikasi Telegram diaktifkan, untuk mengirim pesan ke bot milik pengguna sendiri.

Extension tidak membaca atau mengirim password maupun cookie.

## Melaporkan celah keamanan

Jangan laporkan celah keamanan lewat issue publik. Gunakan **Security → Report a vulnerability** di halaman repositori GitHub ini.
