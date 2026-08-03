"use strict";

const axios = require("axios");
const cheerio = require("cheerio");

const BASE = "https://en-thunderscans.com";
const IMAGE_HOSTS = new Set(["en-thunderscans.com", "www.en-thunderscans.com", "i.ibb.co"]);
const PAGE_SIZE = 24;
let catalogCache = { expires: 0, data: null, pending: null };

function clean(value, fallback = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim() || fallback;
}

function headers(referer = `${BASE}/`) {
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: referer,
    "User-Agent": process.env.THUNDER_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  };
}

async function thunderFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const response = await axios.get(url, {
    headers: headers(options.referer),
    timeout: options.timeout || 25000,
    responseType: options.responseType || "text",
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Thunder upstream HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.data;
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

function normalizeImage(value = "") {
  const src = clean(value).replace(/&amp;/g, "&");
  if (!src || /^data:|^blob:/i.test(src)) return "";
  if (src.startsWith("//")) return `https:${src}`;
  if (/^https?:\/\//i.test(src)) return src.replace(/^http:/i, "https:");
  return `${BASE}/${src.replace(/^\/+/, "")}`;
}

function baseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function proxyImage(value, req) {
  const url = normalizeImage(value);
  return url ? `${baseUrl(req)}/thunder/image?url=${encodeURIComponent(url)}` : "";
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
    const anchor = card.find(".bsx > a,a[href*='/comics/']").first();
    const slug = pathSlug(anchor.attr("href"), "comics");
    const title = clean(card.find(".tt").first().clone().children().remove().end().text(), clean(card.find("img").attr("alt")));
    if (!slug || !title || slug === "comics") return;
    const chapters = distinct(card.find(".chapter-list a,a[href*='-chapter-']").map((__, link) => parseChapterAnchor($, link, slug)).get(), "slug");
    const latest = chapters[0] || {};
    const oldest = chapters[chapters.length - 1] || {};
    data.push({
      source: "thunder",
      title,
      slug,
      image: normalizeImage(card.find("img").first().attr("data-src") || card.find("img").first().attr("src")),
      detail_link: `${BASE}/comics/${slug}/`,
      description: "",
      type_genre: card.find(".colored,.fa-palette").length ? "color" : "comic",
      info: clean(card.find(".status").first().text(), latest.time || "Updated"),
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
    const items = parseCards(await thunderFetch("/"), ".latest-updates .bs");
    if (!items.length) throw new Error("Data komik Thunder kosong");
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
  if (!title) throw new Error("Struktur detail Thunder tidak dikenali");
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
  const images = distinct((payload?.sources?.[0]?.images || []).map((url) => ({ url: normalizeImage(url) })), "url").map((item) => item.url);
  if (!images.length) throw new Error("Gambar chapter Thunder tidak ditemukan");
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

async function scrapePustaka(page = 1) { return paginate(await catalog(), page); }
async function scrapeSearch(query, page = 1) {
  const params = new URLSearchParams({ s: query });
  if (page > 1) params.set("paged", String(page));
  const items = parseCards(await thunderFetch(`/?${params}`));
  return { success: true, query, meta: { currentPage: page, totalPages: page, totalItems: items.length, hasNextPage: false }, data: items.map((item) => ({ title: item.title, image: item.image, detail_link: item.detail_link, type_genre: item.type_genre, update: item.chapter_terbaru, rating: "0", slug: item.slug })) };
}
async function scrapeDetail(slug) { return parseDetail(await thunderFetch(`/comics/${encodeURIComponent(slug)}/`), slug); }
async function scrapeChapter(seriesSlug, chapterSlug) { return parseChapter(await thunderFetch(`/${encodeURIComponent(chapterSlug)}/`, { referer: `${BASE}/comics/${seriesSlug}/` }), seriesSlug, chapterSlug); }

module.exports = function registerThunder(app, { getCache, setCache, coalescedScrape }) {
  app.get("/thunder/image", async (req, res) => {
    if (!req.query.url) return res.status(400).send("No URL provided");
    try {
      const imageUrl = normalizeImage(req.query.url);
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" || !IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) return res.status(400).send("URL gambar Thunder tidak valid");
      const response = await axios.get(imageUrl, { headers: headers(BASE), responseType: "stream", timeout: 25000 });
      res.set({ "Content-Type": response.headers["content-type"] || "image/jpeg", ...(response.headers["content-length"] ? { "Content-Length": response.headers["content-length"] } : {}), "Cache-Control": "public, max-age=31536000" });
      response.data.pipe(res);
    } catch (error) {
      console.error(`[Thunder Proxy Error] ${error.message}`);
      res.status(error.response?.status || 502).send("Gagal mengambil gambar Thunder");
    }
  });

  app.get("/thunder/pustaka", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const key = `thunder:pustaka:${page}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapePustaka(page));
      const response = { success: true, source: "en-thunderscans.com", page, total: result.data.length, meta: result.meta, data: rewriteImages(result.data, req) };
      setCache(key, response, 120); res.json(response);
    } catch (error) { console.error(`[Thunder Pustaka Error] ${error.message}`); res.status(502).json({ success: false, page, total: 0, data: [], message: error.message }); }
  });

  app.get("/thunder/search", async (req, res) => {
    const query = clean(req.query.q), page = parsePage(req.query.page || "1");
    if (!query) return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const key = `thunder:search:${query.toLowerCase()}:${page}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try { const result = await coalescedScrape(key, () => scrapeSearch(query, page)); result.data = rewriteImages(result.data, req); setCache(key, result, 300); res.json(result); }
    catch (error) { console.error(`[Thunder Search Error] ${error.message}`); res.status(502).json({ success: false, query, data: [], message: error.message }); }
  });

  app.get("/thunder/detail/:slug", async (req, res) => {
    const slug = pathSlug(req.params.slug, "comics");
    if (!slug) return res.status(400).json({ success: false, message: "Slug tidak diberikan" });
    const key = `thunder:detail:${slug}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try { const result = rewriteImages(await coalescedScrape(key, () => scrapeDetail(slug)), req); setCache(key, result, 900); res.json(result); }
    catch (error) { console.error(`[Thunder Detail Error] ${slug}: ${error.message}`); res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message }); }
  });

  app.get("/thunder/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const seriesSlug = pathSlug(req.params.seriesSlug, "comics"), chapterSlug = pathSlug(req.params.chapterSlug);
    if (!seriesSlug || !chapterSlug) return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap" });
    const key = `thunder:chapter:${seriesSlug}:${chapterSlug}`, cached = getCache(key);
    if (cached) return res.json(cached);
    try { const result = rewriteImages(await coalescedScrape(key, () => scrapeChapter(seriesSlug, chapterSlug)), req); setCache(key, result, 7200); res.json(result); }
    catch (error) { console.error(`[Thunder Chapter Error] ${seriesSlug}/${chapterSlug}: ${error.message}`); res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message }); }
  });

  console.log("Thunder routes registered: /thunder/pustaka, /thunder/search, /thunder/detail/:slug, /thunder/chapter/:seriesSlug/:chapterSlug, /thunder/image");
};

module.exports._test = { parseCards, parseDetail, parseChapter, parsePage, normalizeImage, scrapePustaka, scrapeSearch, scrapeDetail, scrapeChapter };
