"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const sharp = require("sharp");

const BASE = "https://rosyscans.com";
const PROXY_URL = process.env.JOSEI_PROXY_URL || "https://proxy.kopipaitboskuh.workers.dev/?url=";
const IMAGE_HOSTS = new Set([
  "rosyscans.id",
  "www.rosyscans.id",
  "img.rosyscans.id",
  "rosyscans.com",
  "www.rosyscans.com",
  "i.ibb.co",
]);
// Jetpack/Photon (i0–i3.wp.com) dipakai upstream untuk cover. Host-nya generik,
// jadi hanya diterima kalau segmen pertama path-nya host asal yang kita kenal
// (mis. i0.wp.com/rosyscans.com/wp-content/...).
const PHOTON_HOST_RE = /^i[0-3]\.wp\.com$/;
function isAllowedImageUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (IMAGE_HOSTS.has(host)) return true;
  if (PHOTON_HOST_RE.test(host)) {
    const origin = (parsed.pathname.split("/")[1] || "").toLowerCase();
    return IMAGE_HOSTS.has(origin);
  }
  return false;
}
const PAGE_SIZE = 24;
let catalogCache = { expires: 0, data: null, pending: null };
let metadataCache = { expires: 0, data: null, pending: null };

// ── RosyScans anti-scraper shield (decoy filter + watermark patch compositor) ──
const SHIELD_SECRET = "r0sy_sh1eld_9472_k9x";
const PATCH_SECRETS = ["r0sy_v2_k7p9_3418_q4x", "r0sy_p4tch_8831_m7z"];
const SHIELD_MOD = 89;
const SHIELD_MIN_V = 1760000000;
const ROSY_IMG_RE = /uploads\/manga-images\/(\d+)\/([^/?#]+)\/([^/?#]+)/i;
const PATCH_CACHE_TTL_MS = 30 * 60 * 1000;
const PATCH_CACHE_MAX = 20;
const patchMapCache = new Map();
const patchMapInflight = new Map();

function fnv1a32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function xorshift32(seed) {
  let x = seed >>> 0;
  if (x === 0) x = 0x9e3779b9 >>> 0;
  x = (x ^ ((x << 13) >>> 0)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ ((x << 5) >>> 0)) >>> 0;
  return x >>> 0;
}

function decoySingleIndices(seriesId, chapterNum, total) {
  if (total < 8) return [];
  const k = Math.min(6, Math.max(2, Math.floor(total / 8)));
  const start = 1;
  const end = total - 2;
  const span = end - start + 1;
  if (span < k) return [];
  let seed = fnv1a32(`${SHIELD_SECRET}|${seriesId}|${chapterNum}|${total}`);
  const out = [];
  for (let i = 0; i < k; i++) {
    const lo = start + Math.floor((i * span) / k);
    let hi = start + Math.floor(((i + 1) * span) / k) - 1;
    if (hi < lo) hi = lo;
    const width = hi - lo + 1;
    seed = xorshift32(seed);
    out.push(lo + (seed % width));
  }
  return out;
}

function decoyBlockIndices(seriesId, chapterNum, total, blockSize, tag, t2, t3, t4) {
  let blocks = 0;
  if (total >= t4) blocks = 4;
  else if (total >= t3) blocks = 3;
  else if (total >= t2) blocks = 2;
  if (blocks <= 0) return [];
  const remaining = total - blocks * blockSize;
  if (remaining < blocks + 1) return [];
  const start = 1;
  const end = remaining - 1;
  const span = end - start + 1;
  let seed = fnv1a32(`${SHIELD_SECRET}|${tag}|${seriesId}|${chapterNum}|${total}`);
  const out = [];
  for (let i = 0; i < blocks; i++) {
    const lo = start + Math.floor((i * span) / blocks);
    let hi = start + Math.floor(((i + 1) * span) / blocks) - 1;
    if (hi < lo) hi = lo;
    const width = hi - lo + 1;
    seed = xorshift32(seed);
    const base = lo + (seed % width) + i * blockSize;
    for (let off = 0; off < blockSize; off++) out.push(base + off);
  }
  return out;
}

function parseRosyImageMeta(url) {
  const m = String(url || "").match(ROSY_IMG_RE);
  if (!m) return null;
  const vm = String(url || "").match(/[?&]v=(\d+)/);
  const v = vm ? Number.parseInt(vm[1], 10) : 0;
  return { seriesId: m[1], chapterNum: m[2], filename: m[3], v };
}

function filterRosyDecoys(images) {
  if (!Array.isArray(images) || images.length === 0) return images;
  let meta = null;
  for (const url of images) {
    const parsed = parseRosyImageMeta(url);
    if (parsed && parsed.v >= SHIELD_MIN_V) {
      meta = parsed;
      break;
    }
  }
  if (!meta) return images;
  const rem = meta.v % SHIELD_MOD;
  let decoys = [];
  if (rem === 79 || rem === 71) {
    decoys = decoyBlockIndices(meta.seriesId, meta.chapterNum, images.length, 16, "v3", 38, 64, 99);
  } else if (rem === 53) {
    decoys = decoyBlockIndices(meta.seriesId, meta.chapterNum, images.length, 8, "v2", 22, 40, 67);
  } else if (rem === 37) {
    decoys = decoySingleIndices(meta.seriesId, meta.chapterNum, images.length);
  }
  if (!decoys.length) return images;
  const decoySet = new Set(decoys);
  return images.filter((_, idx) => !decoySet.has(idx));
}

function decryptPatchBlob(b64, seriesId, chapterNum) {
  const bin = Buffer.from(b64, "base64");
  if (bin.length < 9) return null;
  let nonce = "";
  for (let n = 0; n < 8; n++) nonce += bin[n].toString(16).padStart(2, "0");
  for (const secret of PATCH_SECRETS) {
    try {
      let s1 = fnv1a32(`${secret}|${seriesId}|${chapterNum}|${nonce}`);
      let s2 = fnv1a32(`${nonce}|${chapterNum}|${secret}|${seriesId}`);
      const out = Buffer.allocUnsafe(bin.length - 8);
      let key = 0;
      for (let i = 0; i < out.length; i++) {
        if ((i & 3) === 0) {
          s1 = xorshift32(s1);
          s2 = xorshift32((s2 ^ s1) >>> 0);
          key = (s1 ^ s2) >>> 0;
        }
        out[i] = bin[i + 8] ^ ((key >>> ((i & 3) * 8)) & 0xff);
      }
      const parsed = JSON.parse(out.toString("utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {
      // Coba secret berikutnya.
    }
  }
  return null;
}

async function getRosyPatchMap(seriesId, chapterNum, v) {
  const key = `${seriesId}/${chapterNum}?v=${v}`;
  const cached = patchMapCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  if (patchMapInflight.has(key)) return patchMapInflight.get(key);

  const job = (async () => {
    try {
      const patchUrl = `https://img.rosyscans.id/uploads/manga-images/${seriesId}/${chapterNum}/patches.js?v=${v}`;
      const { data } = await axios.get(patchUrl, {
        headers: headers(`${BASE}/`),
        responseType: "text",
        timeout: 15000,
      });
      const m = typeof data === "string" ? data.match(/window\.__rsP\s*=\s*"([^"]+)"/) : null;
      const pmap = m ? decryptPatchBlob(m[1], seriesId, chapterNum) : null;
      if (patchMapCache.size >= PATCH_CACHE_MAX) {
        const oldest = patchMapCache.keys().next().value;
        if (oldest) patchMapCache.delete(oldest);
      }
      patchMapCache.set(key, { data: pmap, expires: Date.now() + PATCH_CACHE_TTL_MS });
      return pmap;
    } catch (error) {
      console.warn(`[Josei Patch Warning] ${key}: ${error.message}`);
      return null;
    } finally {
      patchMapInflight.delete(key);
    }
  })();

  patchMapInflight.set(key, job);
  return job;
}

async function applyRosyPatches(imageUrl, rawBuf, rawContentType) {
  const meta = parseRosyImageMeta(imageUrl);
  if (!meta || meta.v < SHIELD_MIN_V) return { buffer: rawBuf, contentType: rawContentType };
  const rem = meta.v % SHIELD_MOD;
  if (rem !== 79 && rem !== 83) return { buffer: rawBuf, contentType: rawContentType };

  const pmap = await getRosyPatchMap(meta.seriesId, meta.chapterNum, meta.v);
  const patches = pmap?.[meta.filename];
  if (!Array.isArray(patches) || !patches.length) {
    return { buffer: rawBuf, contentType: rawContentType };
  }

  try {
    const imgMeta = await sharp(rawBuf).metadata();
    if (!imgMeta.width || !imgMeta.height) return { buffer: rawBuf, contentType: rawContentType };
    const composites = [];
    for (const entry of patches) {
      if (!Array.isArray(entry) || entry.length < 5) continue;
      const [leftPct, topPct, widthPct, heightPct, b64] = entry;
      const left = Math.max(0, Math.round((leftPct / 100) * imgMeta.width));
      const top = Math.max(0, Math.round((topPct / 100) * imgMeta.height));
      const width = Math.max(1, Math.min(imgMeta.width - left, Math.round((widthPct / 100) * imgMeta.width)));
      const height = Math.max(1, Math.min(imgMeta.height - top, Math.round((heightPct / 100) * imgMeta.height)));
      const patchBuf = await sharp(Buffer.from(b64, "base64"))
        .resize(width, height, { fit: "fill" })
        .toBuffer();
      composites.push({ input: patchBuf, left, top });
    }
    if (!composites.length) return { buffer: rawBuf, contentType: rawContentType };
    const cleanBuf = await sharp(rawBuf).composite(composites).webp({ quality: 85 }).toBuffer();
    return { buffer: cleanBuf, contentType: "image/webp" };
  } catch (error) {
    console.warn(`[Josei Patch Composite Error] ${meta.filename}: ${error.message}`);
    return { buffer: rawBuf, contentType: rawContentType };
  }
}

function clean(value, fallback = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim() || fallback;
}

function indonesiaRelativeTime(value = "") {
  const text = clean(value);
  if (!text) return "";

  const normalized = text.toLowerCase();
  if (normalized === "just now") return "baru saja";
  if (normalized === "yesterday") return "1 hari lalu";

  const match = normalized.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (!match) return text;

  const labels = {
    second: "detik",
    minute: "menit",
    hour: "jam",
    day: "hari",
    week: "minggu",
    month: "bulan",
    year: "tahun",
  };
  return `${match[1]} ${labels[match[2]]} lalu`;
}

function headers(referer = `${BASE}/`) {
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: referer,
    "User-Agent": process.env.JOSEI_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  };
}

async function joseiFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const fetchUrl = `${PROXY_URL}${encodeURIComponent(url)}`;
  const optionsForRequest = {
    headers: headers(options.referer),
    timeout: options.timeout || 25000,
    responseType: options.responseType || "text",
    validateStatus: (status) => status >= 200 && status < 500,
  };
  const errors = [];
  for (const target of [fetchUrl, url]) {
    try {
      const response = await axios.get(target, optionsForRequest);
      if (response.status >= 200 && response.status < 300) return response.data;
      errors.push(`${target}:HTTP ${response.status}`);
    } catch (error) {
      errors.push(`${target}:${error.response?.status || error.code || error.message}`);
    }
  }
  const error = new Error(`RosyScans upstream gagal (${errors.join(" -> ")})`);
  error.status = 502;
  throw error;
}

function pathSlug(value = "", prefix = "") {
  try {
    let pathname = new URL(value, BASE).pathname.replace(/^\/+|\/+$/g, "");
    if (prefix && pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length + 1);
    return pathname;
  } catch (_) {
    return clean(value).split(/[?#]/)[0].replace(/^\/+|\/+$/g, "").replace(new RegExp(`^${prefix}/`), "");
  }
}

function dePhoton(url) {
  // iN.wp.com/<host>/<path> → https://<host>/<path>. Origin rosyscans melayani
  // file yang sama, dan menghindari rate-limit Jetpack (429 saat burst gambar).
  try {
    const parsed = new URL(url);
    if (!PHOTON_HOST_RE.test(parsed.hostname.toLowerCase())) return url;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return url;
    const origin = segments[0].toLowerCase();
    if (!IMAGE_HOSTS.has(origin)) return url;
    return `https://${origin}/${segments.slice(1).join("/")}`;
  } catch {
    return url;
  }
}

function normalizeImage(value = "") {
  const src = clean(value).replace(/&amp;/g, "&");
  if (!src || /^data:|^blob:/i.test(src)) return "";
  let absolute;
  if (src.startsWith("//")) absolute = `https:${src}`;
  else if (/^https?:\/\//i.test(src)) absolute = src.replace(/^http:/i, "https:");
  else absolute = `${BASE}/${src.replace(/^\/+/, "")}`;
  return dePhoton(absolute);
}

function baseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function proxyImage(value, req) {
  const url = normalizeImage(value);
  if (!url) return "";
  const extra = ROSY_IMG_RE.test(url) ? "&wm=1" : "";
  return `${baseUrl(req)}/josei/image?url=${encodeURIComponent(url)}${extra}`;
}

function rewriteImages(payload, req) {
  if (Array.isArray(payload)) return payload.map((value) => rewriteImages(value, req));
  if (!payload || typeof payload !== "object") return payload;
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) output[key] = value.map((image) => proxyImage(image, req)).filter(Boolean);
    else if (["image", "thumbnail", "cover", "chapter_thumbnail"].includes(key) && typeof value === "string") output[key] = proxyImage(value, req);
    else if (value && typeof value === "object") output[key] = rewriteImages(value, req);
    else output[key] = value;
  }
  return output;
}

function parsePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

function distinct(items, key) {
  const seen = new Set();
  return items.filter((item) => item[key] && !seen.has(item[key]) && seen.add(item[key]));
}

function parseChapterAnchor($, element, seriesSlug) {
  const node = $(element);
  const slug = pathSlug(node.attr("href"));
  const raw = clean(node.find(".chapternum,.epl-num,.epxs").first().text(), clean(node.text()));
  const match = raw.match(/Chapter\s*[\d.]+/i);
  const date = clean(node.find(".chapterdate,.epl-date,.epxdate").first().text());
  return {
    title: match ? match[0].replace(/Chapter\s*/i, "Chapter ") : raw,
    slug,
    link: slug ? `chapter/${seriesSlug}/${slug}` : "",
    date,
    time: date,
    locked: Boolean(node.find(".fa-coins,.fa-lock,[class*='coin'],[class*='lock']").length),
  };
}

function parseCards(html, selector = ".bs") {
  const $ = cheerio.load(html);
  const data = [];
  $(selector).each((_, element) => {
    const card = $(element);
    const anchor = card.is("a") ? card : card.find(".bsx > a,a[href*='/manga/'],a.series").first();
    const slug = pathSlug(anchor.attr("href"), "manga");
    const title = clean(card.find(".tt").first().clone().children().remove().end().text(), clean(card.find("img").attr("alt")));
    if (!slug || !title || slug === "manga") return;
    const chapters = distinct(card.find(".chapter-list a,a[href*='-chapter-']").map((__, link) => parseChapterAnchor($, link, slug)).get(), "slug");
    const latest = chapters[0] || {};
    const oldest = chapters[chapters.length - 1] || {};
    data.push({
      source: "josei",
      title,
      slug,
      image: normalizeImage(card.find("img").first().attr("data-src") || card.find("img").first().attr("src")),
      detail_link: `${BASE}/manga/${slug}/`,
      description: "",
      type_genre: card.find(".colored,.fa-palette").length ? "color" : "comic",
      info: indonesiaRelativeTime(
        clean(card.find(".status,.epxdate").first().text(), latest.time || "Updated"),
      ),
      chapter_awal: oldest.title || "",
      chapter_terbaru: latest.title || clean(card.find(".epxs").first().text()),
      chapters,
    });
  });
  return distinct(data, "slug");
}

function paginate(items, page) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  return {
    success: true,
    meta: { currentPage: page, totalPages, totalItems, hasNextPage: page < totalPages },
    data: items.slice(start, start + PAGE_SIZE),
  };
}

async function catalog() {
  if (catalogCache.data && catalogCache.expires > Date.now()) return catalogCache.data;
  if (catalogCache.pending) return catalogCache.pending;
  catalogCache.pending = (async () => {
    const items = parseCards(await joseiFetch("/project/"), ".listupd .bs");
    if (!items.length) throw new Error("Data komik Josei kosong");
    catalogCache = { data: items, expires: Date.now() + 120000, pending: null };
    return items;
  })();
  try { return await catalogCache.pending; }
  catch (error) { catalogCache.pending = null; throw error; }
}

function infoValue($, label) {
  const target = label.toLowerCase();
  let result = "";
  $(".tsinfo .imptdt").each((_, element) => {
    if (result) return;
    const raw = clean($(element).text());
    if (raw.toLowerCase().startsWith(target)) result = clean(raw.slice(label.length));
  });
  return result;
}

function parseDetail(html, slug) {
  const $ = cheerio.load(html);
  const title = clean($("h1.entry-title,.entry-title").first().text());
  if (!title) throw new Error("Struktur detail Josei tidak dikenali");
  const chapters = distinct($(".eplister li a,.clstyle li a").map((_, element) => parseChapterAnchor($, element, slug)).get(), "slug");
  const genres = $(".mgen a,a[rel='tag'][href*='/genres/']").map((_, e) => clean($(e).text())).get().filter((v, i, a) => v && a.indexOf(v) === i);
  let synopsis = clean($(".entry-content-single,.entry-content").first().text());
  synopsis = synopsis.replace(/^A brief description of the manga[^:]*:\s*/i, "");
  return { success: true, data: {
    title,
    thumbnail: normalizeImage($(".thumb img,.bigcontent img.wp-post-image").first().attr("src")),
    type: infoValue($, "Type") || "comic",
    status: infoValue($, "Status") || "Unknown",
    Pengarang: infoValue($, "Author") || "-",
    Umur: "-",
    Konsep: infoValue($, "Released") || "-",
    artist: infoValue($, "Artist") || "-",
    genres,
    synopsis: synopsis || "Tidak ada sinopsis.",
    info: infoValue($, "Views"),
    total_chapter: chapters.length,
    chapters,
  }};
}

function readerPayload($) {
  let payload = null;
  $("script").each((_, element) => {
    if (payload) return;
    const script = $(element).html() || "";
    const marker = "ts_reader.run(";
    const start = script.indexOf(marker);
    if (start < 0) return;
    const jsonStart = start + marker.length;
    const end = script.lastIndexOf(");");
    if (end <= jsonStart) return;
    try { payload = JSON.parse(script.slice(jsonStart, end)); } catch (_) {}
  });
  return payload;
}

function parseChapter(html, seriesSlug, chapterSlug) {
  const $ = cheerio.load(html);
  const payload = readerPayload($);
  const rawImages = distinct((payload?.sources?.[0]?.images || []).map((url) => ({ url: normalizeImage(url) })), "url").map((item) => item.url);
  const images = filterRosyDecoys(rawImages);
  if (!images.length) throw new Error("Gambar chapter Josei tidak ditemukan");
  const title = clean($("h1.entry-title,.entry-title").first().text(), clean($("title").text()));
  const match = title.match(/Chapter\s*[\d.]+/i);
  return {
    success: true,
    mangaId: seriesSlug,
    chapterSlug,
    currentChapter: match ? match[0].replace(/Chapter\s*/i, "Chapter ") : chapterSlug,
    prev: pathSlug(payload.prevUrl) || null,
    next: pathSlug(payload.nextUrl) || null,
    back_to_detail: seriesSlug,
    totalImages: images.length,
    images,
  };
}

async function scrapePustaka(page = 1) {
  // Halaman /project/ hanya berisi satu page katalog. Ambil page upstream
  // yang diminta secara langsung agar page 2+ tidak dipotong oleh cache page 1.
  const path = page === 1 ? "/project/" : `/project/page/${page}/`;
  const html = await joseiFetch(path);
  const items = parseCards(html, ".listupd .bs");
  const $ = cheerio.load(html);
  let totalPages = page;

  $("a.page-numbers").each((_, element) => {
    const label = Number.parseInt(clean($(element).text()), 10);
    const hrefMatch = clean($(element).attr("href")).match(/\/project\/page\/(\d+)/i);
    const hrefPage = hrefMatch ? Number.parseInt(hrefMatch[1], 10) : 0;
    totalPages = Math.max(totalPages, Number.isFinite(label) ? label : 0, hrefPage);
  });

  const hasNextPage = Boolean($("a.next.page-numbers").length) || page < totalPages;
  return {
    success: true,
    meta: {
      currentPage: page,
      totalPages,
      totalItems: totalPages > 1 ? totalPages * items.length : items.length,
      hasNextPage,
    },
    data: items,
  };
}
async function projectMetadata() {
  if (metadataCache.data && metadataCache.expires > Date.now()) return metadataCache.data;
  if (metadataCache.pending) return metadataCache.pending;
  metadataCache.pending = (async () => {
    const items = await catalog();
    const enriched = [];
    for (let offset = 0; offset < items.length; offset += 5) {
      const batch = await Promise.all(items.slice(offset, offset + 5).map(async (item) => {
        try {
          const detail = (await scrapeDetail(item.slug)).data || {};
          return {
            ...item,
            type: clean(detail.type, item.type_genre),
            type_genre: clean(detail.type, item.type_genre),
            status: clean(detail.status),
            genres: Array.isArray(detail.genres) ? detail.genres.map((value) => clean(value)).filter(Boolean) : [],
          };
        } catch (error) {
          console.warn(`[Josei Metadata] ${item.slug}: ${error.message}`);
          return { ...item, type: item.type_genre, status: "", genres: [] };
        }
      }));
      enriched.push(...batch);
    }
    metadataCache = { data: enriched, expires: Date.now() + 15 * 60 * 1000, pending: null };
    return enriched;
  })();
  try { return await metadataCache.pending; }
  catch (error) { metadataCache.pending = null; throw error; }
}

function optionList(items, placeholder) {
  const values = [...new Set(items.map((value) => clean(value)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "id", { sensitivity: "base" }));
  return [{ value: "", label: placeholder }, ...values.map((value) => ({ value, label: value }))];
}

async function scrapeFilters() {
  const items = await projectMetadata();
  const genres = items.flatMap((item) => item.genres || []);
  return {
    tipe: optionList(items.map((item) => item.type), "Tipe"),
    status: optionList(items.map((item) => item.status), "Status"),
    genre: optionList(genres, "Genre 1"),
    genre2: optionList(genres, "Genre 2"),
    orderby: [
      { value: "modified", label: "Terbaru" },
      { value: "title", label: "Judul A-Z" },
      { value: "titlereverse", label: "Judul Z-A" },
    ],
  };
}

async function scrapePustakaFilter({ page = 1, orderby = "modified", tipe = "", status = "", genre = "", genre2 = "" } = {}) {
  const equals = (left, right) => clean(left).toLowerCase() === clean(right).toLowerCase();
  let items = (await projectMetadata()).filter((item) => {
    if (tipe && !equals(item.type, tipe)) return false;
    if (status && !equals(item.status, status)) return false;
    const itemGenres = (item.genres || []).map((value) => clean(value).toLowerCase());
    if (genre && !itemGenres.includes(clean(genre).toLowerCase())) return false;
    if (genre2 && !itemGenres.includes(clean(genre2).toLowerCase())) return false;
    return true;
  });
  if (orderby === "title") items.sort((a, b) => a.title.localeCompare(b.title, "id"));
  if (orderby === "titlereverse") items.sort((a, b) => b.title.localeCompare(a.title, "id"));
  return paginate(items, page);
}

async function scrapeSearch(query, page = 1) {
  const params = new URLSearchParams({ s: query });
  if (page > 1) params.set("paged", String(page));
  const items = parseCards(await joseiFetch(`/?${params}`), ".listupd .bs");
  return { success: true, query, meta: { currentPage: page, totalPages: page, totalItems: items.length, hasNextPage: false }, data: items.map((item) => ({ title: item.title, image: item.image, detail_link: item.detail_link, type_genre: item.type_genre, update: item.chapter_terbaru, rating: "0", slug: item.slug })) };
}
async function scrapeDetail(slug) { return parseDetail(await joseiFetch(`/manga/${encodeURIComponent(slug)}/`), slug); }
async function scrapeChapter(seriesSlug, chapterSlug) {
  // RosyScans memakai URL datar: /<seri>-chapter-55/. Kode lama memakai
  // /chapter-55/ saja, jadi setiap chapter berakhir 404 setelah mereka pindah
  // domain ke rosyscans.com.
  const flat = String(chapterSlug).startsWith(seriesSlug) ? String(chapterSlug) : `${seriesSlug}-${chapterSlug}`;
  return parseChapter(await joseiFetch(`/${encodeURIComponent(flat)}/`, { referer: `${BASE}/manga/${seriesSlug}/` }), seriesSlug, chapterSlug);
}

module.exports = function registerJosei(app, { getCache, setCache, coalescedScrape, getImageCache, setImageCache }) {
  app.get("/josei/image", async (req, res) => {
    if (!req.query.url) return res.status(400).send("No URL provided");
    try {
      const imageUrl = normalizeImage(req.query.url);
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" || !isAllowedImageUrl(parsed)) return res.status(400).send("URL gambar Josei tidak valid");
      const cacheKey = ROSY_IMG_RE.test(imageUrl) ? `${imageUrl}#wm0` : imageUrl;
      const cached = getImageCache(cacheKey);
      if (cached) {
        return res.set('Content-Type', cached.contentType).set('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800').send(cached.buffer);
      }
      const needsProxy = parsed.hostname.toLowerCase().includes("joseiscans.com");
      const targetUrl = needsProxy ? `${PROXY_URL}${encodeURIComponent(imageUrl)}` : imageUrl;
      const response = await axios.get(targetUrl, { headers: headers(BASE), responseType: "arraybuffer", timeout: 25000 });
      const rawBuf = Buffer.from(response.data);
      const rawType = response.headers["content-type"] || "image/jpeg";
      const { buffer, contentType } = await applyRosyPatches(imageUrl, rawBuf, rawType);
      setImageCache(cacheKey, buffer, contentType);
      res.set("Content-Type", contentType);
      res.set("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800");
      res.send(buffer);
    } catch (error) {
      console.error(`[Josei Proxy Error] ${error.message}`);
      res.status(error.response?.status || 502).send("Gagal mengambil gambar Josei");
    }
  });

  app.get("/josei/pustaka", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const key = `josei:pustaka:${page}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapePustaka(page));
      const response = { success: true, source: "rosyscans.id", page, total: result.data.length, meta: result.meta, data: rewriteImages(result.data, req) };
      setCache(key, response, 120); res.json(response);
    } catch (error) { console.error(`[Josei Pustaka Error] ${error.message}`); res.status(502).json({ success: false, page, total: 0, data: [], message: error.message }); }
  });

  app.get("/josei/filters", async (_req, res) => {
    const key = "josei:filters", cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const response = { success: true, data: await coalescedScrape(key, scrapeFilters) };
      setCache(key, response, 900);
      res.json(response);
    } catch (error) {
      console.error(`[Josei Filters Error] ${error.message}`);
      res.status(502).json({ success: false, data: null, message: error.message });
    }
  });

  app.get("/josei/pustaka-filter", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const query = {
      page,
      orderby: clean(req.query.orderby, "modified"),
      tipe: clean(req.query.tipe),
      status: clean(req.query.status),
      genre: clean(req.query.genre),
      genre2: clean(req.query.genre2),
    };
    const key = `josei:pustaka-filter:o:${query.orderby}:t:${query.tipe}:s:${query.status}:g:${query.genre}:g2:${query.genre2}:p:${page}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapePustakaFilter(query));
      const response = { success: true, source: "rosyscans.id", page, total: result.data.length, meta: result.meta, data: rewriteImages(result.data, req) };
      setCache(key, response, 300);
      res.json(response);
    } catch (error) {
      console.error(`[Josei Pustaka Filter Error] ${error.message}`);
      res.status(502).json({ success: false, page, total: 0, data: [], message: error.message });
    }
  });

  app.get("/josei/search", async (req, res) => {
    const query = clean(req.query.q), page = parsePage(req.query.page || "1");
    if (!query) return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const key = `josei:search:${query.toLowerCase()}:${page}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try { const result = await coalescedScrape(key, () => scrapeSearch(query, page)); result.data = rewriteImages(result.data, req); setCache(key, result, 300); res.json(result); }
    catch (error) { console.error(`[Josei Search Error] ${error.message}`); res.status(502).json({ success: false, query, data: [], message: error.message }); }
  });

  app.get("/josei/detail/:slug", async (req, res) => {
    const slug = pathSlug(req.params.slug, "manga");
    if (!slug) return res.status(400).json({ success: false, message: "Slug tidak diberikan" });
    const key = `josei:detail:${slug}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try { const result = rewriteImages(await coalescedScrape(key, () => scrapeDetail(slug)), req); setCache(key, result, 900); res.json(result); }
    catch (error) { console.error(`[Josei Detail Error] ${slug}: ${error.message}`); res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message }); }
  });

  // Kompatibilitas: web mengirim SATU segmen (`seri-chapter-55`), sementara
  // route di bawah butuh dua. Tanpa ini semua chapter Josei 404.
  app.get("/josei/chapter/:slug", async (req, res) => {
    const full = pathSlug(req.params.slug);
    const cut = full.lastIndexOf("-chapter-");
    if (cut <= 0) return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap" });
    const seriesSlug = pathSlug(full.slice(0, cut), "manga");
    const chapterSlug = pathSlug(full.slice(cut + 1));
    const key = `josei:chapter:${seriesSlug}:${chapterSlug}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = rewriteImages(await coalescedScrape(key, () => scrapeChapter(seriesSlug, chapterSlug)), req);
      setCache(key, result, 7200);
      res.json(result);
    } catch (error) {
      console.error(`[Josei Chapter Error] ${seriesSlug}/${chapterSlug}: ${error.message}`);
      res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message });
    }
  });

  app.get("/josei/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const seriesSlug = pathSlug(req.params.seriesSlug, "manga"), chapterSlug = pathSlug(req.params.chapterSlug);
    if (!seriesSlug || !chapterSlug) return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap" });
    const key = `josei:chapter:${seriesSlug}:${chapterSlug}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try { const result = rewriteImages(await coalescedScrape(key, () => scrapeChapter(seriesSlug, chapterSlug)), req); setCache(key, result, 7200); res.json(result); }
    catch (error) { console.error(`[Josei Chapter Error] ${seriesSlug}/${chapterSlug}: ${error.message}`); res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message }); }
  });

  console.log("Josei routes registered: /josei/pustaka, /josei/filters, /josei/pustaka-filter, /josei/search, /josei/detail/:slug, /josei/chapter/:seriesSlug/:chapterSlug, /josei/image");
};

module.exports._test = { parseCards, parseDetail, parseChapter, parsePage, normalizeImage, indonesiaRelativeTime, scrapePustaka, scrapeFilters, scrapePustakaFilter, scrapeSearch, scrapeDetail, scrapeChapter };
