/**
 * =====================================================
 * 🌸 SCRAPER KOMIKINDO / MANHWAINDO - https://www.manhwaindo.my/
 * =====================================================
 * Menggunakan axios + cheerio (tanpa Puppeteer)
 * Output JSON menyamakan format scraper Kiryuu
 * =====================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.manhwaindo.my";

// ===========================
// 🛠️ HELPER FUNCTIONS
// ===========================

function headers(referer = BASE_URL + "/") {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    Referer: referer,
    Connection: "keep-alive",
  };
}

const cloudscraper = require("cloudscraper");

// Logging verbose dinonaktifkan secara default (hemat CPU & I/O).
// Set VERBOSE_SCRAPE_LOG=1 untuk mengaktifkan.
function vlog(...args) {
  if (process.env.VERBOSE_SCRAPE_LOG === "1") console.log(...args);
}

// Pangkas pesan error agar body HTML besar tidak ikut masuk ke log.
function shortErrMsg(err, max = 120) {
  const msg = String(err?.message || err || "").replace(/\s+/g, " ").trim();
  return msg.length > max ? msg.slice(0, max) + "..." : msg;
}

// ===========================
// ⚡ CIRCUIT BREAKER
// ===========================
// Masalah: kalau manhwaindo.my mati, setiap request tunggu 3× timeout
// (axios + cloudscraper + worker) = ~60 detik CPU terbuang.
// Solusi: setelah N gagal berturut-turut, buka circuit → gagal cepat
// selama cooldown, lalu coba lagi sekali (half-open).
const CIRCUIT_THRESHOLD = Number(process.env.KOMIKINDO_CIRCUIT_THRESHOLD || 3);
const CIRCUIT_COOLDOWN_MS = Number(process.env.KOMIKINDO_CIRCUIT_COOLDOWN_MS || 5 * 60 * 1000);

const circuit = { open: false, failures: 0, openedAt: 0, totalOpened: 0 };

function recordFetchSuccess() {
  if (circuit.failures || circuit.open) {
    console.log(`[Komikindo] ✅ Sumber hidup lagi — circuit ditutup (gagal sebelumnya: ${circuit.failures})`);
  }
  circuit.failures = 0;
  circuit.open = false;
}

function recordFetchFailure() {
  circuit.failures += 1;
  if (!circuit.open && circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.open = true;
    circuit.openedAt = Date.now();
    circuit.totalOpened += 1;
    console.error(
      `[Komikindo] 🔴 CIRCUIT DIBUKA setelah ${circuit.failures} gagal berturut-turut. ` +
      `Request ke /komikid/* akan ditolak cepat selama ${CIRCUIT_COOLDOWN_MS / 1000}s ` +
      `(hemat ~60s CPU per request).`
    );
  }
}


function isCloudflareChallenge(html = "") {
  const s = String(html);
  // ⚠️ PENTING: Cloudflare JSD (JavaScript Detection) MENYUNTIKKAN string
  // "challenge-platform" (via /cdn-cgi/challenge-platform/scripts/jsd/main.js)
  // ke SETIAP halaman normal manhwaindo.my. Memakai string itu sendirian
  // sebagai penanda challenge = false positive: semua halaman valid ikut
  // ditolak, circuit breaker terbuka, dan sumber yang hidup dianggap mati.
  // Deteksi hanya pola challenge yang benar-benar ada di halaman challenge.
  if (/<title[^>]*>\s*Just a moment/i.test(s)) return true;
  if (/_cf_chl_opt|cf_chl_opt\s*[:=]/i.test(s)) return true;
  if (/Enable JavaScript and cookies to continue/i.test(s)) return true;
  if (/name=["']cf_chl_/i.test(s)) return true;
  return false;
}

async function fetchViaProxies(fullUrl, timeout) {
  const attempts = [];

  const WORKER_PROXY = process.env.KOMIKINDO_PROXY_URL || "https://proxy.kopipaitboskuh.workers.dev/";
  if (WORKER_PROXY) {
    try {
      const separator = WORKER_PROXY.endsWith("=") ? "" : (WORKER_PROXY.includes("?") ? "&url=" : "?url=");
      const workerUrl = `${WORKER_PROXY}${separator}${encodeURIComponent(fullUrl)}&referer=${encodeURIComponent(BASE_URL + "/")}`;
      const { data } = await axios.get(workerUrl, { timeout: Math.max(timeout, 15000), maxContentLength: 25 * 1024 * 1024 });
      if (typeof data === "string" && data.length > 2000 && !isCloudflareChallenge(data) && /ManhwaIndo|manhwaindo/i.test(data)) {
        vlog(`[Komikindo] ✅ Worker proxy berhasil untuk ${fullUrl}`);
        return data;
      }
      attempts.push("worker:kualitas-data");
    } catch (err) {
      attempts.push(`worker:${err.response?.status || err.code || shortErrMsg(err)}`);
    }
  }

  const CORS_PROXY = process.env.KOMIKINDO_CORS_PROXY || "https://api.cors.lol/?url=";
  if (CORS_PROXY) {
    try {
      const { data } = await axios.get(`${CORS_PROXY}${encodeURIComponent(fullUrl)}`, {
        timeout: Math.max(timeout, 15000),
        headers: { Accept: "text/html,application/xhtml+xml" },
        maxContentLength: 25 * 1024 * 1024,
      });
      if (typeof data === "string" && data.length > 2000 && !isCloudflareChallenge(data) && /ManhwaIndo|manhwaindo/i.test(data)) {
        vlog(`[Komikindo] ✅ Proxy CORS berhasil untuk ${fullUrl}`);
        return data;
      }
      attempts.push("corsproxy:kualitas-data");
    } catch (err) {
      attempts.push(`corsproxy:${err.response?.status || err.code || shortErrMsg(err)}`);
    }
  }

  if (attempts.length) console.warn(`[Komikindo] ⚠️ Proxy gagal untuk ${fullUrl}: ${attempts.join(" -> ")}`);
  return null;
}

async function customFetch(url, options = {}) {
  const fullUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  const reqHeaders = headers(options.referer || BASE_URL + "/");
  // Timeout diturunkan dari 20s → 8s: sumber yang mati biasanya langsung
  // timeout, jadi tidak perlu menunggu lama. Total 3 strategi = 24s (dari 60s).
  const timeout = options.timeout || Number(process.env.KOMIKINDO_TIMEOUT_MS || 8000);
  const errors = [];

  // ── Circuit breaker ──
  // Kalau BASE_URL sudah gagal berkali-kali, jangan buang waktu 60 detik
  // per request. Langsung tolak cepat sampai masa cooldown habis.
  if (circuit.open) {
    if (Date.now() - circuit.openedAt < CIRCUIT_COOLDOWN_MS) {
      // Direct/cloudscraper dilewati, TAPI proxy tetap dicoba: proxy memakai IP
      // lain sehingga blokir IP server tidak berlaku.
      const proxied = await fetchViaProxies(fullUrl, timeout);
      if (proxied) {
        recordFetchSuccess();
        return proxied;
      }
      throw new Error(`Komikindo circuit terbuka (sumber mati). Coba lagi dalam ${Math.ceil((CIRCUIT_COOLDOWN_MS - (Date.now() - circuit.openedAt)) / 1000)}s`);
    }
    // cooldown habis → coba sekali lagi (half-open), reset setengah
    circuit.open = false;
    circuit.failures = 0;
  }

  // Strategi 1: Axios direct
  try {
    const { data } = await axios.get(fullUrl, { headers: reqHeaders, timeout });
    if (typeof data === "string" && !isCloudflareChallenge(data)) {
      recordFetchSuccess();
      return data;
    }
    errors.push("axios:cloudflare-challenge");
  } catch (err) {
    errors.push(`axios:${err.response?.status || err.code || err.message}`);
  }

  // Strategi 2: Cloudscraper
  try {
    const html = await cloudscraper.get({ uri: fullUrl, headers: reqHeaders, timeout });
    if (typeof html === "string" && html.trim() && !isCloudflareChallenge(html)) {
      console.log(`[Komikindo] ✅ Cloudscraper berhasil untuk ${fullUrl}`);
      recordFetchSuccess();
      return html;
    }
    errors.push("cloudscraper:cloudflare-challenge");
  } catch (err) {
    errors.push(`cloudscraper:${err.response?.status || err.code || shortErrMsg(err)}`);
  }

  // Strategi 3: proxy (Worker + CORS publik)
  const proxiedHtml = await fetchViaProxies(fullUrl, timeout);
  if (proxiedHtml) {
    recordFetchSuccess();
    return proxiedHtml;
  }

  // ── 404 / error klien TIDAK boleh membuka circuit ──
  // URL chapter yang sudah dihapus (404) bukan tanda sumber mati. Kalau ikut
  // dihitung, beberapa link lama saja sudah cukup membuka circuit dan
  // mematikan seluruh endpoint /komikid/* selama 5 menit.
  const clientErrorsOnly = errors.length > 0 && errors.every((e) => /:(404|410)\b/.test(e));
  if (clientErrorsOnly) {
    vlog(`[Komikindo] ⏭️  ${fullUrl} tidak ada (404) — circuit tidak dihitung gagal.`);
  } else {
    recordFetchFailure();
  }
  console.error(`[Komikindo] ❌ Semua strategi gagal untuk ${fullUrl}: ${errors.join(" -> ")}`);
  throw new Error(`Komikindo fetch gagal: ${errors.join(" -> ")}`);
}

function extractSlugFromUrl(url = "") {
  if (!url) return "";
  return url.replace(BASE_URL, "").replace(/^\/series\//, "/").replace(/^\/|\/$/g, "");
}

function extractTypeFromClass(el, $) {
  const typeSpan = $(el).find("span.type");
  if (!typeSpan.length) return "";
  const classes = typeSpan.attr("class") || "";
  const typeClass = classes.split(" ").find((c) => c !== "type");
  return typeClass || "";
}

// Image rewriting logic
function getRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function toBackendImageUrl(url, req) {
  if (!url) return "";
  return `${getRequestBaseUrl(req)}/komikid/image?url=${encodeURIComponent(url)}`;
}

function rewriteImages(payload, req) {
  if (Array.isArray(payload)) {
    return payload.map((item) => rewriteImages(item, req));
  }
  if (!payload || typeof payload !== "object") return payload;

  const rewritten = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      rewritten[key] = value.map((img) => typeof img === "string" ? toBackendImageUrl(img, req) : img);
      continue;
    }
    if ((key === "image" || key === "thumbnail") && typeof value === "string") {
      rewritten[key] = toBackendImageUrl(value, req);
      continue;
    }
    if (value && typeof value === "object") {
      rewritten[key] = rewriteImages(value, req);
      continue;
    }
    rewritten[key] = value;
  }
  return rewritten;
}

// =====================================================
// 📚 SCRAPER: PUSTAKA / LATEST UPDATES
// =====================================================
function translateTime(str) {
  if (!str) return "";
  return str
    .replace(/seconds?/i, "detik")
    .replace(/minutes?/i, "menit")
    .replace(/hours?/i, "jam")
    .replace(/days?/i, "hari")
    .replace(/weeks?/i, "minggu")
    .replace(/months?/i, "bulan")
    .replace(/years?/i, "tahun")
    .replace(/ago/i, "lalu");
}

// ── Helper: ekstrak JSON array seimbang dari dalam HTML ──
// Situs baru menempelkan data chapter sebagai `chapters = [{...}]` di dalam
// <script>. Regex tidak aman untuk JSON bersarang, jadi kurung dihitung manual.
function extractJsonArray(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf("[", i);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, j + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

// ── Helper: fetch endpoint JSON (admin-ajax / wp-json) ──
// customFetch() dirancang untuk HTML: respons JSON otomatis di-parse axios jadi
// object, sehingga cek `typeof data === "string"` gagal dan dianggap error.
// Karena itu endpoint JSON butuh jalur sendiri.
async function fetchJson(url) {
  const reqHeaders = headers(BASE_URL + "/");
  const timeout = Number(process.env.KOMIKINDO_TIMEOUT_MS || 8000);
  try {
    const { data } = await axios.get(url, { headers: reqHeaders, timeout });
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (err) {
    const raw = await cloudscraper.get({ uri: url, headers: reqHeaders, timeout });
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
}

// ── Helper: chapterlist manhwaindo format baru (tema AGC v1.17.x) ──
// Tema lama menaruh daftar chapter di `chapters = [...]`; sekarang dipecah:
//   window.agcChapterListConfig  -> { seriesId, total, version, endpoint }
//   window.agcInitialChapters    -> 60 chapter terbaru (sisa via REST)
// Endpoint REST /wp-json/agc/v1/chapters?series=ID mengembalikan SEMUA chapter.
// Ambil seriesId dulu, lalu REST (fallback ke 60 dari HTML bila REST gagal),
// supaya komik dengan >60 chapter tidak terpotong.
function extractAgcConfig(html) {
  const m = html.match(/agcChapterListConfig\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!m) return null;
  const body = m[1].replace(/\/\/[^\n\r]*/g, "");
  const get = (key) => {
    const r = new RegExp(`["']?${key}["']?\\s*:\\s*["']?([^"',}\\s]+)["']?`);
    const mm = body.match(r);
    return mm ? mm[1] : "";
  };
  const seriesId = parseInt(get("seriesId"), 10);

  // Nilai di HTML di-escape (mis. "https:\/\/host\/wp-json\/..."), jadi
  // backslash harus dibuang dulu. Kalau hasilnya tidak valid, pakai default.
  let endpoint = get("endpoint").replace(/\\\//g, "/");
  if (!/^https?:\/\//.test(endpoint)) {
    endpoint = `${BASE_URL}/wp-json/agc/v1/chapters`;
  }

  return {
    seriesId: Number.isNaN(seriesId) ? 0 : seriesId,
    total: parseInt(get("total"), 10) || 0,
    version: get("version") || "",
    endpoint,
  };
}

