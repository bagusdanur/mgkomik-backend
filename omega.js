"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const OMEGA_SITE_BASE = "https://omegascans.org";
const OMEGA_API_BASE = "https://api.omegascans.org";
const OMEGA_IMAGE_HOSTS = new Set([
  "omegascans.org",
  "www.omegascans.org",
  "api.omegascans.org",
  "media.omegascans.org",
]);
const PER_PAGE = 20;
const omegaDnsCache = new Map();

function omegaHeaders(referer = `${OMEGA_SITE_BASE}/`) {
  return {
    Accept: "application/json, text/plain, */*",
    Origin: OMEGA_SITE_BASE,
    Referer: referer,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  };
}

async function omegaFetch(endpoint, options = {}) {
  const base = options.site ? OMEGA_SITE_BASE : OMEGA_API_BASE;
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${base}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await axios.get(url, {
        headers: omegaHeaders(options.referer),
        timeout: options.timeout || 20000,
        responseType: options.responseType || "json",
        httpsAgent: omegaPublicDnsAgent,
        validateStatus: (status) => status >= 200 && status < 300,
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (error.response && error.response.status < 500) break;
      omegaPublicDnsAgent.destroy();
    }
  }
  throw lastError;
}

async function resolveOmegaPublicDns(hostname) {
  const cached = omegaDnsCache.get(hostname);
  if (cached?.expiresAt > Date.now() && cached.addresses.length) {
    return cached.addresses;
  }
  const { data } = await axios.get("https://dns.google/resolve", {
    params: { name: hostname, type: "A" },
    headers: { Accept: "application/dns-json" },
    timeout: 10000,
  });
  const addresses = (data?.Answer || [])
    .filter(
      (answer) =>
        answer.type === 1 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(answer.data)
    )
    .map((answer) => answer.data);
  if (!addresses.length) {
    throw new Error(`DNS publik Omega tidak menghasilkan IPv4 untuk ${hostname}`);
  }
  omegaDnsCache.set(hostname, {
    addresses,
    expiresAt: Date.now() + 5 * 60 * 1000,
    cursor: 0,
  });
  return addresses;
}

const omegaPublicDnsAgent = new https.Agent({
  keepAlive: true,
  lookup(hostname, options, callback) {
    if (!OMEGA_IMAGE_HOSTS.has(hostname)) {
      return require("dns").lookup(hostname, options, callback);
    }
    resolveOmegaPublicDns(hostname)
      .then((addresses) => {
        const cached = omegaDnsCache.get(hostname);
        const cursor = cached?.cursor || 0;
        if (cached) cached.cursor = cursor + 1;
        const address = addresses[cursor % addresses.length];
        if (options?.all) return callback(null, [{ address, family: 4 }]);
        callback(null, address, 4);
      })
      .catch((error) => callback(error));
  },
});

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).replace(/\s+/g, " ").trim() || fallback;
}

