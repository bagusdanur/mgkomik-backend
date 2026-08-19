"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const cloudscraper = require("cloudscraper");

const BASE = "https://kagane.to";
const API_BASE = "https://kagane.to/api/v2";
const WORKER_PROXY =
  process.env.KAGANE_PROXY_URL ||
  "https://proxy.kopipaitboskuh.workers.dev/?url=";
const PER_PAGE = 24;

function isAllowedImageHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "kagane.to" ||
    host === "www.kagane.to" ||
    host.endsWith(".kagane.to") ||
    host === "kagane.org" ||
    host === "www.kagane.org" ||
    host.endsWith(".kagane.org") ||
    host.includes("cdn") ||
    host.includes("image")
  );
}

function headers(referer = `${BASE}/`) {
  return {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,application/json,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: referer,
    Origin: BASE,
    "User-Agent":
      process.env.KAGANE_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  };
}

async function kaganeFetch(path, options = {}) {
  const fullUrl = path.startsWith("http")
    ? path
    : `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const errors = [];

  // Strategi 1: Direct axios
  try {
    const res = await axios({
      method: options.method || "GET",
      url: fullUrl,
      data: options.data,
      headers: {
        ...headers(options.referer),
        ...(options.headers || {}),
      },
      timeout: options.timeout || 15000,
      responseType: options.responseType || "text",
      validateStatus: (status) => status >= 200 && status < 400,
    });
    return res.data;
  } catch (err) {
    errors.push(`direct:${err.response?.status || err.message}`);
  }

  // Strategi 2: Worker proxy
  if (WORKER_PROXY) {
    try {
      const proxyUrl = `${WORKER_PROXY}${encodeURIComponent(fullUrl)}`;
      const res = await axios({
        method: options.method || "GET",
        url: proxyUrl,
        data: options.data,
        headers: {
          ...headers(options.referer),
          ...(options.headers || {}),
        },
        timeout: options.timeout || 15000,
        responseType: options.responseType || "text",
        validateStatus: (status) => status >= 200 && status < 400,
      });
      return res.data;
    } catch (err) {
      errors.push(`worker:${err.response?.status || err.message}`);
    }
  }

  // Strategi 3: Cloudscraper (GET only)
  if (!options.method || options.method.toUpperCase() === "GET") {
    try {
      const csResult = await cloudscraper.get({
        uri: fullUrl,
        headers: headers(options.referer),
        timeout: options.timeout || 20000,
      });
      return csResult;
    } catch (err) {
      errors.push(`cloudscraper:${err.message}`);
    }
  }

  const error = new Error(`Kagane fetch gagal (${fullUrl}): ${errors.join(" -> ")}`);
  error.status = 502;
  throw error;
}

function text(value, fallback = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim() || fallback;
}

function cleanSlug(value = "") {
  try {
    return new URL(value, BASE).pathname
      .replace(/^\/series\//i, "")
      .replace(/^\/+|\/+$/g, "");
  } catch (_) {
    return text(value)
      .replace(/^https?:\/\/(?:www\.)?kagane\.(?:to|org)\/series\//i, "")
      .replace(/^\/series\//i, "")
      .replace(/^\/+|\/+$/g, "")
      .split(/[?#]/)[0];
  }
}

function cleanChapterSlug(value = "") {
  try {
    return new URL(value, BASE).pathname
      .replace(/^\/chapter\//i, "")
      .replace(/^\/+|\/+$/g, "");
  } catch (_) {
    return text(value)
      .replace(/^https?:\/\/(?:www\.)?kagane\.(?:to|org)\/chapter\//i, "")
      .replace(/^\/chapter\//i, "")
      .replace(/^\/+|\/+$/g, "")
      .split(/[?#]/)[0];
  }
}

function normalizeImage(value = "") {
  const src = text(value).replace(/&amp;/g, "&");
  if (!src || /^data:|^blob:/i.test(src) || src.includes("placeholder")) {
    return "";
  }
  if (/^\/\//.test(src)) return `https:${src}`;
  if (/^https?:\/\//i.test(src)) return src.replace(/^http:/i, "https:");
  return `${BASE}/${src.replace(/^\/+/, "")}`;
}

function requestBase(req) {
  const forwarded = req.headers["x-forwarded-proto"];
  const protocol = String(forwarded || req.protocol || "http").split(",")[0].trim();
  return `${protocol}://${req.get("host")}`;
}