function extractAgcInitialChapters(html) {
  const i = html.indexOf("agcInitialChapters");
  if (i < 0) return [];
  const arr = extractJsonArray(html.slice(i), "=");
  return Array.isArray(arr) ? arr : [];
}

// Ubah item chapter (format AGC) -> bentuk standar output API.
function mapAgcChapters(rawChapters) {
  const seen = new Set();
  const chapters = [];
  for (const c of rawChapters || []) {
    const link = c && c.url ? String(c.url).replace(/\\\//g, "/") : "";
    if (!link || seen.has(link)) continue;
    seen.add(link);
    const num = parseFloat(c.chapter);
    chapters.push({
      title: `Chapter ${c.chapter}`,
      slug: extractSlugFromUrl(link),
      link,
      date: translateTime(c.time || ""),
      _num: Number.isNaN(num) ? -1 : num,
    });
  }
  // Urutan sumber tidak konsisten; chapter terbesar = terbaru.
  chapters.sort((a, b) => b._num - a._num);
  chapters.forEach((c) => {
    delete c._num;
  });
  return chapters;
}

// Ambil seluruh chapter: REST dulu (lengkap), fallback ke HTML (60 terbaru).
async function fetchAgcChapters(html, vlog) {
  const cfg = extractAgcConfig(html);
  if (cfg && cfg.seriesId) {
    try {
      const endpoint = `${cfg.endpoint}?series=${cfg.seriesId}`;
      const data = await fetchJson(endpoint);
      const list = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : null;
      if (list && list.length) {
        vlog(`[Komikindo] ✅ chapterlist via REST (${list.length} chapter, series=${cfg.seriesId})`);
        return list;
      }
    } catch (err) {
      vlog(`[Komikindo] ⚠️ REST chapterlist gagal, fallback ke HTML: ${shortErrMsg(err)}`);
    }
  }
  const fallback = extractAgcInitialChapters(html);
  if (fallback.length) {
    vlog(`[Komikindo] ℹ️ chapterlist dari HTML (${fallback.length} chapter terbaru)`);
  }
  return fallback;
}

// ── Helper: parse kartu series (markup manhwaindo versi baru) ──
// Struktur: div.flex.gap-4  >  a.series[href][title]  (cover + judul)
//                            + ul > li > a (chapter) + span (waktu)
function parseSeriesCards($, scope, { withChapters = true } = {}) {
  const out = [];
  scope.find("a.series[href]").each((_, a) => {
    const $a = $(a);
    const link = $a.attr("href") || "";
    const title = ($a.attr("title") || $a.text() || "").trim();
    if (!link || !title) return;
    if (!/\/series\//.test(link)) return;
    if (out.some((o) => o.detail_link === link)) return;

    const card = $a.closest("div.flex.gap-4");
    const imgEl = $a.find("img").first();
    let image =
      imgEl.attr("src") || imgEl.attr("data-src") || imgEl.attr("data-lazy-src") || "";
    if (image.startsWith("data:image")) image = "";

    const chapters = [];
    if (withChapters) {
      card.find("ul li").each((__, li) => {
        const chLink = $(li).find("a").attr("href") || "";
        const chTitle = $(li).find("a").text().trim();
        const chTime = translateTime($(li).find("span").text().trim());
        if (chLink && chTitle) {
          chapters.push({ title: chTitle, link: chLink, time: chTime, locked: false });
        }
      });
    }

    const slug = extractSlugFromUrl(link);
    const latest = chapters[0] || {};
    const oldest = chapters[chapters.length - 1] || {};
    const description = card.find("p").first().text().trim();

    out.push({
      source: "komikindo",
      title,
      slug,
      image,
      detail_link: link,
      description,
      type_genre: "",
      info: latest.time || "",
      chapter_awal: oldest.title || "",
      chapter_terbaru: latest.title || "",
      chapters,
    });
  });
  return out;
}

async function scrapePustaka({ page = 1 } = {}) {
  try {
    const url = page === 1 ? `${BASE_URL}/` : `${BASE_URL}/page/${page}/`;
    vlog("🌸 Komikindo pustaka URL:", url);

    const html = await customFetch(url);
    const $ = cheerio.load(html);

    // Daftar update terbaru ada di #latest-series (markup baru, bukan .bixbox lagi).
    let scope = $("#latest-series");
    if (!scope.length) scope = $("body");
    const results = parseSeriesCards($, scope, { withChapters: true });

    let totalPages = 1;
    const pages = [];
    $('a.page-numbers[href*="/page/"]').each((_, el) => {
      const m = ($(el).attr("href") || "").match(/\/page\/(\d+)\//);
      if (m) pages.push(parseInt(m[1], 10));
    });
    if (pages.length) totalPages = Math.max(...pages);

    return {
      success: true,
      meta: {
        currentPage: page,
        totalPages,
        totalItems: results.length,
      },
      data: results,
    };
  } catch (err) {
    console.error("❌ Komikindo pustaka error:", err.message);
    return {
      success: false,
      meta: { currentPage: page, totalPages: 1, totalItems: 0 },
      data: [],
    };
  }
}

// =====================================================
// 📖 SCRAPER: DETAIL MANGA
// =====================================================

async function scrapeDetail(url) {
  try {
    vlog("🌸 Komikindo detail URL:", url);
    const html = await customFetch(url, { referer: BASE_URL + "/" });
    const $ = cheerio.load(html);

    // Metadata paling stabil ada di JSON-LD (schema.org BookSeries).
    let book = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (book) return;
      try {
        const parsed = JSON.parse($(el).html() || "");
        const items = Array.isArray(parsed) ? parsed : parsed["@graph"] || [parsed];
        for (const it of items) {
          if (it && it["@type"] === "BookSeries") {
            book = it;
            break;
          }
        }
      } catch (e) {
        // abaikan blok JSON-LD yang tidak valid
      }
    });

    const title = $("h1").first().text().trim() || (book && book.name) || "";
    const thumbnail =
      (book && book.image) ||
      $('img[src*="manga-images"]').first().attr("src") ||
      "";
    const author = (book && book.author && book.author.name) || "";
    const artist = (book && book.artist && book.artist.name) || "";
    const alternative = (book && book.alternateName) || "";

    const genres = [];
    $('a[href*="/genres/"]').each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    let synopsis = "";
    $("h2").each((_, el) => {
      if ($(el).text().trim().toLowerCase() === "sinopsis") {
        const p = $(el).next("p");
        if (p.length) synopsis = p.text().trim();
      }
    });
    if (!synopsis) synopsis = (book && book.description) || "Tidak ada sinopsis.";

    // Label metadata (Penulis / Artist / Chapter Terbaru / Terakhir Update ...)
    const meta = {};
    $("strong").each((_, el) => {
      const label = $(el)
        .text()
        .replace(/[:：]\s*$/, "")
        .trim()
        .toLowerCase();
      const val = $(el).next("span, a");
      if (label && val.length) meta[label] = val.text().trim();
    });

    // Daftar chapter: format baru (AGC) via REST /wp-json/agc/v1/chapters,
    // fallback ke JSON embedded di HTML. Marker lama `chapters = [` sudah
    // tidak dipakai tema manhwaindo v1.17.x sehingga selalu kosong.
    const rawChapters = await fetchAgcChapters(html, vlog);
    const chapters = mapAgcChapters(rawChapters);

    return {
      success: true,
      data: {
        title: title || "",
        thumbnail: thumbnail || "",
        type: meta["tipe"] || meta["type"] || "",
        status: meta["status"] || "-",
        Pengarang: author || meta["penulis"] || "-",
        Umur: meta["umur"] || "-",
        Konsep: meta["konsep"] || meta["terakhir update"] || "-",
        artist: artist || meta["artist"] || "-",
        alternative: alternative || "",
        genres: genres || [],
        synopsis: synopsis || "",
        info: meta["terakhir update"] || "",
        total_chapter: chapters.length,
        chapters,
      },
    };
  } catch (err) {
    console.error("❌ Komikindo detail error:", err.message);
    return {
      success: false,
      message: "Gagal scrape detail.",
    };
  }
}

// =====================================================
// 🖼️ SCRAPER: CHAPTER IMAGES
// =====================================================

async function scrapeChapter(url) {
  try {
    vlog("🌸 Komikindo chapter URL:", url);
    const html = await customFetch(url, { referer: BASE_URL + "/" });
    const $ = cheerio.load(html);

    const title = $("h1").first().text().trim();

    // Gambar chapter ada langsung di .reader-area (bukan ts_reader lagi).
    const images = [];
    $(".reader-area img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || "";
      if (src && !src.startsWith("data:image")) images.push(src);
    });

    // Navigasi chapter: window.agcReaderPrev / agcReaderNext (string JSON-escaped).
    const grabWindowUrl = (name) => {
      const m = html.match(new RegExp(`window\\.${name}\\s*=\\s*"([^"]*)"`));
      if (!m) return null;
      const v = m[1].replace(/\\\//g, "/");
      return v || null;
    };

    let prevUrl = grabWindowUrl("agcReaderPrev");
    let nextUrl = grabWindowUrl("agcReaderNext");
    if (!prevUrl) prevUrl = $('a[rel="prev"]').attr("href") || null;
    if (!nextUrl) nextUrl = $('a[rel="next"]').attr("href") || null;

    const cleanNavLink = (link) => {
      if (!link || link === "#") return null;
      return extractSlugFromUrl(link) || null;
    };

    const chapterSlug = extractSlugFromUrl(url);
    const mangaSlugMatch = chapterSlug.match(/^(.+?)-chapter-/);
    const mangaId = mangaSlugMatch ? mangaSlugMatch[1] : chapterSlug;

    return {
      success: true,
      mangaId,
      chapterSlug,
      currentChapter: title,
      prev: cleanNavLink(prevUrl),
      next: cleanNavLink(nextUrl),
      back_to_detail: `${BASE_URL}/series/${mangaId}/`,
      totalImages: images.length,
      images,
    };
  } catch (err) {
    console.error("❌ Komikindo chapter error:", err.message);
    return {
      success: false,
      message: err.message,
    };
  }
}

// =====================================================
// 🔍 SCRAPER: SEARCH
// =====================================================

async function scrapeSearch(query) {
  try {
    // Situs baru menyediakan endpoint AJAX khusus pencarian (manga_search).
    // Jauh lebih stabil daripada menebak markup halaman hasil pencarian.
    const url = `${BASE_URL}/wp-admin/admin-ajax.php?action=manga_search&q=${encodeURIComponent(query)}`;
    vlog("🌸 Komikindo search URL:", url);

    let arr = await fetchJson(url);
    if (!Array.isArray(arr)) arr = [];

    const results = arr
      .map((it) => ({
        title: it.title || "",
        image: it.thumbnail || "",
        detail_link: it.url || "",
        type_genre: "",
        update: it.chapter ? `Chapter ${it.chapter}` : "",
        rating: "",
      }))
      .filter((r) => r.title && r.detail_link);

    return {
      success: true,
      total: results.length,
      query,
      data: results,
    };
  } catch (err) {
    console.error("❌ Komikindo search error:", err.message);
    return {
      success: true,
      total: 0,
      query,
      data: [],
      warning: "Gagal melakukan pencarian Komikindo",
    };
  }
}

// =====================================================
// 🎛️ SCRAPER: FILTER OPTIONS (genre / status / type / order)
// =====================================================
// Markup baru (halaman /series/):
//   genre  -> <input type="checkbox" name="genre[]" value="slug"> <span>LABEL</span>
//   status -> <select name="status"><option value="Ongoing">Ongoing</option>
//   type   -> <select name="type"><option value="Manhwa">Manhwa</option>
//   order  -> <select name="sort"><option value="modified">Update Terbaru</option>
async function scrapeFilters() {
  try {
    const html = await customFetch(`${BASE_URL}/series/`);
    const $ = cheerio.load(html);

    const collectSelect = (name) => {
      const out = [];
      $(`select[name="${name}"] option`).each((_, el) => {
        const value = $(el).attr("value") || "";
        const label = $(el).text().trim();
        if (label) out.push({ value, label });
      });
      return out;
    };

    const genre = [];
    $('input[name="genre[]"]').each((_, el) => {
      const value = $(el).attr("value") || "";
      const label =
        $(el).next("span").text().trim() || $(el).parent().text().trim();
      if (value && label) genre.push({ value, label });
    });

    // Frontend dropdown memakai format komiku: array {value,label}.
    return {
      tipe: collectSelect("type"),
      status: collectSelect("status"),
      genre,
      genre2: genre,
      orderby: collectSelect("sort"),
    };
  } catch (err) {
    console.error("❌ Komikindo filter scrape error:", err.message);
    return {};
  }
}

async function scrapePustakaFilter({ orderby, tipe, genre, genre2, status, page = 1 } = {}) {
  try {
    const params = new URLSearchParams();
    if (genre) params.append("genre[]", genre);
    if (genre2) params.append("genre[]", genre2);
    if (status) params.append("status", status);
    if (tipe) params.append("type", tipe);
    // Default frontend "modified"/kosong -> situs pakai "update" (komik terbaru).
    const order = !orderby || orderby === "modified" ? "update" : orderby;
    params.append("order", order);

    // Pagination situs baru memakai path, bukan query: /series/page/N/
    const path = page > 1 ? `/series/page/${page}/` : "/series/";
    const url = `${BASE_URL}${path}?${params.toString()}`;
    console.log("🌸 Komikindo filter URL:", url);

    const html = await customFetch(url);
    const $ = cheerio.load(html);

    // Halaman /series/ tidak memuat daftar chapter per kartu.
    const results = parseSeriesCards($, $("body"), { withChapters: false });

    const hasNext =
      $(`a.page-numbers[href*="/page/${page + 1}/"]`).length > 0 ||
      $("a.next.page-numbers").length > 0;

    return { data: results, hasMore: hasNext && results.length > 0 };
  } catch (err) {
    console.error("❌ Komikindo pustaka-filter error:", err.message);
    return { data: [], hasMore: false };
  }
}

// =====================================================
// 🚀 ROUTE REGISTRATION
// =====================================================

module.exports = function registerKomikindoRoutes(app, { getCache, setCache, coalescedScrape, getImageCache, setImageCache }) {

  // ── IMAGE PROXY ──────────────────────────────────────
  const KOMIKID_PLACEHOLDER_SVG = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400" fill="#18181b">
      <rect width="300" height="400" fill="#18181b"/>
      <circle cx="150" cy="170" r="30" fill="#27272a"/>
      <path d="M140 160l20 20M160 160l-20 20" stroke="#71717a" stroke-width="3" stroke-linecap="round"/>
      <text x="150" y="230" text-anchor="middle" fill="#a1a1aa" font-family="system-ui, sans-serif" font-size="14" font-weight="600">Gambar Tidak Tersedia</text>
      <text x="150" y="250" text-anchor="middle" fill="#71717a" font-family="system-ui, sans-serif" font-size="11">Komikindo / manhwaindo 404</text>
    </svg>`
  );

  app.get("/komikid/image", async (req, res) => {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("No URL provided");
    }

    try {
      let decodedUrl = decodeURIComponent(url);
      if (decodedUrl.startsWith("http://kacu.gmbr.pro") || decodedUrl.includes(".gmbr.pro")) {
        decodedUrl = decodedUrl.replace(/^http:\/\//i, "https://");
      }

      const cached = getImageCache(decodedUrl);
      if (cached) {
        return res.set('Content-Type', cached.contentType).set('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800').send(cached.buffer);
      }

      const reqHeaders = headers(BASE_URL + "/");
      let imageBuffer, contentType = "image/jpeg";
      const errors = [];

      // Strategi 1: Cloudscraper (Bypass Cloudflare WAF / TLS blocking pada kacu.gmbr.pro)
      try {
        const csResult = await cloudscraper.get({
          uri: decodedUrl,
          headers: reqHeaders,
          encoding: null,
          timeout: 12000,
        });

        if (Buffer.isBuffer(csResult) && csResult.length > 500) {
          imageBuffer = csResult;
          if (csResult[0] === 0xFF && csResult[1] === 0xD8) contentType = "image/jpeg";
          else if (csResult[0] === 0x89 && csResult[1] === 0x50) contentType = "image/png";
          else if (csResult[0] === 0x52 && csResult[1] === 0x49) contentType = "image/webp";
          else if (csResult[0] === 0x47 && csResult[1] === 0x49) contentType = "image/gif";
        } else {
          errors.push("cloudscraper:response-terlalu-kecil");
        }
      } catch (err) {
        errors.push(`cloudscraper:${err.response?.status || err.code || shortErrMsg(err)}`);
      }

      // Strategi 2: Direct Axios
      if (!imageBuffer) {
        try {
          const response = await axios.get(decodedUrl, {
            headers: reqHeaders,
            responseType: "arraybuffer",
            timeout: 8000,
          });
          const ct = response.headers["content-type"] || "";
          if (ct.startsWith("image/") && response.data && response.data.length > 500) {
            imageBuffer = response.data;
            contentType = ct;
          } else {
            errors.push("direct:bukan-image");
          }
        } catch (err) {
          errors.push(`direct:${err.response?.status || err.message}`);
        }
      }

      // Strategi 3: Worker proxy
      if (!imageBuffer) {
        const WORKER_PROXY = process.env.KOMIKINDO_PROXY_URL || "https://proxy.kopipaitboskuh.workers.dev/";
        if (WORKER_PROXY) {
          try {
            const separator = WORKER_PROXY.endsWith("=") ? "" : (WORKER_PROXY.includes("?") ? "&url=" : "?url=");
            const workerUrl = `${WORKER_PROXY}${separator}${encodeURIComponent(decodedUrl)}&referer=${encodeURIComponent(BASE_URL + "/")}`;
            const response = await axios.get(workerUrl, {
              responseType: "arraybuffer",
              timeout: 10000,
            });
            const ct = response.headers["content-type"] || "";
            if (ct.startsWith("image/") && response.data && response.data.length > 500) {
              imageBuffer = response.data;
              contentType = ct;
            } else {
              errors.push("worker:bukan-image");
            }
          } catch (err) {
            errors.push(`worker:${err.response?.status || err.message}`);
          }
        }
      }

      if (!imageBuffer) {
        console.warn(`[Komikindo Proxy Fallback] Mengembalikan placeholder untuk ${decodedUrl} (${errors.join(" -> ")})`);
        res.set({
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
        });
        return res.status(200).send(KOMIKID_PLACEHOLDER_SVG);
      }

      res.set({
        "Content-Type": contentType,
        "Content-Length": imageBuffer.length,
        "Cache-Control": "public, max-age=2592000, s-maxage=2592000",
      });
      setImageCache(decodedUrl, imageBuffer, contentType);
      res.send(imageBuffer);
    } catch (err) {
      console.error(`[Komikindo Proxy Error] Fatal: ${err.message}`);
      res.set({
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      });
      res.status(200).send(KOMIKID_PLACEHOLDER_SVG);
    }
  });

  // ── PUSTAKA ─────────────────────────────────────────
  app.get("/komikid/pustaka", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `komikindo:pustaka:p:${page}`;

    const cached = getCache(cacheKey);
    if (cached) {
      vlog(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapePustaka({ page });

        if (!result.data.length) {
          return {
            success: true,
            page,
            total: 0,
            data: [],
            warning: "Data kosong / Komikindo limit",
          };
        }

        return {
          success: true,
          source: "www.manhwaindo.my",
          page,
          total: result.data.length,
          meta: result.meta,
          data: rewriteImages(result.data, req),
        };
      });

      setCache(cacheKey, responseData, 60);
      res.json(responseData);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── DETAIL ──────────────────────────────────────────
  app.get("/komikid/detail/:slug", async (req, res) => {
    const { slug } = req.params;
    if (!slug) {
      return res.status(400).json({ success: false, message: "Slug tidak diberikan!" });
    }

    const cacheKey = `komikindo:detail:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      vlog(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const fullUrl = `${BASE_URL}/series/${slug}/`;
        const scraped = await scrapeDetail(fullUrl);
        if (scraped.success) {
           scraped.data = rewriteImages(scraped.data, req);
        }
        return scraped;
      });

      if (result && result.success) {
        // Hasil kosong (mis. sumber sedang update chapter) hanya di-cache
        // sebentar supaya tidak "menempel" 15 menit seperti data valid.
        const isEmpty = !result.data || !Array.isArray(result.data.chapters) || result.data.chapters.length === 0;
        setCache(cacheKey, result, isEmpty ? 60 : 900);
      }
      res.json(result);
    } catch (err) {
      console.error("Route error:", err.message);
      res.status(500).json({ success: false, message: "Terjadi kesalahan pada server" });
    }
  });

  // ── CHAPTER ─────────────────────────────────────────
  app.get(/^\/komikid\/chapter\/(.+)/, async (req, res) => {
    const slug = req.params[0];
    const cacheKey = `komikindo:chapter:${slug}`;

    const cached = getCache(cacheKey);
    if (cached) {
      vlog(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const fullUrl = `${BASE_URL}/${slug}/`;
        const scraped = await scrapeChapter(fullUrl);
        if (scraped.success) {
           return rewriteImages(scraped, req);
        }
        return scraped;
      });

      if (result && result.success) {
        setCache(cacheKey, result, 7200);
      }
      res.json(result);
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  // ── FILTER OPTIONS ──────────────────────────────────
  app.get("/komikid/filters", async (req, res) => {
    const cacheKey = "komikindo:filters";
    const cached = getCache(cacheKey);
    if (cached) {
      vlog(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const data = await scrapeFilters();
        return { success: true, data };
      });
      setCache(cacheKey, responseData, 43200); // 12 jam
      res.json(responseData);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── PUSTAKA FILTER ──────────────────────────────────
  app.get("/komikid/pustaka-filter", async (req, res) => {
    try {
      const { orderby, tipe, genre, genre2, status } = req.query;
      const page = Math.max(1, parseInt(req.query.page) || 1);

      const cacheKey = `komikindo:pustaka-filter:o:${orderby}:t:${tipe}:g:${genre}:g2:${genre2}:s:${status}:p:${page}`;
      const cached = getCache(cacheKey);
      if (cached) {
        vlog(`⚡ [Cache Hit] ${cacheKey}`);
        return res.json(cached);
      }

      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapePustakaFilter({ orderby, tipe, genre, genre2, status, page });
        return {
          success: true,
          query: { page, orderby, tipe, genre, genre2, status },
          data: rewriteImages(result.data, req),
          hasMore: result.hasMore,
        };
      });

      setCache(cacheKey, responseData, 60); // 1 menit
      res.json(responseData);
    } catch (err) {
      console.error("❌ Komikindo pustaka-filter route error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── SEARCH ──────────────────────────────────────────
  app.get("/komikid/search", async (req, res) => {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    }

    const cacheKey = `komikindo:search:${q}`;
    const cached = getCache(cacheKey);
    if (cached) {
      vlog(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeSearch(q);
        if (result.success && result.data) {
           result.data = rewriteImages(result.data, req);
        }
        return result;
      });

      setCache(cacheKey, responseData, 60);
      res.json(responseData);
    } catch (err) {
      console.error("❌ Komikindo search route error:", err.message);
      res.status(200).json({
        success: true,
        total: 0,
        query: q,
        data: [],
        warning: "Gagal search Komikindo",
      });
    }
  });

  console.log("✅ Komikindo routes registered: /komikid/image, /komikid/pustaka, /komikid/detail/:slug, /komikid/chapter/:slug, /komikid/search, /komikid/filters, /komikid/pustaka-filter");

  // Status circuit breaker — untuk memantau apakah sumber masih mati.
  app.get("/komikid/status", (req, res) => {
    const sisaMs = circuit.open ? Math.max(0, CIRCUIT_COOLDOWN_MS - (Date.now() - circuit.openedAt)) : 0;
    res.json({
      sumber: BASE_URL,
      circuit: circuit.open ? "TERBUKA (sumber mati)" : "tertutup (normal)",
      gagalBerturut: circuit.failures,
      totalDibuka: circuit.totalOpened,
      cooldownSisaDetik: Math.round(sisaMs / 1000),
      timeoutMs: Number(process.env.KOMIKINDO_TIMEOUT_MS || 8000),
      ambangGagal: CIRCUIT_THRESHOLD,
    });
  });
};
