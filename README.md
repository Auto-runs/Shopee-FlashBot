<div align="center">
  <img src="https://img.shields.io/badge/SHOPEE-FLASH%20BOT-orange?style=for-the-badge&logo=shopee&logoColor=white"/>
  
  <p>Automated Shopee Flash Sale bot that fires concurrent checkout requests at T=0 with NTP time synchronisation.</p>

  <img src="https://img.shields.io/github/stars/Auto-runs/Shopee-FlashBot?style=flat-square"/>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square"/>
  <img src="https://img.shields.io/badge/python-3.11+-blue?style=flat-square"/>
</div>

# ⚡ Shopee Flash Sale Bot

Bot otomatis untuk checkout item flash sale Shopee tepat di T=0 menggunakan concurrent requests dan NTP time synchronisation.

---

## ✨ Fitur

- 🕐 **NTP Time Sync** — sinkronisasi waktu akurat ±1-5ms via `pool.ntp.org`
- 🚀 **Concurrent Checkout** — 5 request checkout dikirim serentak di T=0
- 🍪 **Cookie Auth** — login via export cookies browser, tanpa perlu password
- 🔄 **Auto Retry** — exponential backoff untuk handle rate limit & network error
- 📦 **Pre-built Payload** — cart payload disiapkan sebelum T=0 untuk zero overhead
- 📋 **Structured Logging** — log detail setiap phase ke console dan file

---

## 🗂️ Struktur Project

```
shopee_botflash/
├── main.py                  # Orchestrator utama
├── config/
│   └── settings.py          # Semua konfigurasi & URL
├── modules/
│   ├── __init__.py
│   ├── auth.py              # Cookie injection & authentication
│   ├── cart.py              # Add to cart & payload builder
│   ├── checkout_engine.py   # Concurrent checkout executor
│   ├── logger.py            # Logging setup
│   ├── product_monitor.py   # Product availability checker
│   ├── session_manager.py   # HTTP session & retry wrapper
│   └── time_sync.py         # NTP clock synchronisation
├── sessions/
│   └── mysession.json       # ← TIDAK di-commit (berisi cookies)
├── logs/                    # ← TIDAK di-commit
├── .env                     # ← TIDAK di-commit (berisi credentials)
└── .env.example             # Template konfigurasi
```

---

## ⚙️ Setup

### 1. Clone & Install dependencies

```bash
git clone https://github.com/username/shopee_botflash.git
cd shopee_botflash
python -m venv venv
venv\Scripts\activate        # Windows
pip install aiohttp python-dotenv ntplib
```

### 2. Konfigurasi `.env`

Buat file `.env` dari template:

```bash
cp .env.example .env
```

Isi dengan data kamu:

```env
SHOPEE_USER=username_kamu
SHOPEE_SHOP_ID=1234567890
SHOPEE_ITEM_ID=9876543210
SHOPEE_MODEL_ID=1122334455
SHOPEE_TARGET_TS=1773205200
SHOPEE_QUANTITY=1
SHOPEE_ADDRESS_ID=           # opsional
SHOPEE_PAYMENT_ID=           # opsional
```

> **Cara dapat `SHOPEE_TARGET_TS`:** Jalankan di browser console:
> ```js
> new Date('2026-03-11T12:00:00+07:00').getTime() / 1000
> ```

### 3. Export cookies dari browser

1. Login ke [shopee.co.id](https://shopee.co.id) di Chrome
2. Install extension **Cookie-Editor**
3. Export cookies → format JSON
4. Simpan ke `sessions/mysession.json`

### 4. Dapat `MODEL_ID`

Jalankan di browser console saat di halaman produk:

```js
fetch(`/api/v4/pdp/get_pc?item_id=ITEM_ID&shop_id=SHOP_ID`, {
  credentials: 'include'
})
.then(r => r.json())
.then(d => d.data.item.models.forEach(m => 
  console.log(m.name, '→ model_id:', m.model_id)
));
```

---

## ▶️ Cara Pakai

```bash
python main.py
```

Bot akan otomatis:
1. Inject cookies & verifikasi login
2. Sync waktu via NTP
3. Countdown sampai ~30 detik sebelum flash sale
4. Add to cart
5. Fire 5 concurrent checkout request tepat di T=0

### Output sukses:
```
🎉 ORDER BERHASIL!
   Order ID   : 123456789
   Latency    : 87.3 ms
   Total time : 0.234 s
```

---

## ⚠️ Penting

- **Jangan tutup terminal** selama bot berjalan
- **Sync jam Windows** sebelum menjalankan: `w32tm /resync /force` (Run as Admin)
- **Export ulang cookies** setiap kali session expired
- File `.env` dan `sessions/` **tidak boleh di-commit** ke GitHub

---

## 📋 Environment Variables

| Variable | Wajib | Keterangan |
|---|---|---|
| `SHOPEE_USER` | ✅ | Username/email akun Shopee |
| `SHOPEE_SHOP_ID` | ✅ | ID toko dari URL produk |
| `SHOPEE_ITEM_ID` | ✅ | ID item dari URL produk |
| `SHOPEE_MODEL_ID` | ✅ | ID varian/model produk |
| `SHOPEE_TARGET_TS` | ✅ | Unix timestamp waktu flash sale |
| `SHOPEE_QUANTITY` | ❌ | Jumlah beli (default: 1) |
| `SHOPEE_ADDRESS_ID` | ❌ | ID alamat pengiriman |
| `SHOPEE_PAYMENT_ID` | ❌ | ID metode pembayaran |

---

## 📄 License

MIT License — bebas digunakan dan dimodifikasi.
