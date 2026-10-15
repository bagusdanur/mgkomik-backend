# Stream Resolver — ambil video mentah dari player, buang iklan

Modul: `ryukomik-backend/stream-resolver.js`
Pola mengikuti "ryu-lokal" yang sudah dipakai nekopoi/streampoi.

Tujuan: ambil **video mentah** dari player pihak ketiga, lalu sajikan lewat proxy
sendiri. Karena yang diambil hanya file videonya, **iklan otomatis hilang**.

## Hasil riset 5 sistem player Otakudesu

| Player | Status | Cara |
|---|---|---|
| **filedon** | ✅ **DIDUKUNG** | Laravel + Inertia; `div#app[data-page]` → `props.url` = presigned Cloudflare R2 (mp4 murni) |
| vidhide | ❌ tidak bisa | Packed JS bisa di-decode, tapi CDN balas **0 byte / 403** (token + IP bound) |
| **mega** | ✅ **DIDUKUNG** | `megajs` (library resmi MEGA): `/embed/` → `/file/`, API `{a:"g",g:1,ssl:2,p:<id>}` → URL gateway (ciphertext AES-128-CTR) → didekripsi megajs saat streaming |
| **blogs** | ⚠️ **BERSIH, tanpa resolve** | Player Blogger praktis **tanpa iklan** — iframe dipakai apa adanya dan ditandai "Ryu-lokal" di frontend |
| odstream | ⚠️ belum | playerjs; `file` masih placeholder, butuh kode enkripsi dari AJAX |

**Kenapa filedon berhasil dan vidhide tidak:** filedon menaruh URL video
presigned (R2) langsung di `data-page`, dan CDN R2-nya **tidak** memblokir IP server.
Vidhide mengikat token ke IP/sesi, jadi meski URL m3u8 berhasil di-decode, CDN-nya
menolak — sudah diuji dengan 5 kombinasi header, resolve IP langsung, worker
Cloudflare, dan `r.jina.ai` (semua gagal).

**Catatan MEGA:** URL `g` dari gateway hanya berumur pendek, dan file berupa
ciphertext — jadi `resolveMega` tidak mengembalikan URL mentah melainkan token
`/stream/mega/<token>` (berisi embed URL saja). Route itu memuat atribut via
`megajs` (~0,5–1 dtk, di-cache in-memory 30 menit) lalu streaming terdekripsi
dengan dukungan `Range` (seek aman). Tambah `?dl=1` untuk mode unduhan
(`Content-Disposition: attachment` + nama file asli).

**Cakupan praktis (sampel 4 episode ongoing, 2026-10):** mega 31% + blogs 10% +
filedon opsional ≈ **41% episode** kini berlabel "Ryu-lokal"; sisanya (vidhide
31%, odstream 25%) masih iframe.

## Endpoint

### 1. `GET /stream/resolve?url=<embed-url>`

Ubah URL embed player menjadi URL video langsung.

```bash
curl "https://apiv2.ryukomik.web.id/stream/resolve?url=https://filedon.co/embed/1FoVJZjSXp"
```

Respons sukses:
```json
{
  "success": true,
  "provider": "filedon",
  "url": "https://....r2.cloudflarestorage.com/filedon/.../xxx.mp4?X-Amz-Signature=...",
  "url_proxy": "https://apiv2.ryukomik.web.id/stream/proxy/<base64url>",
  "filename": "Otakudesu.io_YouSenki.S2--05_720p.mp4",
  "size": 107619245,
  "mimeType": "video/mp4",
  "vastUrl": null,
  "adSlots": ["top", "above-player", "in-player", "..."]
}
```

Catatan penting:
- **`vastUrl: null`** = filedon tidak menempelkan iklan ke video. Iklannya
  terpisah di `adSlots` (HTML/script). Karena kita hanya mengambil `props.url`,
  iklan hilang dengan sendirinya. **Inilah kenapa pendekatan ini bekerja di filedon.**