function cleanSlug(value = "") {
  return String(value)
    .trim()
    .replace(/^https?:\/\/(?:www\.)?omegascans\.org\/series\//i, "")
    .replace(/^\/+|\/+$/g, "")
    .split(/[?#]/)[0];
}

function numericPrice(item = {}) {
  const value = item.price ?? item.chapter_price ?? item.coin_price ?? 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLocked(item = {}) {
  return Boolean(
    item.is_locked ||
      item.locked ||
      item.is_premium ||
      item.premium ||
      numericPrice(item) > 0
  );
}

function timeAgo(value) {
  if (!value) return "baru saja";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return cleanText(value, "baru saja");
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "baru saja";
  const units = [
    [31536000, "tahun"],
    [2592000, "bulan"],
    [604800, "minggu"],
    [86400, "hari"],
    [3600, "jam"],
    [60, "menit"],
  ];
  for (const [size, label] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)} ${label} lalu`;
  }
  return "baru saja";
}

function normalizeOmegaImageUrl(value) {
  const src = cleanText(value);
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return "";
  if (/^https?:\/\//i.test(src)) return src;
  return `${OMEGA_API_BASE}/${src.replace(/^\/+/, "")}`;
}

function getRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function toOmegaBackendImageUrl(value, req) {
  const url = normalizeOmegaImageUrl(value);
  if (!url) return "";
  return `${getRequestBaseUrl(req)}/omega/image?url=${encodeURIComponent(url)}`;
}

function rewriteOmegaImages(payload, req) {
  if (Array.isArray(payload)) {
    return payload.map((item) => rewriteOmegaImages(item, req));
  }
  if (!payload || typeof payload !== "object") return payload;
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      output[key] = value
        .map((image) =>
          typeof image === "string" ? toOmegaBackendImageUrl(image, req) : image
        )
        .filter(Boolean);
    } else if (
      ["image", "thumbnail", "cover", "chapter_thumbnail"].includes(key) &&
      typeof value === "string"
    ) {
      output[key] = toOmegaBackendImageUrl(value, req);
    } else if (value && typeof value === "object") {
      output[key] = rewriteOmegaImages(value, req);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function arrayFrom(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.data,
    payload?.data?.data,
    payload?.series,
    payload?.series?.data,
    payload?.results,
    payload?.comics,
    payload?.comics?.data,
  ];
  return candidates.find(Array.isArray) || [];
}

function metaFrom(payload, page, count) {
  const meta =
    payload?.meta ||
    payload?.data?.meta ||
    payload?.pagination ||
    payload?.data?.pagination ||
    {};
  const currentPage = Number(
    meta.current_page ?? meta.currentPage ?? payload?.current_page ?? page
  );
  const totalPages = Number(
    meta.last_page ??
      meta.total_pages ??
      meta.totalPages ??
      payload?.last_page ??
      currentPage
  );
  const knownTotal = meta.total ?? meta.totalItems ?? payload?.total;
  return {
    currentPage: Number.isFinite(currentPage) && currentPage > 0 ? currentPage : page,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : page,
    ...(Number.isFinite(Number(knownTotal))
      ? { totalItems: Number(knownTotal) }
      : { hasNextPage: count >= PER_PAGE }),
  };
}

function chapterFrom(item, seriesSlug) {
  const slug = cleanText(
    item.chapter_slug ?? item.slug ?? item.url_slug ?? item.chapterSlug
  );
  const number = item.chapter_number ?? item.number;
  const title = cleanText(
    item.chapter_name ?? item.title ?? item.name,
    number !== undefined ? `Chapter ${number}` : "Chapter"
  );
  return {
    title,
    slug,
    link: slug ? `chapter/${seriesSlug}/${slug}` : "",
    date: timeAgo(
      item.published_at ?? item.release_date ?? item.created_at ?? item.updated_at
    ),
    time: timeAgo(
      item.published_at ?? item.release_date ?? item.created_at ?? item.updated_at
    ),
    locked: isLocked(item),
  };
}

function seriesFrom(item) {
  return item?.series || item?.comic || item?.manga || item || {};
}

function seriesSlugFrom(item) {
  const series = seriesFrom(item);
  return cleanSlug(
    series.slug ?? series.series_slug ?? item.series_slug ?? series.url ?? ""
  ).split("/")[0];
}

function listItemFrom(item) {
  const series = seriesFrom(item);
  const slug = seriesSlugFrom(item);
  if (!slug) return null;
  const rawChapters =
    series.latest_chapters ||
    item.latest_chapters ||
    (series.free_chapters || item.free_chapters || series.paid_chapters || item.paid_chapters
      ? [
          ...(series.paid_chapters || item.paid_chapters || []).map((chapter) => ({
            ...chapter,
            locked: true,
          })),
          ...(series.free_chapters || item.free_chapters || []),
        ]
      : series.chapters || item.chapters) ||
    [];
  const chapters = (Array.isArray(rawChapters) ? rawChapters : [])
    .map((chapter) => chapterFrom(chapter, slug))
    .filter((chapter) => chapter.slug);
  const latest = chapters[0] || {};
  const oldest = chapters[chapters.length - 1] || {};
  return {
    source: "omega",
    title: cleanText(series.title ?? series.name),
    slug,
    image: normalizeOmegaImageUrl(
      series.thumbnail ??
        series.cover ??
        series.image ??
        series.poster ??
        series.cover_url
    ),
    detail_link: `${OMEGA_SITE_BASE}/series/${slug}`,
    description: cleanText(series.description ?? series.synopsis),
    type_genre: cleanText(series.type ?? series.series_type, "comic"),
    info: timeAgo(
      series.last_chapter_at ?? series.updated_at ?? item.updated_at
    ),
    chapter_awal: oldest.title || "",
    chapter_terbaru: latest.title || "",
    chapters,
  };
}

async function fetchSeriesCollection({ page, sort, query }) {
  const sortMap = {
    latest: ["updated_at", "desc"],
    alphabet: ["title", "asc"],
    rating: ["rating", "desc"],
    trending: ["total_views", "desc"],
  };
  const [orderBy, order] = sortMap[sort] || sortMap.latest;
  const params = new URLSearchParams({
    page: String(page),
    perPage: String(PER_PAGE),
    series_type: "Comic",
    query_string: query || "",
    orderBy,
    order,
    adult: "true",
    status: "All",
    tags_ids: "[]",
  });

  const candidates = [
    `/query?${params}`,
  ];
  let lastError;
  for (const endpoint of candidates) {
    try {
      const payload = await omegaFetch(endpoint);
      const data = arrayFrom(payload);
      if (data.length || page === 1) return { payload, data };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Respons daftar Omega tidak valid");
}

async function scrapeOmegaPustaka({ page = 1, sort = "latest" } = {}) {
  const allowedSorts = new Set(["latest", "alphabet", "rating", "trending"]);
  const normalizedSort = allowedSorts.has(sort) ? sort : "latest";
  const { payload, data } = await fetchSeriesCollection({
    page,
    sort: normalizedSort,
  });
  const results = data.map(listItemFrom).filter(Boolean);
  if (!results.length) throw new Error("Data komik Omega kosong");
  return { success: true, meta: metaFrom(payload, page, results.length), data: results };
}

function extractNextData(html) {
  const $ = cheerio.load(html);
  const direct = $("#__NEXT_DATA__").text();
  if (direct) {
    try {
      return JSON.parse(direct);
    } catch (_) {
      // Continue to the streamed Next.js payload.
    }
  }
  const scripts = $("script")
    .map((_, element) => $(element).html() || "")
    .get()
    .join("\n");
  const idMatch = scripts.match(/["\\]series_id["\\]\s*:\s*(\d+)/);
  return { raw: scripts, series_id: idMatch ? Number(idMatch[1]) : null };
}

function findSeriesObject(value, slug, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value)) {
    const candidateSlug = cleanText(value.slug ?? value.series_slug);
    if (
      (candidateSlug === slug || value.series_id || value.id) &&
      (value.title || value.name) &&
      (value.description || value.synopsis || value.status || value.thumbnail || value.cover)
    ) {
      return value;
    }
  }
  for (const child of Object.values(value)) {
    const found = findSeriesObject(child, slug, seen);
    if (found) return found;
  }
  return null;
}

async function fetchOmegaDetailPage(slug) {
  const html = await omegaFetch(`/series/${slug}`, {
    site: true,
    responseType: "text",
    referer: `${OMEGA_SITE_BASE}/comics`,
  });
  const $ = cheerio.load(html);
  const nextData = extractNextData(html);
  const embedded = findSeriesObject(nextData, slug) || {};
  const raw = nextData.raw || html;
  const seriesId =
    embedded.series_id ||
    embedded.id ||
    nextData.series_id ||
    Number(raw.match(/["\\]series_id["\\]\s*:\s*(\d+)/)?.[1]) ||
    null;
  return {
    html,
    $,
    embedded,
    seriesId,
  };
}

async function fetchOmegaChapters(slug, seriesId) {
  const endpoints = seriesId
    ? [
        `/chapter/query?page=1&perPage=1000&series_id=${seriesId}`,
        `/chapter/all/${slug}`,
      ]
    : [`/chapter/all/${slug}`];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const payload = await omegaFetch(endpoint, {
        referer: `${OMEGA_SITE_BASE}/series/${slug}`,
      });
      const chapters = arrayFrom(payload);
      if (chapters.length || Array.isArray(payload)) return chapters;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Daftar chapter Omega tidak tersedia");
}

async function scrapeOmegaDetail(slug) {
  const cleanSeriesSlug = cleanSlug(slug).split("/")[0];
  const page = await fetchOmegaDetailPage(cleanSeriesSlug);
  const series = page.embedded || {};
  const chaptersRaw = await fetchOmegaChapters(cleanSeriesSlug, page.seriesId);
  const chapterMap = new Map();
  for (const raw of chaptersRaw) {
    const chapter = chapterFrom(raw, cleanSeriesSlug);
    if (chapter.slug && !chapterMap.has(chapter.slug)) chapterMap.set(chapter.slug, chapter);
  }
  const chapters = [...chapterMap.values()];
  const metaDescription =
    page.$("meta[name='description']").attr("content") || "Tidak ada sinopsis.";
  const title =
    cleanText(series.title ?? series.name) ||
    cleanText(page.$("section h1").first().text()) ||
    cleanText(page.$("h1").first().text());
  const image =
    series.thumbnail ??
    series.cover ??
    series.image ??
    page.$("section img").first().attr("src") ??
    "";
  const genresValue = series.genres || series.genre || [];
  const genres = Array.isArray(genresValue)
    ? genresValue.map((genre) => cleanText(genre.name ?? genre)).filter(Boolean)
    : cleanText(genresValue)
        .split(",")
        .map((genre) => genre.trim())
        .filter(Boolean);
  return {
    success: true,
    data: {
      title,
      thumbnail: normalizeOmegaImageUrl(image),
      type: cleanText(series.type ?? series.series_type, "comic"),
      status: cleanText(series.status, "Unknown"),
      Pengarang: cleanText(series.author?.name ?? series.author, "-"),
      Umur: cleanText(series.age_rating ?? series.rating_age, "18+"),
      Konsep: cleanText(series.release_year ?? series.year, "-"),
      artist: cleanText(series.artist?.name ?? series.artist, "-"),
      genres,
      synopsis: cleanText(series.description ?? series.synopsis, metaDescription),
      info: "",
      total_chapter: chapters.length,
      chapters,
    },
  };
}

function uniqueStrings(values) {
  return [...new Set(values.map(normalizeOmegaImageUrl).filter(Boolean))];
}

async function scrapeOmegaChapter(seriesSlug, chapterSlug) {
  const cleanSeriesSlug = cleanSlug(seriesSlug).split("/")[0];
  const cleanChapterSlug = cleanSlug(chapterSlug).split("/").pop();
  const response = await omegaFetch(
    `/chapter/${encodeURIComponent(cleanSeriesSlug)}/${encodeURIComponent(cleanChapterSlug)}`,
    { referer: `${OMEGA_SITE_BASE}/series/${cleanSeriesSlug}/${cleanChapterSlug}` }
  );
  const chapter = response?.chapter || response?.data?.chapter || response?.data || {};
  if (isLocked(chapter) || response?.locked || response?.is_locked) {
    return {
      success: false,
      locked: true,
      message: "Chapter premium Omega tidak dapat diakses tanpa pembelian.",
    };
  }
  const chapterData = chapter.chapter_data || chapter.data || {};
  const images = uniqueStrings(
    chapterData.images || chapter.images || response?.images || []
  );
  if (!images.length) {
    throw new Error("Gambar chapter Omega tidak ditemukan atau chapter terkunci");
  }
  const previous = response?.previous_chapter || response?.prev_chapter;
  const next = response?.next_chapter;
  return {
    success: true,
    mangaId: cleanSeriesSlug,
    chapterSlug: cleanChapterSlug,
    currentChapter: cleanText(
      chapter.chapter_name ?? chapter.title,
      cleanChapterSlug.replace(/-/g, " ")
    ),
    prev: cleanText(previous?.chapter_slug ?? previous?.slug, null),
    next: cleanText(next?.chapter_slug ?? next?.slug, null),
    back_to_detail: cleanSeriesSlug,
    totalImages: images.length,
    images,
  };
}

async function scrapeOmegaSearch(query, page = 1) {
  const { payload, data } = await fetchSeriesCollection({
    page,
    sort: "latest",
    query,
  });
  const results = data
    .map(listItemFrom)
    .filter(Boolean)
    .map((item) => ({
      title: item.title,
      image: item.image,
      detail_link: item.detail_link,
      type_genre: item.type_genre,
      update: item.chapter_terbaru,
      rating: cleanText(
        seriesFrom(data.find((raw) => seriesSlugFrom(raw) === item.slug))?.rating,
        "0"
      ),
      slug: item.slug,
    }));
  return {
    success: true,
    query,
    meta: metaFrom(payload, page, results.length),
    data: results,
  };
}

function parsePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

module.exports = function registerOmegaRoutes(
  app,
  { getCache, setCache, coalescedScrape, getImageCache, setImageCache }
) {
  app.get("/omega/image", async (req, res) => {
    if (!req.query.url) return res.status(400).send("No URL provided");
    try {
      const imageUrl = normalizeOmegaImageUrl(decodeURIComponent(req.query.url));
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" || !OMEGA_IMAGE_HOSTS.has(parsed.hostname)) {
        return res.status(400).send("URL gambar Omega tidak valid");
      }
      const cached = getImageCache(imageUrl);
      if (cached) {
        return res.set("Content-Type", cached.contentType).set("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800").send(cached.buffer);
      }
      const response = await axios.get(imageUrl, {
        headers: omegaHeaders(`${OMEGA_SITE_BASE}/`),
        responseType: "stream",
        timeout: 20000,
        httpsAgent: omegaPublicDnsAgent,
      });
      const chunks = [];
      response.data.on("data", (c) => chunks.push(c));
      response.data.on("end", () => {
        const buf = Buffer.concat(chunks);
        setImageCache(imageUrl, buf, response.headers["content-type"] || "image/jpeg");
        res.set("Content-Type", response.headers["content-type"] || "image/jpeg");
        res.set("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800");
        res.send(buf);
      });
    } catch (error) {
      console.error(`[Omega Proxy Error] ${error.message}`);
      res.status(error.response?.status || 502).send("Gagal mengambil gambar Omega");
    }
  });

  app.get("/omega/pustaka", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const sort = cleanText(req.query.sort, "latest").toLowerCase();
    const cacheKey = `omega:pustaka:s:${sort}:p:${page}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(cacheKey, () =>
        scrapeOmegaPustaka({ page, sort })
      );
      const response = {
        success: true,
        source: "omegascans.org",
        page,
        total: result.data.length,
        meta: result.meta,
        data: rewriteOmegaImages(result.data, req),
      };
      setCache(cacheKey, response, 120);
      res.json(response);
    } catch (error) {
      console.error(`[Omega Pustaka Error] ${error.message}`);
      res.status(502).json({
        success: false,
        page,
        total: 0,
        data: [],
        message: "Sumber Omega Scans tidak dapat diakses",
      });
    }
  });

  app.get("/omega/detail/:slug", async (req, res) => {
    const slug = cleanSlug(req.params.slug).split("/")[0];
    if (!slug) return res.status(400).json({ success: false, message: "Slug tidak diberikan!" });
    const cacheKey = `omega:detail:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeOmegaDetail(slug);
        scraped.data = rewriteOmegaImages(scraped.data, req);
        return scraped;
      });
      if (result.success) setCache(cacheKey, result, 900);
      res.status(result.success ? 200 : 502).json(result);
    } catch (error) {
      console.error(`[Omega Detail Error] ${error.message}`);
      res.status(502).json({ success: false, message: "Gagal mengambil detail Omega" });
    }
  });

  app.get("/omega/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const seriesSlug = cleanSlug(req.params.seriesSlug).split("/")[0];
    const chapterSlug = cleanSlug(req.params.chapterSlug).split("/").pop();
    if (!seriesSlug || !chapterSlug) {
      return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap!" });
    }
    const cacheKey = `omega:chapter:${seriesSlug}:${chapterSlug}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeOmegaChapter(seriesSlug, chapterSlug);
        return scraped.success ? rewriteOmegaImages(scraped, req) : scraped;
      });
      if (result.success) setCache(cacheKey, result, 7200);
      res.status(result.success ? 200 : result.locked ? 403 : 502).json(result);
    } catch (error) {
      console.error(`[Omega Chapter Error] ${error.message}`);
      res.status(502).json({ success: false, message: error.message });
    }
  });

  app.get("/omega/search", async (req, res) => {
    const query = cleanText(req.query.q);
    if (!query) {
      return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    }
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const cacheKey = `omega:search:${query.toLowerCase()}:p:${page}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(cacheKey, () =>
        scrapeOmegaSearch(query, page)
      );
      result.data = rewriteOmegaImages(result.data, req);
      setCache(cacheKey, result, 300);
      res.json(result);
    } catch (error) {
      console.error(`[Omega Search Error] ${error.message}`);
      res.status(502).json({
        success: false,
        query,
        meta: { currentPage: page, totalPages: page },
        data: [],
        message: "Gagal mencari komik Omega",
      });
    }
  });

  console.log(
    "✅ Omega routes registered: /omega/image, /omega/pustaka, " +
      "/omega/detail/:slug, /omega/chapter/:seriesSlug/:chapterSlug, /omega/search"
  );
};

module.exports._test = {
  normalizeOmegaImageUrl,
  rewriteOmegaImages,
  isLocked,
  chapterFrom,
  listItemFrom,
  metaFrom,
  parsePage,
};
