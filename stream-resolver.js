/**
 * =====================================================
 * Resolver stream langsung per-player (mode "ryu-lokal")
 * =====================================================
 * Tujuan: ambil video MENTAH dari player + buang iklan, lalu sajikan ke
 * frontend lewat proxy sendiri (pola yang sudah dipakai nekopoi/streampoi).
 *
 * Status riset 5 sistem player otakudesu:
 *   filedon  -> ✅ BEKERJA. Laravel + Inertia; props.url = presigned R2 (mp4 murni),
 *               dan vast_url = null (iklan terpisah di ad_slots) => video bersih.
 *   vidhide  -> ❌ packed JS bisa di-decode, tapi CDN balas 0 byte / 403
 *               (token + IP bound). Sudah dicoba semua kombinasi header: gagal.
 *   mega     -> ✅ BEKERJA (megajs). Link embed /file/ + key fragment; API
 *               {a:"g",g:1,ssl:2,p:<downloadId>} membalas URL gateway (ciphertext
 *               AES-128-CTR). Dekripsi dilakukan megajs (library resmi MEGA),
 *               stream lewat /stream/mega/<token> dengan dukungan Range.
 *   blogs    -> ⚠️ TIDAK di-resolve: player Blogger praktis TANPA IKLAN, jadi
 *               iframe-nya dipakai langsung dan ditandai "ryu-lokal" di frontend.
 *   desustream (odcdn/odstream/ondesu2hd) -> ✅ BEKERJA. Halaman player sudah
 *               memuat URL MP4 mentah (cdn.odcloud.net / archive.org /
 *               googlevideo). Tidak ada enkripsi; cukup cabut URL-nya. Diputar
 *               lewat /stream/proxy (butuh proxy karena CDN tanpa header CORS).
 * =====================================================
 */

const axios = require("axios");
const mega = require("megajs");