- `url` adalah **presigned URL**, kedaluwarsa ~1 jam. Cache resolver 30 menit.
- `url_proxy` dibentuk dari env `STREAM_PUBLIC_BASE` (lihat bagian Konfigurasi).

Respons gagal (player tidak didukung):
```json
{ "success": false, "provider": "vidhide",
  "message": "CDN vidhide menolak request server (0 byte/403, token+IP bound). ..." }
```

### 2. `GET /stream/proxy/<base64url>`

Proxy video. Mendukung **Range request** supaya bisa di-seek/streaming bertahap.

```
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Type: video/mp4
Content-Range: bytes 0-1023/107619245
Access-Control-Allow-Origin: *
```

### 3. `GET /stream/providers`

Info penyedia mana yang didukung (untuk frontend memilih server).

```json
{
  "success": true,
  "data": {
    "supported": ["filedon"],
    "unsupported": {
      "vidhide": "CDN menolak request server (0 byte/403)",
      "mega": "Butuh dekripsi AES-128-CTR",
      "blogs": "YouTube iframe API",
      "odstream": "Butuh kode enkripsi dari AJAX"
    }
  }
}
```

## Cara pakai di frontend

Sudah tersambung. Komponen `src/components/anime/AnimePlayer.tsx` ("ryu-lokal"
versi anime) dipasang di `src/app/anime/episode/[slug]/EpisodeClient.tsx`.

Cara kerjanya:
```tsx
// AnimePlayer menerima URL embed server yang dipilih
<AnimePlayer src={activePlayers[activePlayer]?.iframe} />
```
- Server yang didukung resolver (filedon) → di-fetch ke `/stream/resolve`,
  lalu diputar memakai `<video>` sendiri → **iklan hilang**.
- Server lain (vidhide/mega/blogs/odstream) → otomatis fallback ke `<iframe>`.
- Kalau resolve gagal → fallback `<iframe>` juga (tidak pernah blank).

Di daftar server, yang didukung diberi badge **`⚡ Ad-Free`** supaya user tahu
mana yang bebas iklan.

**Donghua TIDAK diubah** — halaman donghua tetap memakai `<iframe>` seperti semula.

## Build tanpa menghentikan situs

`next.config.mjs` sekarang membaca `distDir` dari env (`NEXT_DIST_DIR`, default
`.next`). Jadi bisa build ke folder lain lalu swap, tanpa mematikan situs:

```bash
NEXT_DIST_DIR=.next-new npm run build     # situs tetap jalan
mv .next .next-old-$(date +%Y%m%d-%H%M%S) # simpan lama
mv .next-new .next                        # pasang baru
pm2 restart ryukomik                      # restart singkat
rm -rf .next-old-*                        # bersihkan
```

Tanpa trik ini, `next build` gagal dengan
`ENOTEMPTY: directory not empty, rmdir '.../.next/server/app/...'`
karena proses yang sedang jalan memegang file di `.next`.

## Konfigurasi

| Env | Fungsi |
|---|---|
| `STREAM_PUBLIC_BASE` | Base URL publik untuk membentuk `url_proxy`. Contoh: `https://apiv2.ryukomik.web.id`. **Wajib di-set** kalau backend di balik nginx/tunnel, karena `Host` header sering diteruskan sebagai `127.0.0.1:3014`. |

Modul ini memuat `.env` sendiri via `process.loadEnvFile()` karena `main.js`
tidak memakai dotenv.

## Catatan beban server

Proxy video meneruskan byte besar. Range request membuat klien hanya mengambil
potongan yang perlu (pemutar biasanya 2–10 MB sekali ambil), **bukan** seluruh file.
Terukur ~4.8–9.1 MB/s dari R2. Pantau `load average` bila banyak penonton
simultan; server ini juga menjalankan app lain.

## Backup

- `stream-resolver.js.bak-initial-*`
- `main.js.bak-stream-resolver-*`