function proxyImage(value, req) {
  const url = normalizeImage(value);
  return url
    ? `${requestBase(req)}/kagane/image?url=${encodeURIComponent(url)}`
    : "";
}

function rewriteImages(payload, req) {
  if (Array.isArray(payload)) return payload.map((item) => rewriteImages(item, req));
  if (!payload || typeof payload !== "object") return payload;
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      output[key] = value.map((image) => proxyImage(image, req)).filter(Boolean);
    } else if (
      ["image", "thumbnail", "cover", "chapter_thumbnail"].includes(key) &&
      typeof value === "string"
    ) {
      output[key] = proxyImage(value, req);
    } else if (value && typeof value === "object") {
      output[key] = rewriteImages(value, req);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function parsePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

function unique(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = item[key];
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function parsePustakaCards(rawPayload, page = 1) {
  let parsed = rawPayload;
  if (typeof rawPayload === "string") {
    try {
      parsed = JSON.parse(rawPayload);
    } catch (_) {
      parsed = null;
    }
  }

  // If JSON API response
  if (parsed && (Array.isArray(parsed.data) || Array.isArray(parsed.series) || Array.isArray(parsed.results))) {
    const items = parsed.data || parsed.series || parsed.results || [];
    const data = items.map((item) => {
      const slug = cleanSlug(item.id || item.slug);
      const title = text(item.title || item.name);
      const image = normalizeImage(item.cover || item.thumbnail || item.image);
      const latestCh = text(item.latest_chapter?.name || item.latest_chapter?.number ? `Chapter ${item.latest_chapter.number}` : "");
      return {
        source: "kagane",
        title,
        slug,
        image,
        detail_link: `${BASE}/series/${slug}`,
        description: text(item.description || item.synopsis),
        type_genre: text(item.type || item.format, "comic").toLowerCase(),
        info: text(item.status, "Updated"),
        chapter_awal: "",
        chapter_terbaru: latestCh,
        chapters: [],
      };
    }).filter((x) => x.slug && x.title);

    const totalPages = Number(parsed.total_pages || parsed.totalPages) || page;
    const totalItems = Number(parsed.total || parsed.total_items) || data.length;

    return {
      success: true,
      meta: {
        currentPage: page,
        totalPages,
        totalItems,
        hasNextPage: page < totalPages || data.length >= PER_PAGE,
      },
      data: unique(data, "slug"),
    };
  }

  // Fallback: HTML parsing
  const html = typeof rawPayload === "string" ? rawPayload : "";
  const $ = cheerio.load(html);
  const data = [];

  $("a[href*='/series/'], .series-card, .comic-card, article").each((_, el) => {
    const card = $(el);
    const anchor = card.is("a[href*='/series/']") ? card : card.find("a[href*='/series/']").first();
    const href = anchor.attr("href");
    const slug = cleanSlug(href);
    const title = text(
      anchor.attr("title"),
      text(card.find("h3, h4, .title").first().text(), text(card.find("img").attr("alt")))
    );
    if (!slug || !title) return;

    const imgTag = card.find("img").first();
    const image = normalizeImage(imgTag.attr("data-src") || imgTag.attr("src"));
    const latestCh = text(card.find(".chapter, .latest-chapter, a[href*='/chapter/']").first().text());

    data.push({
      source: "kagane",
      title,
      slug,
      image,
      detail_link: `${BASE}/series/${slug}`,
      description: text(card.find("p, .desc, .synopsis").first().text()),
      type_genre: text(card.find(".badge, .type, .format").first().text(), "comic").toLowerCase(),
      info: "Updated",
      chapter_awal: "",
      chapter_terbaru: latestCh,
      chapters: [],
    });
  });

  return {
    success: true,
    meta: {
      currentPage: page,
      totalPages: page,
      totalItems: data.length,
      hasNextPage: data.length >= PER_PAGE,
    },
    data: unique(data, "slug"),
  };
}

function parseSearchCards(rawPayload, query, page = 1) {
  const result = parsePustakaCards(rawPayload, page);
  return {
    success: true,
    query,
    meta: result.meta,
    data: result.data.map((item) => ({
      title: item.title,
      image: item.image,
      detail_link: item.detail_link,
      type_genre: item.type_genre,
      update: item.chapter_terbaru,
      rating: "0",
      slug: item.slug,
    })),
  };
}

function parseDetail(rawPayload, slug) {
  let parsed = rawPayload;
  if (typeof rawPayload === "string") {
    try {
      parsed = JSON.parse(rawPayload);
    } catch (_) {
      parsed = null;
    }
  }

  // If JSON API response
  if (parsed && (parsed.data || parsed.title || parsed.name)) {
    const s = parsed.data || parsed;
    const title = text(s.title || s.name);
    const thumbnail = normalizeImage(s.cover || s.thumbnail || s.image);
    const genres = Array.isArray(s.genres)
      ? s.genres.map((g) => text(g.name || g)).filter(Boolean)
      : [];
    const chaptersRaw = Array.isArray(s.chapters) ? s.chapters : [];
    const chapters = chaptersRaw.map((c) => {
      const chSlug = cleanChapterSlug(c.id || c.slug);
      const chNum = c.number !== undefined ? c.number : "";
      const chTitle = text(c.title || c.name || (chNum ? `Chapter ${chNum}` : "Chapter"));
      const date = text(c.created_at || c.updated_at || c.date || "");
      return {
        title: chTitle,
        slug: chSlug,
        link: `chapter/${slug}/${chSlug}`,
        date,
        time: date,
        locked: Boolean(c.locked || c.is_locked),
      };
    }).filter((c) => c.slug);

    return {
      success: true,
      data: {
        title,
        thumbnail,
        type: text(s.type || s.format, "Manhwa"),
        status: text(s.status, "Unknown"),
        Pengarang: text(s.author || s.artist, "-"),
        Umur: "-",
        Konsep: "-",
        artist: text(s.artist, "-"),
        genres,
        synopsis: text(s.description || s.synopsis, "Tidak ada sinopsis."),
        info: text(s.views ? `${s.views} Views` : ""),
        total_chapter: chapters.length,
        chapters,
      },
    };
  }

  // Fallback: HTML parsing
  const html = typeof rawPayload === "string" ? rawPayload : "";
  const $ = cheerio.load(html);
  const title = text($("h1, .series-title, .title").first().text(), $("meta[property='og:title']").attr("content"));
  if (!title) throw new Error("Struktur detail Kagane tidak dikenali");

  const thumbnail = normalizeImage($(".poster img, .cover img, img.series-cover").first().attr("src"));
  const genres = $(".genre-badge, .genre a, a[href*='genre']").map((_, e) => text($(e).text())).get().filter(Boolean);
  const synopsis = text($(".synopsis, .description, .entry-content").first().text(), "Tidak ada sinopsis.");

  const chapters = unique(
    $("a[href*='/chapter/']").map((_, el) => {
      const href = $(el).attr("href");
      const chSlug = cleanChapterSlug(href);
      const chTitle = text($(el).find(".chapter-title, .title").first().text(), text($(el).text()));
      const date = text($(el).find("time, .date").first().text());
      return {
        title: chTitle || "Chapter",
        slug: chSlug,
        link: `chapter/${slug}/${chSlug}`,
        date,
        time: date,
        locked: false,
      };
    }).get().filter((c) => c.slug),
    "slug"
  );

  return {
    success: true,
    data: {
      title,
      thumbnail,
      type: "Manhwa",
      status: text($(".status").first().text(), "Ongoing"),
      Pengarang: text($(".author").first().text(), "-"),
      Umur: "-",
      Konsep: "-",
      artist: "-",
      genres,
      synopsis,
      info: "",
      total_chapter: chapters.length,
      chapters,
    },
  };
}

function parseChapter(rawPayload, seriesSlug, chapterSlug) {
  let parsed = rawPayload;
  if (typeof rawPayload === "string") {
    try {
      parsed = JSON.parse(rawPayload);
    } catch (_) {
      parsed = null;
    }
  }

  // If JSON API response
  if (parsed && (Array.isArray(parsed.pages) || Array.isArray(parsed.images) || parsed.data)) {
    const pages = parsed.pages || parsed.images || parsed.data?.pages || parsed.data?.images || [];
    const images = pages.map((p) => {
      const url = typeof p === "string" ? p : p.url || p.image || p.src;
      return normalizeImage(url);
    }).filter(Boolean);

    if (!images.length) throw new Error("Gambar chapter Kagane tidak ditemukan");

    const currentChapter = text(parsed.title || parsed.name || parsed.data?.title, `Chapter ${parsed.number || chapterSlug}`);
    const prev = parsed.prev_chapter_id || parsed.prev_slug || parsed.data?.prev_id ? cleanChapterSlug(parsed.prev_chapter_id || parsed.prev_slug || parsed.data?.prev_id) : null;
    const next = parsed.next_chapter_id || parsed.next_slug || parsed.data?.next_id ? cleanChapterSlug(parsed.next_chapter_id || parsed.next_slug || parsed.data?.next_id) : null;

    return {
      success: true,
      mangaId: seriesSlug,
      chapterSlug,
      currentChapter,
      prev,
      next,
      back_to_detail: seriesSlug,
      totalImages: images.length,
      images,
    };
  }

  // Fallback: HTML parsing
  const html = typeof rawPayload === "string" ? rawPayload : "";
  const $ = cheerio.load(html);

  const images = unique(
    $("img")
      .map((_, el) => ({
        url: normalizeImage($(el).attr("data-src") || $(el).attr("src")),
      }))
      .get()
      .filter((i) => i.url && !/logo|avatar|placeholder|icon/i.test(i.url)),
    "url"
  ).map((i) => i.url);

  if (!images.length) throw new Error("Gambar chapter Kagane tidak ditemukan");

  const heading = text($("h1, .chapter-title, title").first().text());
  const numMatch = heading.match(/Chapter\s*[\d.]+/i);

  let prev = null;
  let next = null;

  $("a").each((_, el) => {
    const t = text($(el).text());
    const href = $(el).attr("href") || "";
    if (/Prev/i.test(t) && href.includes("/chapter/")) {
      prev = cleanChapterSlug(href);
    }
    if (/Next/i.test(t) && href.includes("/chapter/")) {
      next = cleanChapterSlug(href);
    }
  });

  return {
    success: true,
    mangaId: seriesSlug,
    chapterSlug,
    currentChapter: numMatch ? numMatch[0] : chapterSlug,
    prev,
    next,
    back_to_detail: seriesSlug,
    totalImages: images.length,
    images,
  };
}

async function scrapePustaka(page = 1, sort = "latest") {
  const sortMap = {
    latest: "updated_at",
    popular: "views",
    top_rated: "rating",
    alphabet: "title",
  };

  const payload = await kaganeFetch(`${API_BASE}/series/search`, {
    method: "POST",
    data: {
      page,
      limit: PER_PAGE,
      source_type: ["Official", "Unofficial", "Mixed"],
      order: { sort: sortMap[sort] || "updated_at" },
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  }).catch(async () => {
    return await kaganeFetch(`/browse?page=${page}&sort=${sortMap[sort] || "updated_at"}`);
  });

  const result = parsePustakaCards(payload, page);
  if (!result.data.length) throw new Error("Data komik Kagane kosong");
  return result;
}

async function scrapeSearch(query, page = 1) {
  const payload = await kaganeFetch(`${API_BASE}/series/search`, {
    method: "POST",
    data: {
      title: query,
      page,
      limit: PER_PAGE,
      source_type: ["Official", "Unofficial", "Mixed"],
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  }).catch(async () => {
    return await kaganeFetch(`/search?q=${encodeURIComponent(query)}&page=${page}`);
  });

  const result = parseSearchCards(payload, query, page);
  return result;
}

async function scrapeDetail(slug) {
  const payload = await kaganeFetch(`${API_BASE}/series/${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json" },
  }).catch(async () => {
    return await kaganeFetch(`/series/${encodeURIComponent(slug)}`);
  });

  return parseDetail(payload, slug);
}

async function scrapeChapter(seriesSlug, chapterSlug) {
  const payload = await kaganeFetch(`${API_BASE}/chapter/${encodeURIComponent(chapterSlug)}`, {
    headers: { Accept: "application/json" },
  }).catch(async () => {
    return await kaganeFetch(`/chapter/${encodeURIComponent(chapterSlug)}`);
  });

  return parseChapter(payload, seriesSlug, chapterSlug);
}

module.exports = function registerKagane(app, { getCache, setCache, coalescedScrape }) {
  app.get("/kagane/image", async (req, res) => {
    if (!req.query.url) return res.status(400).send("No URL provided");
    try {
      const imageUrl = normalizeImage(req.query.url);
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" || !isAllowedImageHost(parsed.hostname)) {
        return res.status(400).send("URL gambar Kagane tidak valid");
      }
      const response = await axios.get(imageUrl, {
        headers: headers(BASE),
        responseType: "stream",
        timeout: 25000,
      });
      res.set({
        "Content-Type": response.headers["content-type"] || "image/jpeg",
        ...(response.headers["content-length"]
          ? { "Content-Length": response.headers["content-length"] }
          : {}),
        "Cache-Control": "public, max-age=31536000",
      });
      response.data.pipe(res);
    } catch (error) {
      console.error(`[Kagane Proxy Error] ${error.message}`);
      res.status(error.response?.status || 502).send("Gagal mengambil gambar Kagane");
    }
  });

  app.get("/kagane/pustaka", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const sort = text(req.query.sort, "latest").toLowerCase();
    const key = `kagane:pustaka:${sort}:${page}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapePustaka(page, sort));
      const response = {
        success: true,
        source: "kagane.to",
        page,
        total: result.data.length,
        meta: result.meta,
        data: rewriteImages(result.data, req),
      };
      setCache(key, response, 120);
      res.json(response);
    } catch (error) {
      console.error(`[Kagane Pustaka Error] ${error.message}`);
      res.status(502).json({ success: false, page, total: 0, data: [], message: error.message });
    }
  });

  app.get("/kagane/search", async (req, res) => {
    const query = text(req.query.q);
    const page = parsePage(req.query.page || "1");
    if (!query) return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const key = `kagane:search:${query.toLowerCase()}:${page}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapeSearch(query, page));
      result.data = rewriteImages(result.data, req);
      setCache(key, result, 300);
      res.json(result);
    } catch (error) {
      console.error(`[Kagane Search Error] ${error.message}`);
      res.status(502).json({ success: false, query, data: [], message: error.message });
    }
  });

  app.get("/kagane/detail/:slug", async (req, res) => {
    const slug = cleanSlug(req.params.slug);
    if (!slug) return res.status(400).json({ success: false, message: "Slug tidak diberikan" });
    const key = `kagane:detail:${slug}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapeDetail(slug));
      const response = rewriteImages(result, req);
      setCache(key, response, 900);
      res.json(response);
    } catch (error) {
      console.error(`[Kagane Detail Error] ${slug}: ${error.message}`);
      res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message });
    }
  });

  app.get("/kagane/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const seriesSlug = cleanSlug(req.params.seriesSlug);
    const chapterSlug = cleanChapterSlug(req.params.chapterSlug);
    if (!seriesSlug || !chapterSlug) {
      return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap" });
    }
    const key = `kagane:chapter:${seriesSlug}:${chapterSlug}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = rewriteImages(
        await coalescedScrape(key, () => scrapeChapter(seriesSlug, chapterSlug)),
        req
      );
      setCache(key, result, 7200);
      res.json(result);
    } catch (error) {
      console.error(`[Kagane Chapter Error] ${seriesSlug}/${chapterSlug}: ${error.message}`);
      res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message });
    }
  });

  console.log(
    "Kagane routes registered: /kagane/pustaka, /kagane/search, /kagane/detail/:slug, /kagane/chapter/:seriesSlug/:chapterSlug, /kagane/image"
  );
};

module.exports._test = {
  parsePustakaCards,
  parseSearchCards,
  parseDetail,
  parseChapter,
  normalizeImage,
  parsePage,
  scrapePustaka,
  scrapeSearch,
  scrapeDetail,
  scrapeChapter,
  cleanSlug,
  cleanChapterSlug,
  isAllowedImageHost,
};
