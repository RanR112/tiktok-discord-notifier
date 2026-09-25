# tiktok-discord-notifier

Notifikasi Discord otomatis ketika akun TikTok yang dipantau **mulai LIVE** dan ketika **mengunggah video baru**.

- Node.js 20 LTS ke atas, ESM murni (`"type": "module"`)
- **Nol dependency runtime** — hanya API bawaan Node (`fetch`, `process.loadEnvFile`, `node:test`)
- Dua webhook Discord terpisah: satu khusus LIVE, satu khusus konten
- Anti-duplikat yang bertahan setelah restart
- Retry dengan exponential backoff + penghormatan penuh terhadap rate limit Discord

> **Baca dulu: [Keterbatasan](#keterbatasan-yang-harus-kamu-tahu).** Notifikasi LIVE bekerja andal. Notifikasi konten bersifat **best-effort** karena TikTok tidak menyediakan API resmi untuk membaca feed akun orang lain.

---

## Daftar isi

- [Instalasi](#instalasi)
- [Konfigurasi](#konfigurasi)
- [Cara membuat Discord Webhook](#cara-membuat-discord-webhook)
- [Menjalankan](#menjalankan)
- [Membaca log](#membaca-log)
- [Keterbatasan yang harus kamu tahu](#keterbatasan-yang-harus-kamu-tahu)
- [Cara kerja anti-duplikat](#cara-kerja-anti-duplikat)
- [Struktur project](#struktur-project)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Deployment 24/7](#deployment-247)
- [Keamanan](#keamanan)

---

## Instalasi

```bash
# Butuh Node.js 20 LTS ke atas
node --version

npm install          # tidak ada dependency eksternal; hanya menyiapkan project
cp .env.example .env # lalu isi .env (lihat bagian berikutnya)
npm run check-env    # validasi konfigurasi tanpa menyentuh jaringan
npm start
```

---

## Konfigurasi

Semua konfigurasi lewat file `.env`. File ini **tidak pernah di-commit** (sudah ada di `.gitignore`).

### Wajib

| Variable | Keterangan |
|---|---|
| `TIKTOK_USERNAME` | Username TikTok tanpa `@`. Boleh juga ditulis `@user` atau URL lengkap — otomatis dibersihkan. |

Minimal **salah satu** dari webhook berikut harus diisi:

| Variable | Dipakai untuk |
|---|---|
| `DISCORD_LIVE_WEBHOOK_URL` | **Hanya** notifikasi LIVE |
| `DISCORD_CONTENT_WEBHOOK_URL` | **Hanya** notifikasi konten/video |

Kalau salah satu kosong, fitur itu dimatikan dengan `[WARN]` dan fitur lainnya tetap berjalan normal.

### Opsional

| Variable | Default | Keterangan |
|---|---|---|
| `CHECK_INTERVAL` | `60000` | Jeda antar pengecekan (ms). Minimum `15000`. |
| `LIVE_UPDATE_INTERVAL` | `300000` | Jeda minimum antar update jumlah penonton (ms). `0` = matikan update. |
| `MAX_CONTENT_PER_CYCLE` | `3` | Batas notifikasi video per siklus, agar channel tidak banjir. |
| `TIKTOK_CONTENT_PROVIDER` | `web` | `web` \| `official` \| `mock` \| `disabled`. Lihat [Keterbatasan](#keterbatasan-yang-harus-kamu-tahu). |
| `TIKTOK_MOCK_FILE` | `./data/mock-content.json` | Dipakai kalau provider = `mock`. |
| `TIKTOK_CLIENT_KEY`<br>`TIKTOK_CLIENT_SECRET`<br>`TIKTOK_REFRESH_TOKEN` | — | Dipakai kalau provider = `official`. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `STATE_FILE` | `./data/state.json` | Lokasi file anti-duplikat. Harus persisten. |
| `REQUEST_TIMEOUT` | `15000` | Timeout tiap HTTP request (ms). |
| `MAX_RETRIES` | `3` | Jumlah percobaan ulang saat request gagal. |

### Mengubah akun yang dipantau

Ubah `TIKTOK_USERNAME` di `.env`, **lalu hapus `data/state.json`**. Kalau state lama tidak dihapus, id video akun sebelumnya masih tercatat dan akan membingungkan deteksi video baru.

```bash
rm data/state.json
npm start
```

### Mengubah interval

```env
CHECK_INTERVAL=30000    # cek tiap 30 detik (lebih responsif, request lebih sering)
CHECK_INTERVAL=300000   # cek tiap 5 menit (lebih hemat, LIVE bisa telat terdeteksi)
```

Semakin kecil intervalnya, semakin cepat LIVE terdeteksi, tapi semakin besar risiko TikTok memblokir IP kamu. `60000` adalah kompromi yang wajar.

---

## Cara membuat Discord Webhook

Kamu butuh **dua** webhook. Idealnya di dua channel berbeda, misalnya `#tiktok-live` dan `#tiktok-uploads`.

1. Buka Discord → klik kanan channel tujuan → **Edit Channel**
2. **Integrations** → **Webhooks** → **New Webhook**
3. Beri nama (misalnya `TikTok LIVE`), pilih channel, lalu **Copy Webhook URL**
4. Tempel ke `.env`:
   ```env
   DISCORD_LIVE_WEBHOOK_URL=https://discord.com/api/webhooks/1234.../abcd...
   ```
5. Ulangi untuk channel konten dan isi `DISCORD_CONTENT_WEBHOOK_URL`

> URL webhook = kredensial. Siapa pun yang memilikinya bisa mengirim pesan ke channel kamu. Jangan di-share, jangan di-commit, jangan di-screenshot. Kalau bocor, hapus webhook-nya di Discord dan buat yang baru.

---

## Menjalankan

```bash
npm start            # jalan terus-menerus (mode normal)
npm run dev          # sama, tapi auto-restart saat file diubah
npm run once         # satu siklus lalu keluar — berguna untuk debugging/cron
npm run check-env    # validasi konfigurasi saja, tanpa menyentuh jaringan
npm test             # jalankan unit test
```

Hentikan dengan `Ctrl+C` — aplikasi menyelesaikan siklus yang sedang berjalan lalu keluar dengan rapi.

---

## Membaca log

Format setiap baris:

```
[2026-09-25T10:00:00.000Z] [INFO ] [live] Mengecek status LIVE @someone...
 └─ waktu UTC              └─level └─scope
```

Scope yang ada: `app`, `scheduler`, `live`, `content`, `discord`, `tiktok`, `state`.

Contoh siklus normal:

```
[INFO ] [scheduler] --- Siklus #1 dimulai ---
[INFO ] [live]      Mengecek status LIVE @someone...
[INFO ] [content]   Mengecek konten baru @someone (provider: web)...
[INFO ] [live]      LIVE baru terdeteksi untuk @someone {"liveId":"768...","viewers":1234}
[INFO ] [discord]   Notifikasi LIVE terkirim untuk @someone {"messageId":"142..."}
[INFO ] [content]   Tidak ada video baru.
[INFO ] [scheduler] --- Siklus #1 selesai dalam 1186ms (2/2 monitor sukses) ---
```

Arti level:

- `[INFO]` — jalannya normal
- `[WARN]` — ada yang gagal tapi aplikasi menanganinya dan akan mencoba lagi (mis. TikTok memblokir satu request, Discord kena rate limit)
- `[ERROR]` — ada yang gagal dan butuh perhatian kamu (mis. webhook tidak valid)

URL webhook **selalu disamarkan** di log:

```
https://discord.com/api/webhooks/111111***/***
```

---

## Keterbatasan yang harus kamu tahu

Bagian ini penting. Semua klaim di bawah ini diverifikasi langsung terhadap TikTok pada **2026-09-25**, bukan asumsi.

### TikTok tidak punya API resmi untuk ini

TikTok **Display API** (`developers.tiktok.com`) adalah satu-satunya API resmi untuk membaca video sebuah akun — tapi API itu hanya bisa membaca akun yang **memberikan izin OAuth kepada aplikasimu**, yaitu akun milikmu sendiri. Tidak ada cara resmi untuk membaca feed atau status LIVE akun orang lain.

Untuk status LIVE, tidak ada API resmi sama sekali, bahkan untuk akun sendiri.

### Status LIVE — andal ✅

Sumber: endpoint web publik yang dipakai halaman profil TikTok itu sendiri.

```
GET https://www.tiktok.com/api-live/user/room/?aid=1988&sourceType=54&uniqueId=<username>
```

- Tidak butuh login, cookie, signature, atau CAPTCHA — tidak ada mekanisme keamanan yang dilewati
- Terverifikasi berfungsi dan mengembalikan JSON valid
- Menyediakan: status LIVE, `roomId`, judul, jumlah penonton, cover, waktu mulai, display name, avatar

**Risikonya:** ini endpoint internal tanpa kontrak publik. TikTok bisa mengubah atau menutupnya kapan saja tanpa pemberitahuan. Kalau itu terjadi, aplikasi akan mencatat `[WARN]` dan terus mencoba — tidak crash, tapi notifikasi LIVE berhenti sampai kode diperbarui.

> **Detail implementasi yang penting:** objek `liveRoom` dari TikTok **tetap berisi data walau akun sedang offline** — lengkap dengan `roomId`, judul, dan cover dari siaran terakhir. Karena itu deteksi LIVE memakai `user.status === 2`, bukan sekadar keberadaan `roomId`. Kalau ini salah, notifier akan mengira akun LIVE selamanya. Perilaku ini dikunci oleh test di `test/liveMonitor.test.js`.

### Konten/video baru — best-effort ⚠️

Provider default `web` membaca halaman profil publik `https://www.tiktok.com/@user` dan mengambil blok JSON yang TikTok sendiri tanamkan di HTML-nya untuk hidrasi front-end. Tidak ada login, signature, atau bypass — persis HTML yang diterima browser biasa.

**Masalahnya, dan ini nyata:** TikTok memasang WAF anti-bot. Dalam verifikasi di mesin pengembangan, request pertama berhasil (417 KB HTML), tetapi setelah beberapa request berikutnya TikTok membalas halaman tantangan 1.4 KB berisi `_wafchallengeid` dan teks "Please wait...". Dari IP datacenter/VPS, ini kemungkinan besar terjadi **sejak request pertama**.

Ketika itu terjadi, aplikasi mencatat:

```
[WARN] [content] Konten tidak bisa dibaca: TikTok membalas halaman verifikasi anti-bot,
       bukan halaman profil. ... {"reason":"challenge","consecutiveFailures":1}
```

Aplikasi **tidak** mencoba menembus WAF tersebut, dan **tidak** mengarang data pengganti. Notifikasi LIVE sama sekali tidak terpengaruh.

**Mengapa tidak pakai library pihak ketiga saja?** Sudah diuji:

| Package | Versi | Update terakhir | Hasil |
|---|---|---|---|
| `@tobyg74/tiktok-api-dl` | 1.3.7 (ISC) | 2025-10-27 | **Rusak.** `StalkUser` dan `GetUserPosts` sama-sama gagal dengan `Unexpected end of JSON input` — kena WAF yang sama. |
| `tiktok-scraper` | 1.4.36 (MIT) | 2022-05-21 | Ditinggalkan, sudah 4 tahun tidak diperbarui. |
| `tiktok-signature` | 4.3.6 (MIT) | 2026-05-31 | Berfungsi, tapi kerjanya **membangkitkan signature `X-Bogus`/`X-Gnarly`** untuk menyamar sebagai klien resmi. Ini persis kategori bypass anti-bot — **sengaja tidak dipakai.** |

**Mengapa tidak pakai `tiktok-live-connector`?** Library ini aktif dirawat (v2.5.0, update 2026-09-16) dan berkualitas, tapi:

1. Lisensinya **AGPL-3.0-only** — copyleft kuat yang menular ke project kamu kalau suatu saat didistribusikan atau dijadikan layanan.
2. Ia menarik `protobuf`, `ws`, `got`, dan dua paket proto demi fitur realtime chat/gift yang tidak dibutuhkan di sini.
3. Untuk "sedang LIVE atau tidak + judul + penonton", endpoint publik di atas sudah cukup dan tanpa dependency.

Kalau kamu memang butuh event realtime (komentar, gift, follow), `tiktok-live-connector` adalah pilihan yang tepat — dengan konsekuensi lisensi yang perlu kamu terima.

### Pilihan provider konten

| Provider | Untuk siapa | Keandalan | Statistik |
|---|---|---|---|
| `web` (default) | Akun siapa pun | **Rendah** — sering diblokir WAF | Lengkap, kalau berhasil |
| `official` | **Hanya akun sendiri** | Tinggi | Lengkap |
| `mock` | Testing lokal | — | Dari file |
| `disabled` | Kalau hanya butuh LIVE | — | — |

Kalau memantau **akun sendiri**, gunakan `official`:

```env
TIKTOK_CONTENT_PROVIDER=official
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REFRESH_TOKEN=...
```

Caranya: daftarkan aplikasi di <https://developers.tiktok.com/>, minta scope `user.info.basic` dan `video.list`, jalankan alur OAuth sekali, lalu simpan refresh token-nya. Refresh token berlaku **365 hari**; setelah itu perlu otorisasi ulang. TikTok kadang menerbitkan refresh token baru saat penyegaran — aplikasi akan mencatat `[WARN]` yang memintamu memperbarui `.env` (nilainya tidak pernah ditulis ke log).

Kalau memantau **akun orang lain** dan provider `web` terus diblokir, pilihan realistisnya:

- Set `TIKTOK_CONTENT_PROVIDER=disabled` dan pakai aplikasi ini murni untuk notifikasi LIVE
- Jalankan dari IP residensial (komputer rumah / Raspberry Pi), bukan VPS — WAF lebih jarang memicu
- Perbesar `CHECK_INTERVAL` (mis. `300000`) agar polanya tidak seperti bot

---

## Cara kerja anti-duplikat

State disimpan di `data/state.json` dan ditulis secara **atomik** (tulis ke `.tmp` lalu `rename`), jadi file tidak pernah setengah jadi walau proses dimatikan paksa.

```json
{
  "version": 1,
  "lastContentId": "7551234567890123456",
  "knownContentIds": ["755...", "755...", "..."],
  "contentBootstrapped": true,
  "currentLiveId": null,
  "lastLiveStatus": false,
  "liveStartedAt": null,
  "liveMessageId": null,
  "lastLiveUpdateAt": null,
  "lastViewerCount": null,
  "lastCheckedAt": "2026-09-25T00:00:00.000Z"
}
```

### LIVE: satu sesi = satu notifikasi

Sesi dibedakan lewat `roomId` TikTok yang disimpan sebagai `currentLiveId`:

```
10:00  LIVE mulai (room A)  →  currentLiveId null ≠ A  →  KIRIM notifikasi
10:01  masih LIVE (room A)  →  currentLiveId A    = A  →  diam
10:02  masih LIVE (room A)  →  currentLiveId A    = A  →  diam
...
11:00  LIVE berakhir        →  currentLiveId direset ke null, pesan di-edit jadi "LIVE Berakhir"
12:30  LIVE lagi  (room B)  →  currentLiveId null ≠ B  →  KIRIM notifikasi baru
```

**Update jumlah penonton** dilakukan dengan **meng-EDIT pesan Discord yang sama** (`PATCH .../messages/<id>`), bukan mengirim pesan baru, dan dibatasi `LIVE_UPDATE_INTERVAL`. Jadi berapa pun lamanya siaran, channel hanya menerima **satu pesan per sesi**. Ini alasan utama sistem tidak pernah kena rate limit Discord.

### Konten: satu video = satu notifikasi

- **Siklus pertama** (`contentBootstrapped: false`) hanya **merekam** id video yang sudah ada, **tanpa mengirim apa pun**. Tanpa ini, instalasi baru akan mengirim seluruh video lama ke channel.
- Setelahnya, hanya id yang belum pernah tercatat di `knownContentIds` yang dinotifikasi.
- `knownContentIds` adalah ring buffer 100 id terakhir, bukan sekadar satu `lastContentId`. Ini disengaja: urutan feed TikTok bisa berubah (video yang di-pin naik ke atas), dan kalau hanya mengandalkan satu id terakhir, video lama bisa salah terdeteksi sebagai baru.
- Id ditandai **setelah** Discord menerima pesan. Kalau pengiriman gagal, video tidak ditandai dan akan dicoba lagi di siklus berikutnya.

---

## Struktur project

```
tiktok-discord-notifier/
├── src/
│   ├── index.js                  # bootstrap, shutdown rapi, penanganan sinyal
│   ├── config.js                 # muat + validasi .env (gagal cepat & jelas)
│   ├── scheduler.js              # loop polling, isolasi antar monitor
│   ├── types.js                  # typedef JSDoc bersama
│   ├── services/
│   │   ├── discord.js            # embed + kirim/edit, retry, rate limit
│   │   ├── tiktok.js             # facade: getLiveStatus() / getLatestContent()
│   │   └── tiktok/
│   │       ├── liveProvider.js   # endpoint room publik
│   │       ├── oembed.js         # oEmbed resmi (pelengkap caption/thumbnail)
│   │       └── content/
│   │           ├── webProvider.js       # best-effort, baca HTML profil
│   │           ├── officialProvider.js  # TikTok Display API (akun sendiri)
│   │           └── mockProvider.js      # dari file, untuk testing
│   ├── monitors/
│   │   ├── liveMonitor.js        # logika sesi LIVE + anti-duplikat
│   │   └── contentMonitor.js     # logika video baru + anti-duplikat
│   └── utils/
│       ├── logger.js             # level log + penyamaran kredensial
│       ├── state.js              # state persisten, penulisan atomik
│       ├── http.js               # timeout, retry, backoff, Retry-After
│       ├── format.js             # format angka/waktu/URL
│       └── errors.js             # tipe error bersama
├── test/                         # unit test (node:test bawaan)
├── data/                         # state.json dibuat di sini saat runtime
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

**Penyimpangan dari struktur yang diminta, dan alasannya:**

- `src/scheduler.js` **ditambahkan** — memisahkan "kapan dijalankan" dari "apa yang dijalankan" membuat `index.js` tetap sebagai bootstrap murni, dan loop-nya bisa diuji tanpa menjalankan aplikasi.
- `src/services/tiktok/` **ditambahkan** sebagai folder provider di balik facade `services/tiktok.js`. Justru karena metode pengambilan data TikTok rapuh dan mungkin perlu diganti, strategi pengambilan data dipisah dari kontraknya. Monitor tidak pernah tahu data datang dari mana.
- `src/utils/http.js` dan `src/utils/errors.js` **ditambahkan** — retry, timeout, dan penanganan rate limit dipakai oleh Discord maupun TikTok, jadi tidak ditulis dua kali.
- `src/types.js` **ditambahkan** — typedef JSDoc memberi autocomplete di editor tanpa perlu TypeScript dan build step.

---

## Testing

```bash
npm test
```

87 test, tanpa dependency eksternal, tanpa menyentuh jaringan. Yang dikunci oleh test:

- **Dedup LIVE** — seluruh skenario di atas: sesi baru, sesi sama, sesi berakhir, sesi baru lagi, dan pergantian room tanpa sempat terdeteksi offline
- **Bug `liveRoom` sisa** — akun offline dengan data siaran lama harus terbaca sebagai tidak LIVE
- **Dedup konten** — bootstrap awal, video baru, video yang sama dua siklus, video di-pin yang naik ke atas, batas per siklus
- **Kegagalan Discord** — video tidak ditandai terkirim kalau webhook gagal
- **Pemisahan webhook** — notifikasi LIVE tidak pernah menyentuh webhook konten, dan sebaliknya
- **Rate limit** — `Retry-After` dihormati; error permanen seperti 404 tidak diulang
- **State** — bertahan setelah restart, tahan file korup, tidak meninggalkan file `.tmp`
- **Isolasi monitor** — kegagalan LIVE tidak menghentikan content, dan sebaliknya
- **Konfigurasi** — semua masalah dilaporkan sekaligus, webhook non-Discord ditolak
- **Penyamaran kredensial** — token webhook tidak pernah muncul utuh di log

### Testing manual

Gunakan provider `mock` untuk menguji alur penuh tanpa menyentuh TikTok:

```bash
cat > data/mock-content.json <<'EOF'
[{ "id": "1001", "caption": "video pertama", "views": 100, "likes": 10 }]
EOF

TIKTOK_CONTENT_PROVIDER=mock npm run once   # siklus 1: bootstrap, 0 notifikasi
# tambahkan { "id": "1002", ... } ke bagian ATAS array, lalu:
TIKTOK_CONTENT_PROVIDER=mock npm run once   # siklus 2: 1 notifikasi terkirim
TIKTOK_CONTENT_PROVIDER=mock npm run once   # siklus 3: diam (sudah pernah dikirim)
```

---

## Troubleshooting

**`[ERROR] Konfigurasi tidak valid: ...`**
Aplikasi sengaja menolak start. Pesannya menyebutkan persis variable mana yang bermasalah. Jalankan `npm run check-env` setelah memperbaikinya.

**`Discord membalas HTTP 401/404 saat kirim notifikasi`**
URL webhook salah atau webhook-nya sudah dihapus di Discord. Buat ulang webhook, salin URL barunya. Error ini sengaja tidak di-retry — mengulanginya tidak akan menolong.

**`TikTok membalas halaman verifikasi anti-bot`**
WAF TikTok memblokir request. Ini keterbatasan yang diketahui dan dijelaskan di [Keterbatasan](#keterbatasan-yang-harus-kamu-tahu). Coba perbesar `CHECK_INTERVAL`, jalankan dari IP residensial, atau set `TIKTOK_CONTENT_PROVIDER=disabled`. Notifikasi LIVE tidak terpengaruh.

**`Akun @xxx tidak ditemukan atau struktur response TikTok berubah`**
Periksa ejaan `TIKTOK_USERNAME`. Kalau usernamenya benar dan akunnya publik, kemungkinan TikTok mengubah struktur endpoint-nya.

**Notifikasi LIVE tidak muncul padahal akunnya sedang LIVE**
Jalankan `LOG_LEVEL=debug npm run once` dan lihat baris `Keputusan LIVE:`. Kalau tertulis `none (sesi sama...)`, berarti sesi itu sudah pernah dinotifikasi — cek `currentLiveId` di `data/state.json`.

**Semua video lama terkirim sekaligus**
Berarti `data/state.json` hilang atau terhapus. Aplikasi seharusnya mem-bootstrap tanpa mengirim apa pun; kalau ini terjadi, pastikan `STATE_FILE` menunjuk ke lokasi yang persisten (terutama di Docker — lihat bawah).

**Discord kena rate limit**
Aplikasi sudah menanganinya otomatis (menunggu sesuai `Retry-After`). Kalau sering terjadi, perbesar `LIVE_UPDATE_INTERVAL` atau kecilkan `MAX_CONTENT_PER_CYCLE`.

---

## Deployment 24/7

### Opsi A — VPS + PM2 (paling umum)

```bash
npm install -g pm2

cd /path/ke/tiktok-discord-notifier
npm install

pm2 start src/index.js --name tiktok-notifier
pm2 save                      # simpan daftar proses saat ini
pm2 startup                   # cetak perintah agar PM2 otomatis jalan saat boot
                              # (jalankan perintah yang dicetaknya, biasanya pakai sudo)
```

Operasional harian:

```bash
pm2 status                    # lihat status semua proses
pm2 logs tiktok-notifier      # ikuti log secara realtime
pm2 logs tiktok-notifier --lines 200
pm2 restart tiktok-notifier   # restart (mis. setelah mengubah .env)
pm2 stop tiktok-notifier
pm2 delete tiktok-notifier
pm2 monit                     # dashboard CPU/memori
```

Rotasi log agar disk tidak penuh:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

> PM2 menjalankan proses dengan working directory tempat kamu memanggilnya. Pastikan `.env` dan folder `data/` ada di sana, atau set `STATE_FILE` ke path absolut.

### Opsi B — Docker

`Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /app/data
CMD ["node", "src/index.js"]
```

`docker-compose.yml`:

```yaml
services:
  notifier:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data      # WAJIB: tanpa ini state hilang tiap restart
```

```bash
docker compose up -d
docker compose logs -f
docker compose restart
```

> Volume `./data` bukan opsional. Tanpanya, `state.json` ikut terhapus setiap restart container dan aplikasi akan mem-bootstrap ulang setiap kali.

### Opsi C — systemd (tanpa PM2)

`/etc/systemd/system/tiktok-notifier.service`:

```ini
[Unit]
Description=TikTok Discord Notifier
After=network-online.target

[Service]
Type=simple
User=nodeapp
WorkingDirectory=/opt/tiktok-discord-notifier
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/tiktok-discord-notifier/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tiktok-notifier
sudo journalctl -u tiktok-notifier -f
```

### Opsi D — GitHub Actions (gratis, tanpa kartu, tanpa VPS)

Cocok kalau semua opsi VPS gratis (Oracle, Google Cloud) mentok di verifikasi kartu, dan kamu tidak mau bayar VPS atau menjaga laptop menyala 24/7.

**Cara kerjanya beda secara fundamental** dari opsi A–C: bukan satu proses yang hidup terus, melainkan **runner baru yang dibuat lalu dibuang setiap kali terpicu**, menjalankan `npm run once` (satu siklus), lalu commit `data/state.json` kembali ke repo supaya anti-duplikat tetap bertahan antar-run. File workflow-nya sudah ada di [.github/workflows/monitor.yml](.github/workflows/monitor.yml) — tinggal push ke GitHub.

**Trade-off yang jujur, sebelum kamu pilih ini:**

- **GitHub Actions tidak bisa presisi 1 menit — 5 menit adalah batas keras platform**, berlaku sama untuk repo publik maupun privat. Ini bukan soal kuota menit; GitHub secara eksplisit tidak menjalankan jadwal lebih cepat dari itu.
- Jadwal cron GitHub Actions juga **best-effort** di atas batas 5 menit itu — bisa meleset beberapa menit lagi saat traffic GitHub tinggi. LIVE bisa terdeteksi telat dari waktu sebenarnya — bukan real-time presisi detik seperti VPS.
- Workflow ini memakai interval **5 menit** (`*/5 * * * *`), yang tercepat yang diizinkan.
- GitHub **menonaktifkan scheduled workflow otomatis** kalau repo tidak ada aktivitas (commit/push) selama 60 hari. Commit state.json dari workflow sendiri **tidak dihitung** sebagai aktivitas untuk keperluan ini — cek `Settings > Actions` sesekali kalau notifikasi tiba-tiba berhenti tanpa error.
- Repo publik = menit Actions **unlimited** gratis; repo privat = **2.000 menit/bulan gratis** (cukup banyak untuk jadwal 10 menitan).

**Setup:**

1. Buat repo baru di [github.com/new](https://github.com/new) (nama bebas, publik atau privat)
2. Push project ini ke repo tersebut:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<username>/<nama-repo>.git
   git push -u origin main
   ```
3. Di repo GitHub → **Settings → Secrets and variables → Actions → New repository secret**, tambahkan tiga secret ini (nilainya disalin dari `.env` lokal kamu):
   - `TIKTOK_USERNAME`
   - `DISCORD_LIVE_WEBHOOK_URL`
   - `DISCORD_CONTENT_WEBHOOK_URL`
4. Buka tab **Actions** di repo → pilih workflow **TikTok Monitor** → **Run workflow** (tombol manual) untuk tes pertama kali
5. Kalau sukses (centang hijau), workflow akan otomatis jalan tiap 10 menit sesuai jadwal — tidak perlu tindakan lagi

**Catatan keamanan:** `.env` **tidak pernah** ikut ter-push (sudah di `.gitignore`). Kredensial hanya hidup di GitHub Secrets, yang dienkripsi dan tidak pernah muncul di log workflow.

**Kapan sebaiknya TIDAK pakai ini:** kalau kamu butuh LIVE terdeteksi dalam hitungan detik/menit yang presisi, atau provider konten `official` yang butuh refresh token — pola commit-per-run tetap jalan, tapi VPS dengan proses hidup terus lebih cocok untuk itu.

### Catatan platform cloud

Platform serverless (Vercel, Netlify Functions, Cloudflare Workers) **tidak cocok** — aplikasi ini adalah proses yang hidup terus dan butuh filesystem persisten untuk `state.json`. (GitHub Actions di atas berbeda: dia memang dirancang ulang khusus untuk model run-sesaat-terjadwal, bukan proses yang hidup terus.)

Platform yang cocok untuk proses hidup terus: **Railway**, **Render** (Background Worker), **Fly.io**, atau VPS biasa — semuanya dengan persistent volume di-mount ke `data/`. Per 2026, tidak ada satu pun dari ini yang gratis permanen lagi.

Satu catatan penting: IP datacenter jauh lebih sering memicu WAF TikTok dibanding IP rumahan. Kalau notifikasi konten penting bagimu, **Raspberry Pi di rumah** sering kali lebih efektif daripada VPS atau GitHub Actions.

---

## Keamanan

Yang sudah diterapkan di kode:

- Tidak ada satu pun kredensial di-hardcode; semuanya dari environment
- `.env`, `node_modules/`, dan `data/state.json` ada di `.gitignore`
- Validasi environment saat start — aplikasi **gagal start** dengan pesan jelas kalau ada yang wajib tapi kosong
- URL webhook divalidasi bentuk **dan domainnya** (harus `discord.com`), mencegah pengiriman ke host pihak ketiga karena salah tempel
- URL webhook **selalu disamarkan** di log: `https://discord.com/api/webhooks/111111***/***`
- Field bernama `*secret*`, `*token*`, `*password*`, `*webhook*` otomatis disamarkan saat objek di-log
- `allowed_mentions: { parse: [] }` pada setiap payload — caption TikTok tidak bisa memicu `@everyone`
- URL dari TikTok disaring (`http`/`https` saja) sebelum masuk embed
- Kredensial TikTok tidak disimpan kecuali kamu memakai provider `official`
- Nol dependency runtime — tidak ada permukaan serangan dari rantai suplai npm

Yang jadi tanggung jawabmu:

- Jangan commit `.env`. Kalau terlanjur, **hapus webhook-nya di Discord** dan buat yang baru — menghapus commit saja tidak cukup.
- Beri izin file yang ketat di server: `chmod 600 .env`
- Jangan jalankan sebagai `root`

---

## Lisensi

MIT. Silakan pakai dan modifikasi.
