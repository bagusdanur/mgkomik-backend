"use strict";

const axios = require("axios");
const cheerio = require("cheerio");

const SIREN_SITE_BASE = "https://sirenscans.com";
const SIREN_CDN_BASE = "https://cdn.meowing.org/uploads";
const SIREN_ARCHIVE_BASE = "https://web.archive.org/web/2id_/";
const SIREN_PAGE_SIZE = 24;
let sirenCatalogCache = { expiresAt: 0, data: null, pending: null };
const SIREN_IMAGE_HOSTS = new Set([
  "sirenscans.com",
  "cdn.meowing.org",
  "wsrv.nl",
]);

function sirenHeaders(referer = `${SIREN_SITE_BASE}/`) {
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: referer,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  };
  if (process.env.SIREN_COOKIE) headers.Cookie = process.env.SIREN_COOKIE;
  return headers;
}

function isCloudflareChallenge(value = "") {
  return /Just a moment|cf-mitigated|challenge-platform|Performing security verification|Enable JavaScript and cookies/i.test(
    String(value)
  );
}

async function sirenFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${SIREN_SITE_BASE}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const response = await axios.get(url, {
    headers: sirenHeaders(options.referer),
    timeout: options.timeout || 25000,
    responseType: options.responseType || "text",
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (
    (response.status === 403 && isCloudflareChallenge(response.data)) ||
    isCloudflareChallenge(response.data)
  ) {
    if (process.env.SIREN_ARCHIVE_FALLBACK !== "false") {
      const archiveUrl = `${SIREN_ARCHIVE_BASE}${url}`;
      const proxyBase = cleanText(
        process.env.SIREN_ARCHIVE_PROXY_URL ||
          "https://ryukomik-siren-archive.kopipaitboskuh.workers.dev/"
      );
      const fetchUrl = proxyBase
        ? `${proxyBase}${proxyBase.includes("?") ? "&" : "?"}url=${encodeURIComponent(url)}`
        : archiveUrl;
      const archived = await axios.get(fetchUrl, {
        headers: sirenHeaders(SIREN_SITE_BASE),
        timeout: options.timeout || 30000,
        responseType: options.responseType || "text",
        maxRedirects: 8,
        validateStatus: (status) => status >= 200 && status < 500,
      });
      if (
        archived.status >= 200 &&
        archived.status < 300 &&
        !isCloudflareChallenge(archived.data)
      ) {
        return archived.data;
      }
      const archiveError = new Error(
        `Snapshot Siren tidak tersedia (HTTP ${archived.status})`
      );
      archiveError.status = archived.status;
      archiveError.archiveMissing = archived.status === 404;
      throw archiveError;
    }
    throw new Error(
      "Siren Scans dilindungi Cloudflare; isi SIREN_COOKIE dengan clearance yang sah"
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Siren upstream HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.data;
}

function paginateSirenResult(result, page) {
  const all = result.data;
  const totalItems = all.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / SIREN_PAGE_SIZE));
  const start = (page - 1) * SIREN_PAGE_SIZE;
  result.data = all.slice(start, start + SIREN_PAGE_SIZE);
  result.meta = {
    currentPage: page,
    totalPages,
    totalItems,
    hasNextPage: page < totalPages,
    archivedFallback: true,
  };
  return result;
}

async function getSirenCatalogItems() {
  if (sirenCatalogCache.data && sirenCatalogCache.expiresAt > Date.now()) {
    return sirenCatalogCache.data;
  }
  if (sirenCatalogCache.pending) return sirenCatalogCache.pending;
  sirenCatalogCache.pending = (async () => {
    const html = await sirenFetch("/latest/");
    const items = parseSirenListHtml(html).data;
    if (!items.length) throw new Error("Data komik Siren kosong");
    sirenCatalogCache = {
      expiresAt: Date.now() + 120000,
      data: items,
      pending: null,
    };
    return items;
  })();
  try {
    return await sirenCatalogCache.pending;
  } catch (error) {
    sirenCatalogCache.pending = null;
    throw error;
  }
}

function catalogItemAsDetail(item) {
  return {
    success: true,
    partial: true,
    message: "Metadata detail berasal dari katalog karena snapshot halaman detail belum tersedia.",
    data: {
      title: item.title,
      thumbnail: item.image,
      type: item.type_genre || "comic",
      status: item.info || "Unknown",
      Pengarang: "-",
      Umur: "-",
      Konsep: "-",
      artist: "-",
      genres: [],
      synopsis: item.description || "Sinopsis belum tersedia pada snapshot katalog.",
      info: item.info || "",
      total_chapter: item.chapters.length,
      chapters: item.chapters,
    },
  };
}

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).replace(/\s+/g, " ").trim() || fallback;
}