// Muat .env sendiri: main.js tidak memakai dotenv, jadi variabel seperti
// STREAM_PUBLIC_BASE di .env tidak akan terbaca tanpa ini.
// `process.loadEnvFile` tersedia di Node 20.12+/21+ dan tidak menimpa env yang
// sudah di-set PM2 (aman dipanggil berkali-kali).
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(require("path").join(__dirname, ".env"));
  }
} catch (_) {
  // .env tidak ada / Node terlalu lama — abaikan, pakai fallback
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

// ─────────────────────────────────────────────────────────────────────────────
// FILEDON
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Ambil data Inertia dari halaman embed filedon.
 * filedon (Laravel + Inertia.js) menaruh seluruh state awal di atribut
 * data-page pada <div id="app">, termasuk URL video yang sudah ditandatangani.
 */
function parseInertiaDataPage(html) {
  const m = html.match(/data-page="([^"]+)"/s);
  if (!m) return null;
  // HTML entity (&quot; &amp; &#039; ...) harus di-decode dulu sebelum JSON.parse
  const decoded = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  try {
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

async function resolveFiledon(embedUrl) {
  try {
    const res = await axios.get(embedUrl, {
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      },
    });

    const page = parseInertiaDataPage(String(res.data || ""));
    if (!page) return null;

    const props = page.props || {};
    const file = props.files || {};

    // `url` = presigned Cloudflare R2 (mp4 mentah). Ini yang kita pakai.
    if (!props.url) return null;

    return {
      success: true,
      provider: "filedon",
      // URL video langsung (murni mp4, tanpa iklan)
      url: props.url,
      // Metadata berguna untuk frontend
      filename: file.name || "",
      size: file.size || null,
      mimeType: file.mime_type || "video/mp4",
      // Iklan filedon TIDAK menempel di video (vast_url null) — dipisah di ad_slots.
      // Karena kita hanya mengambil props.url, iklan otomatis hilang.
      vastUrl: props.vast_url || null,
      adSlots: Object.keys(props.ad_slots || {}),
      // Catatan: hls_url null bila transcode_status masih "pending"
      hlsUrl: (props.media && props.media.hls_url) || null,
      transcodeStatus: file.transcode_status || null,
    };
  } catch (err) {
    return { success: false, provider: "filedon", message: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MEGA (megajs)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * MEGA embed: https://mega.nz/embed/<nodeId>#<key43>
 * megajs tidak mengenali "/embed/", jadi dinormalkan ke "/file/".
 * `loadAttributes` sudah men-dekripsi nama/ukuran, lalu API {a:"g"} membalas
 * URL gateway berisi CIPHERTEXT (AES-128-CTR) — tidak bisa diputar browser
 * apa adanya. Jadi url_proxy-nya mengarah ke /stream/mega/<token> yang
 * mendekripsi saat streaming (lihat registerRoutes).
 */
function normalizeMegaUrl(embedUrl) {
  return String(embedUrl || "").replace("/embed/", "/file/");
}

function buildMegaFile(embedUrl) {
  return mega.File.fromURL(normalizeMegaUrl(embedUrl));
}

function loadMegaAttributes(file) {
  return new Promise((resolve, reject) => {
    file.loadAttributes((err) => (err ? reject(err) : resolve()));
  });
}

/** Token tahan-tandas: hanya berisi URL embed; atribut & URL gateway di-cache server. */
function encodeMegaToken(embedUrl) {
  return Buffer.from(JSON.stringify({ u: embedUrl })).toString("base64url");
}

function decodeMegaToken(token) {
  try {
    const parsed = JSON.parse(Buffer.from(String(token || ""), "base64url").toString("utf8"));
    if (typeof parsed.u !== "string" || !/^https?:\/\/(www\.)?mega\.nz\//i.test(parsed.u)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

async function resolveMega(embedUrl) {
  try {
    const file = buildMegaFile(embedUrl);
    await loadMegaAttributes(file);
    return {
      success: true,
      provider: "mega",
      url: normalizeMegaUrl(embedUrl),
      filename: file.name || "",
      size: file.size || null,
      mimeType: "video/mp4",
      // MEGA memutar file terenkripsi: browser butuh dekripsi di sisi server,
      // jadi url utama = token proxy lokal (bukan URL gateway mentah).
      megaToken: encodeMegaToken(embedUrl),
    };
  } catch (err) {
    return { success: false, provider: "mega", message: String((err && err.message) || err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DESUSTREAM (odcdn / odstream / ondesu2hd)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Player desustream (odcdn, odstream, ondesu2hd, ...) menyajikan halaman HTML
 * yang di dalamnya sudah tertulis URL video MP4 MENTAH — tanpa enkripsi/token.
 * Bentuknya:
 *   odcdn      -> const videoURL = "https://cdn.odcloud.net/anime/....mp4";
 *   odstream   -> {id:"playerjs", file:"https://archive.org/download/.../x.mp4"}
 *   ondesu2hd  -> <source src="https://rr4---sn-....googlevideo.com/videoplayback?...">
 *
 * Jadi cukup ambil halaman lalu cabut URL-nya dengan pola. Tidak perlu
 * dekripsi; pemutaran memakai proxy /stream/proxy supaya tidak kena CORS.
 */
function extractDesuVideoUrl(html) {
  const text = String(html || "");
  const patterns = [
    /const\s+videoURL\s*=\s*["']([^"']+)["']/i,
    /file\s*:\s*["'](https?:\/\/[^"']+)["']/i,
    /<source[^>]+src=["']([^"']+)["']/i,
    /["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].replace(/&amp;/g, "&").trim();
  }
  return null;
}

async function resolveDesustream(embedUrl, provider) {
  try {
    const res = await axios.get(embedUrl, {
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: embedUrl,
      },
    });
    const videoUrl = extractDesuVideoUrl(res.data);
    if (!videoUrl) {
      return { success: false, provider, message: "URL video tidak ditemukan di halaman player" };
    }
    return {
      success: true,
      provider,
      url: videoUrl,
      mimeType: /\.m3u8(\?|$)/i.test(videoUrl) ? "application/x-mpegURL" : "video/mp4",
    };
  } catch (err) {
    return { success: false, provider, message: String((err && err.message) || err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deteksi penyedia dari URL embed
// ─────────────────────────────────────────────────────────────────────────────
function detectProvider(embedUrl) {
  const u = String(embedUrl || "").toLowerCase();
  if (u.includes("filedon.co")) return "filedon";
  if (u.includes("vidhide")) return "vidhide";
  if (u.includes("mega.nz")) return "mega";
  if (u.includes("blogger.com") || u.includes("blogspot")) return "blogs";
  // desustream: satu host, banyak varian player. Semuanya menyajikan MP4 mentah.
  if (u.includes("desustream") || u.includes("odcloud")) {
    if (u.includes("/odcdn")) return "odcdn";
    if (u.includes("ondesu")) return "ondesu2hd";
    return "odstream";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver terpadu
// ─────────────────────────────────────────────────────────────────────────────
async function resolveStream(embedUrl) {
  const provider = detectProvider(embedUrl);
  if (!provider) {
    return { success: false, message: "Penyedia player tidak dikenali", embed: embedUrl };
  }

  switch (provider) {
    case "filedon":
      return await resolveFiledon(embedUrl);
    case "vidhide":
      return {
        success: false,
        provider,
        message:
          "CDN vidhide menolak request server (0 byte/403, token+IP bound). " +
          "Packed JS bisa di-decode tapi stream tidak bisa diambil.",
      };
    case "mega":
      return await resolveMega(embedUrl);
    case "odcdn":
    case "odstream":
    case "ondesu2hd":
      return await resolveDesustream(embedUrl, provider);
    case "blogs":
      return {
        success: false,
        provider,
        // Bukan kegagalan: iframe Blogger praktis tanpa iklan, frontend
        // menandainya "Ryu-lokal" dan memutar iframe apa adanya.
        noAds: true,
        message: "Player Blogger bersih (tanpa iklan) — diputar langsung tanpa resolve.",
      };
    case "odstream":
      return {
        success: false,
        provider,
        message: "odstream/desustream: `file` masih placeholder, butuh kode enkripsi dari AJAX.",
      };
    default:
      return { success: false, provider, message: "Tidak ada resolver untuk penyedia ini" };
  }
}

module.exports = {
  detectProvider,
  resolveStream,
  resolveFiledon,
  resolveMega,
  decodeMegaToken,
  parseInertiaDataPage,
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────
module.exports.registerRoutes = function registerRoutes(app, deps = {}) {
  const getCache = deps.getCache || (() => null);
  const setCache = deps.setCache || (() => {});
  const getRequestBaseUrl =
    deps.getRequestBaseUrl || ((req) => `http://${req.headers.host || "localhost"}`);

  // Host publik dipakai untuk membentuk URL proxy yang bisa diakses frontend.
  // Di balik nginx/tunnel, `Host` sering diteruskan sebagai 127.0.0.1:3014,
  // jadi URL absolutnya salah kalau hanya mengandalkan req.headers.host.
  // STREAM_PUBLIC_BASE (atau PUBLIC_API_BASE) dipakai lebih dulu bila di-set.
  const PUBLIC_BASE = (
    process.env.STREAM_PUBLIC_BASE ||
    process.env.PUBLIC_API_BASE ||
    ""
  ).replace(/\/$/, "");

  function buildPublicBase(req) {
    if (PUBLIC_BASE) return PUBLIC_BASE;
    // Hormati X-Forwarded-Host kalau ada (lebih akurat daripada req.get("host"))
    const fwdHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    if (fwdHost && !/^(127\.0\.0\.1|localhost)/i.test(fwdHost)) {
      const fwdProto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
      return `${fwdProto}://${fwdHost}`;
    }
    const host = req.get("host") || "";
    if (!/^(127\.0\.0\.1|localhost)/i.test(host)) return getRequestBaseUrl(req);
    // Fallback terakhir: tetap kembalikan sesuatu yang bisa dipakai
    return getRequestBaseUrl(req);
  }

  /**
   * GET /stream/resolve?url=<embed-url>
   * Ubah URL embed player menjadi URL video langsung + versi proxy.
   */
  app.get("/stream/resolve", async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success: false, message: "Parameter 'url' diperlukan" });

    const provider = detectProvider(url);
    const cacheKey = `stream_resolve_${provider}_${url}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const info = await resolveStream(url);
    if (!info.success) return res.status(502).json(info);

    // Versi proxy: supaya frontend bisa memutar tanpa kena CORS/hotlink.
    const base = buildPublicBase(req);
    if (info.megaToken) {
      // MEGA: URL gateway berisi ciphertext — browser tidak bisa memutarnya
      // langsung, jadi arahkan ke proxy lokal yang mendekripsi saat streaming.
      info.url_proxy = `${base}/stream/mega/${info.megaToken}`;
      delete info.megaToken;
    } else {
      info.url_proxy = `${base}/stream/proxy/${Buffer.from(info.url).toString("base64url")}`;
    }

    setCache(cacheKey, info, 60 * 30); // 30 menit (presigned R2 biasanya 1 jam)
    res.json(info);
  });

  // ── Cache File object MEGA (in-memory) ────────────────────────────────────
  // URL gateway MEGA berumur pendek, dan loadAttributes butuh ~0,5–1 dtk.
  // Browser memicu banyak request Range saat seek, jadi objek File di-cache
  // sebentar supaya tiap chunk tidak membayar hand-shake MEGA lagi.
  const megaFileCache = new Map(); // embedUrl -> { file, expires }
  const MEGA_FILE_TTL = 30 * 60 * 1000;

  async function getMegaFile(embedUrl) {
    const hit = megaFileCache.get(embedUrl);
    if (hit && hit.expires > Date.now()) return hit.file;
    const file = buildMegaFile(embedUrl);
    await loadMegaAttributes(file);
    megaFileCache.set(embedUrl, { file, expires: Date.now() + MEGA_FILE_TTL });
    if (megaFileCache.size > 200) {
      for (const [key, value] of megaFileCache) {
        if (value.expires <= Date.now()) megaFileCache.delete(key);
      }
    }
    return file;
  }

  /**
   * GET /stream/mega/:token
   * Streaming MEGA terdekripsi (AES-128-CTR dibuka megajs) dengan dukungan
   * Range supaya bisa di-seek. `?dl=1` mengubah respons jadi unduhan.
   */
  app.get("/stream/mega/:token", async (req, res) => {
    const parsed = decodeMegaToken(req.params.token);
    if (!parsed) return res.status(400).send("Token MEGA tidak valid");

    let file;
    try {
      file = await getMegaFile(parsed.u);
    } catch (err) {
      console.error("[StreamMega] loadAttributes gagal:", err.message || err);
      return res.status(502).send("Gagal memuat metadata MEGA");
    }

    const size = Number(file.size) || 0;
    if (!size) return res.status(502).send("Ukuran file tidak diketahui");

    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (!m) return res.status(416).end();
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
      if (!Number.isFinite(start) || start >= size || start > end) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.status(416).end();
      }
    }

    res.status(range ? 206 : 200);
    res.set({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    if (range) res.set("Content-Range", `bytes ${start}-${end}/${size}`);

    if (req.query.dl) {
      // Nama file aman untuk header (tanpa karakter kontrol/kutip).
      const safeName = String(file.name || "video.mp4").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "video.mp4";
      res.set("Content-Disposition", `attachment; filename="${safeName}"`);
    }

    let stream;
    try {
      stream = file.download({ start, end, maxConnections: 1 });
    } catch (err) {
      console.error("[StreamMega] download gagal:", err.message || err);
      if (!res.headersSent) return res.status(502).send("Gagal memuat stream");
      return res.end();
    }

    stream.on("error", (err) => {
      console.error("[StreamMega] stream error:", err.message || err);
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    stream.pipe(res);
  });

  /**
   * GET /stream/proxy/:encodedUrl
   * Proxy video (mendukung Range request agar bisa di-seek).
   */
  app.get(/^\/stream\/proxy\/(.+)/, async (req, res) => {
    const encoded = req.params[0];
    let target;
    try {
      target = Buffer.from(encoded, "base64url").toString("utf8");
    } catch (_) {
      return res.status(400).send("URL tidak valid");
    }
    if (!/^https?:\/\//i.test(target)) return res.status(400).send("URL tidak valid");

    try {
      const headers = {
        "User-Agent": UA,
        Accept: "*/*",
      };
      // Teruskan Range agar pemutar bisa seek & streaming bertahap.
      if (req.headers.range) headers.Range = req.headers.range;

      const upstream = await axios.get(target, {
        headers,
        responseType: "stream",
        timeout: 30000,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      res.status(upstream.status);
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Accept-Ranges", upstream.headers["accept-ranges"] || "bytes");
      for (const h of ["content-length", "content-range"]) {
        if (upstream.headers[h]) res.set(h, upstream.headers[h]);
      }
      // Cloudflare R2 membalas application/octet-stream; browser butuh
      // content-type video yang benar supaya langsung memutar (bukan unduh).
      const upstreamType = upstream.headers["content-type"] || "";
      let contentType = upstreamType;
      if (!contentType || /octet-stream/i.test(contentType)) {
        contentType = /\.m3u8(\?|$)/i.test(target)
          ? "application/vnd.apple.mpegurl"
          : "video/mp4";
      }
      res.set("Content-Type", contentType);
      res.set("Cache-Control", "public, max-age=3600");

      upstream.data.pipe(res);
      upstream.data.on("error", () => {
        if (!res.headersSent) res.status(502).end();
        else res.end();
      });
    } catch (err) {
      console.error("[StreamProxy] error:", target.slice(0, 80), err.message);
      if (!res.headersSent) res.status(502).send("Gagal mengambil stream");
    }
  });

  /**
   * GET /stream/providers
   * Info penyedia mana yang didukung (untuk frontend memilih server).
   */
  app.get("/stream/providers", (req, res) => {
    res.json({
      success: true,
      data: {
        supported: ["filedon", "mega"],
        cleanIframe: {
          blogs: "Player Blogger praktis tanpa iklan — diputar langsung, ditandai Ryukomik",
        },
        unsupported: {
          vidhide: "CDN menolak request server (0 byte/403)",
          odstream: "Butuh kode enkripsi dari AJAX",
        },
      },
    });
  });
};