function cleanPath(value = "") {
  try {
    const url = new URL(String(value), SIREN_SITE_BASE);
    return url.pathname.replace(/^\/+|\/+$/g, "");
  } catch (_) {
    return String(value).split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  }
}

function seriesSlugFromHref(value = "") {
  return cleanPath(value).replace(/^series\//i, "").replace(/\/+$/g, "");
}

function chapterSlugFromHref(value = "") {
  return cleanPath(value).replace(/^chapter\//i, "").replace(/\/+$/g, "");
}

function timeAgo(value) {
  const text = cleanText(value, "baru saja");
  if (/ago$/i.test(text) || /^baru saja$/i.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
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

function styleImageUrl(style = "") {
  const match = String(style).match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
  return match ? match[2].replace(/&amp;/g, "&") : "";
}

function normalizeSirenImageUrl(value) {
  const src = cleanText(value);
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return "";
  if (/^https?:\/\//i.test(src)) return src;
  return `${SIREN_SITE_BASE}/${src.replace(/^\/+/, "")}`;
}

function getRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function toSirenBackendImageUrl(value, req) {
  const url = normalizeSirenImageUrl(value);
  if (!url) return "";
  return `${getRequestBaseUrl(req)}/siren/image?url=${encodeURIComponent(url)}`;
}

function rewriteSirenImages(payload, req) {
  if (Array.isArray(payload)) return payload.map((item) => rewriteSirenImages(item, req));
  if (!payload || typeof payload !== "object") return payload;
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      output[key] = value
        .map((image) =>
          typeof image === "string" ? toSirenBackendImageUrl(image, req) : image
        )
        .filter(Boolean);
    } else if (
      ["image", "thumbnail", "cover", "chapter_thumbnail"].includes(key) &&
      typeof value === "string"
    ) {
      output[key] = toSirenBackendImageUrl(value, req);
    } else if (value && typeof value === "object") {
      output[key] = rewriteSirenImages(value, req);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function isLockedChapter($, element) {
  const node = $(element);
  const images = node
    .find("img")
    .map((_, image) => $(image).attr("src") || "")
    .get()
    .join(" ");
  return /lock|coin\.svg/i.test(images) || node.is("#paid-chapter") || node.find("#paid-chapter").length > 0;
}

function parseChapterAnchor($, element, seriesSlug) {
  const node = $(element);
  const href = node.attr("href") || "";
  const slug = chapterSlugFromHref(href);
  const title = cleanText(node.attr("title"), cleanText(node.find("[title]").first().attr("title")));
  const date = cleanText(node.attr("d"), cleanText(node.find("time").first().text(), "baru saja"));
  return {
    title: title || cleanText(node.text()).replace(/\s+(?:\d+\s+)?(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago.*$/i, ""),
    slug,
    link: slug ? `chapter/${seriesSlug}/${slug}` : "",
    date,
    time: timeAgo(date),
    locked: isLockedChapter($, element),
  };
}

function uniqueChapters(chapters) {
  const seen = new Set();
  return chapters.filter((chapter) => {
    if (!chapter.slug || seen.has(chapter.slug)) return false;
    seen.add(chapter.slug);
    return true;
  });
}

function typeAndStatusFromCard($, card) {
  const tags = $(card)
    .find("span")
    .map((_, element) => cleanText($(element).text()).toLowerCase())
    .get();
  const type = tags.find((tag) => ["manga", "manhwa", "manhua", "comic", "mangatoon"].includes(tag));
  const status = tags.find((tag) => ["ongoing", "completed", "hiatus", "dropped"].includes(tag));
  return { type: type || "comic", status: status || "" };
}

function findSeriesCards($, selector) {
  const selected = selector ? $(selector).toArray() : [];
  if (selected.length) return selected;
  const cards = [];
  const seen = new Set();
  $("a[href*='/series/']").each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    const slug = seriesSlugFromHref(href);
    if (!slug || href.includes("?genre=") || seen.has(slug)) return;
    let card = $(anchor).closest(".group");
    if (!card.length) card = $(anchor).parent().parent();
    if (!card.length) card = $(anchor);
    seen.add(slug);
    cards.push(card.get(0));
  });
  return cards;
}

function parseSirenListHtml(html, { page = 1, search = false } = {}) {
  const $ = cheerio.load(html);
  const selector = search ? "" : ".latest-poster";
  const cards = findSeriesCards($, selector);
  const results = [];
  const seen = new Set();
  for (const card of cards) {
    const seriesAnchor = $(card)
      .find("a[href*='/series/']")
      .filter((_, anchor) => !($(anchor).attr("href") || "").includes("?genre="))
      .first();
    const href = seriesAnchor.attr("href") || "";
    const slug = seriesSlugFromHref(href);
    if (!slug || seen.has(slug)) continue;
    const title = cleanText(
      seriesAnchor.attr("title"),
      cleanText($(card).find("h1,h2,h3,h4").first().text())
    );
    if (!title) continue;
    seen.add(slug);
    const coverNode = $(card).find("[style*='background-image']").first();
    const image = normalizeSirenImageUrl(
      styleImageUrl(coverNode.attr("style")) ||
        $(card).find("img").first().attr("data-src") ||
        $(card).find("img").first().attr("src")
    );
    const chapters = uniqueChapters(
      $(card)
        .find("a[href*='/chapter/']")
        .map((_, element) => parseChapterAnchor($, element, slug))
        .get()
    );
    const latest = chapters[0] || {};
    const oldest = chapters[chapters.length - 1] || {};
    const { type, status } = typeAndStatusFromCard($, card);
    results.push({
      source: "siren",
      title,
      slug,
      image,
      detail_link: `${SIREN_SITE_BASE}/series/${slug}/`,
      description: "",
      type_genre: type,
      info: status || latest.time || "Updated",
      chapter_awal: oldest.title || "",
      chapter_terbaru: latest.title || "",
      chapters,
    });
  }
  return {
    success: true,
    meta: {
      currentPage: page,
      totalPages: page,
      totalItems: results.length,
      hasNextPage: false,
    },
    data: results,
  };
}

function fieldValue($, root, label) {
  const target = cleanText(label).toLowerCase();
  let value = "";
  $(root)
    .find("div,span,p")
    .each((_, element) => {
      if (value) return;
      const node = $(element);
      const ownText = cleanText(node.clone().children().remove().end().text())
        .replace(/:\s*$/, "")
        .toLowerCase();
      if (ownText !== target) return;
      const labelContainer = node.parent();
      const container = labelContainer.next().length
        ? labelContainer.parent()
        : labelContainer;
      const candidates = container
        .children()
        .map((__, child) => cleanText($(child).text()))
        .get()
        .filter((text) => text && text.replace(/:\s*$/, "").toLowerCase() !== target);
      value = candidates[candidates.length - 1] || "";
      if (!value) {
        value = cleanText(container.text())
          .replace(new RegExp(`^${label}\\s*:?\\s*`, "i"), "")
          .trim();
      }
    });
  return value;
}

function parseSirenDetailHtml(html, slug) {
  const $ = cheerio.load(html);
  const og = (property) => cleanText($(`meta[property='${property}']`).attr("content"));
  const canonicalSlug = seriesSlugFromHref(og("og:url")) || seriesSlugFromHref(slug);
  const titleNode = $("h1").filter((_, element) => cleanText($(element).text()) === og("og:title")).first();
  const title = og("og:title") || cleanText(titleNode.text(), cleanText($("h1").last().text()));
  const infoRoot = titleNode.length ? titleNode.parent().parent() : $("body");
  const genres = infoRoot
    .find("a[href*='genre=']")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter((genre, index, all) => genre && all.indexOf(genre) === index);
  const chapters = uniqueChapters(
    $("a[href*='/chapter/']")
      .filter((_, element) => Boolean($(element).attr("d")))
      .map((_, element) => parseChapterAnchor($, element, canonicalSlug))
      .get()
  );
  const synopsisHeading = $("div,h2,h3,h4")
    .filter((_, element) => cleanText($(element).text()).toLowerCase() === "synopsis")
    .first();
  let synopsis = cleanText(synopsisHeading.next().text());
  if (!synopsis) {
    synopsis = og("og:description").split(" - Why stay stranded on the shore")[0].trim();
  }
  if (!title || !canonicalSlug) throw new Error("Struktur detail Siren tidak dikenali");
  return {
    success: true,
    data: {
      title,
      thumbnail: normalizeSirenImageUrl(og("og:image")),
      type: fieldValue($, infoRoot, "Type") || "comic",
      status: fieldValue($, infoRoot, "Status") || "Unknown",
      Pengarang: fieldValue($, infoRoot, "Author") || "-",
      Umur: "-",
      Konsep: fieldValue($, infoRoot, "Created") || "-",
      artist: fieldValue($, infoRoot, "Artist") || "-",
      genres,
      synopsis: synopsis || "Tidak ada sinopsis.",
      info: fieldValue($, infoRoot, "Updated") || "",
      total_chapter: chapters.length,
      chapters,
    },
  };
}

function parseSirenChapterHtml(html, seriesSlug, chapterSlug) {
  const $ = cheerio.load(html);
  const images = [];
  $("img[uid]").each((_, element) => {
    const uid = cleanText($(element).attr("uid"));
    if (!uid) return;
    const url = `${SIREN_CDN_BASE}/${uid}`;
    if (!images.includes(url)) images.push(url);
  });
  if (!images.length) {
    $("#pages img, .reader img, .reading-content img").each((_, element) => {
      const src =
        $(element).attr("data-src") ||
        $(element).attr("data-lazy-src") ||
        $(element).attr("src");
      const url = normalizeSirenImageUrl(src);
      if (url && !/placeholder\.svg/i.test(url) && !images.includes(url)) images.push(url);
    });
  }
  if (!images.length && $("#purchase_button,#paid-chapter,[card_uid]").length) {
    return {
      success: false,
      locked: true,
      message: "Chapter premium Siren tidak dapat diakses tanpa pembelian.",
    };
  }
  if (!images.length) throw new Error("Gambar chapter Siren tidak ditemukan");
  const allChapterLinks = $("a[href*='/chapter/']")
    .map((_, element) => ({
      slug: chapterSlugFromHref($(element).attr("href")),
      title: cleanText($(element).attr("title")),
      text: cleanText($(element).text()),
      icons: $(element)
        .find("img")
        .map((__, image) => $(image).attr("src") || "")
        .get()
        .join(" "),
    }))
    .get();
  const navLinks = allChapterLinks.filter((link) => !link.title && !link.text && link.slug !== chapterSlug);
  let prev = navLinks.find((link) => /left|previous|prev/i.test(link.icons))?.slug || null;
  let next = navLinks.find((link) => /right|next/i.test(link.icons))?.slug || null;
  if (!prev && navLinks.length) prev = navLinks[0].slug;
  if (!next && navLinks.length > 1) next = navLinks[navLinks.length - 1].slug;
  const title = cleanText($("h1").first().text(), cleanText($("title").text()));
  const currentChapter = title.includes(" - ") ? title.split(" - ").slice(1).join(" - ") : title;
  return {
    success: true,
    mangaId: seriesSlug,
    chapterSlug,
    currentChapter: currentChapter || chapterSlug.replace(/-/g, " "),
    prev,
    next,
    back_to_detail: seriesSlug,
    totalImages: images.length,
    images,
  };
}

async function scrapeSirenPustaka({ page = 1 } = {}) {
  const items = await getSirenCatalogItems();
  const result = paginateSirenResult({ success: true, data: [...items] }, page);
  if (!result.data.length) throw new Error("Data komik Siren kosong");
  return result;
}

async function scrapeSirenSearch(query, page = 1) {
  const items = await getSirenCatalogItems();
  const parsed = { success: true, data: [...items] };
  const needle = query.toLocaleLowerCase("en");
  parsed.data = parsed.data.filter((item) =>
    item.title.toLocaleLowerCase("en").includes(needle)
  );
  paginateSirenResult(parsed, page);
  return {
    success: true,
    query,
    meta: parsed.meta,
    data: parsed.data.map((item) => ({
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

async function scrapeSirenDetail(slug) {
  const cleanSlug = seriesSlugFromHref(slug);
  try {
    const html = await sirenFetch(`/series/${encodeURIComponent(cleanSlug)}/`);
    return parseSirenDetailHtml(html, cleanSlug);
  } catch (error) {
    if (!error.archiveMissing) throw error;
    const item = (await getSirenCatalogItems()).find(
      (candidate) => candidate.slug === cleanSlug
    );
    if (!item) throw error;
    return catalogItemAsDetail(item);
  }
}

async function scrapeSirenChapter(seriesSlug, chapterSlug) {
  const cleanSeriesSlug = seriesSlugFromHref(seriesSlug);
  const cleanChapterSlug = chapterSlugFromHref(chapterSlug);
  const html = await sirenFetch(`/chapter/${encodeURIComponent(cleanChapterSlug)}/`, {
    referer: `${SIREN_SITE_BASE}/series/${cleanSeriesSlug}/`,
  });
  return parseSirenChapterHtml(html, cleanSeriesSlug, cleanChapterSlug);
}

function parsePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

module.exports = function registerSirenRoutes(
  app,
  { getCache, setCache, coalescedScrape, getImageCache, setImageCache }
) {
  app.get("/siren/image", async (req, res) => {
    if (!req.query.url) return res.status(400).send("No URL provided");
    try {
      const imageUrl = normalizeSirenImageUrl(decodeURIComponent(req.query.url));
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" || !SIREN_IMAGE_HOSTS.has(parsed.hostname)) {
        return res.status(400).send("URL gambar Siren tidak valid");
      }
      const cached = getImageCache(imageUrl);
      if (cached) {
        return res.set("Content-Type", cached.contentType).set("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800").send(cached.buffer);
      }
      const response = await axios.get(imageUrl, {
        headers: sirenHeaders(`${SIREN_SITE_BASE}/`),
        responseType: "stream",
        timeout: 25000,
      });
      const chunks = [];
      response.data.on("data", (c) => chunks.push(c));
      response.data.on("end", () => {
        const buf = Buffer.concat(chunks);
        const upstreamType = response.headers["content-type"] || "";
        const contentType = parsed.hostname === "cdn.meowing.org" && /^text\/plain/i.test(upstreamType)
          ? "image/jpeg"
          : upstreamType || "image/jpeg";
        setImageCache(imageUrl, buf, contentType);
        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800");
        res.send(buf);
      });
    } catch (error) {
      console.error(`[Siren Proxy Error] ${error.message}`);
      res.status(error.response?.status || 502).send("Gagal mengambil gambar Siren");
    }
  });

  app.get("/siren/pustaka", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const cacheKey = `siren:pustaka:p:${page}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(cacheKey, () => scrapeSirenPustaka({ page }));
      const response = {
        success: true,
        source: "sirenscans.com",
        page,
        total: result.data.length,
        meta: result.meta,
        data: rewriteSirenImages(result.data, req),
      };
      setCache(cacheKey, response, 120);
      res.json(response);
    } catch (error) {
      console.error(`[Siren Pustaka Error] ${error.message}`);
      res.status(502).json({
        success: false,
        page,
        total: 0,
        data: [],
        message: error.message,
      });
    }
  });

  app.get("/siren/detail/:slug", async (req, res) => {
    const slug = seriesSlugFromHref(req.params.slug);
    if (!slug) return res.status(400).json({ success: false, message: "Slug tidak diberikan!" });
    const cacheKey = `siren:detail:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeSirenDetail(slug);
        scraped.data = rewriteSirenImages(scraped.data, req);
        return scraped;
      });
      if (result.success) setCache(cacheKey, result, 900);
      res.status(result.success ? 200 : 502).json(result);
    } catch (error) {
      console.error(`[Siren Detail Error] ${slug}: ${error.message}`);
      res.status(error.archiveMissing ? 404 : 502).json({
        success: false,
        unavailable: Boolean(error.archiveMissing),
        message: error.archiveMissing
          ? "Detail Siren tidak ditemukan pada katalog maupun arsip."
          : error.message,
      });
    }
  });

  app.get("/siren/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const seriesSlug = seriesSlugFromHref(req.params.seriesSlug);
    const chapterSlug = chapterSlugFromHref(req.params.chapterSlug);
    if (!seriesSlug || !chapterSlug) {
      return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap!" });
    }
    const cacheKey = `siren:chapter:${seriesSlug}:${chapterSlug}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeSirenChapter(seriesSlug, chapterSlug);
        return scraped.success ? rewriteSirenImages(scraped, req) : scraped;
      });
      if (result.success) setCache(cacheKey, result, 7200);
      res.status(result.success ? 200 : result.locked ? 403 : 502).json(result);
    } catch (error) {
      console.error(
        `[Siren Chapter Error] ${seriesSlug}/${chapterSlug}: ${error.message}`
      );
      res.status(error.archiveMissing ? 404 : 502).json({
        success: false,
        unavailable: Boolean(error.archiveMissing),
        message: error.archiveMissing
          ? "Snapshot chapter Siren belum tersedia."
          : error.message,
      });
    }
  });

  app.get("/siren/search", async (req, res) => {
    const query = cleanText(req.query.q);
    if (!query) return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const cacheKey = `siren:search:${query.toLowerCase()}:p:${page}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(cacheKey, () => scrapeSirenSearch(query, page));
      result.data = rewriteSirenImages(result.data, req);
      setCache(cacheKey, result, 300);
      res.json(result);
    } catch (error) {
      console.error(`[Siren Search Error] ${error.message}`);
      res.status(502).json({
        success: false,
        query,
        meta: { currentPage: page, totalPages: page },
        data: [],
        message: error.message,
      });
    }
  });

  console.log(
    "✅ Siren routes registered: /siren/image, /siren/pustaka, " +
      "/siren/detail/:slug, /siren/chapter/:seriesSlug/:chapterSlug, /siren/search"
  );
};

module.exports._test = {
  sirenFetch,
  isCloudflareChallenge,
  normalizeSirenImageUrl,
  styleImageUrl,
  seriesSlugFromHref,
  chapterSlugFromHref,
  parseSirenListHtml,
  parseSirenDetailHtml,
  parseSirenChapterHtml,
  parsePage,
  scrapeSirenPustaka,
  scrapeSirenSearch,
  scrapeSirenDetail,
  scrapeSirenChapter,
};
