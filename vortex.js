"use strict";

/**
 * =====================================================
 * ⚡ SCRAPER VORTEX SCANS - https://vortexscans.org/
 * =====================================================
 * Mendukung:
 * - Pustaka (Pagination & Latest Updates via REST API)
 * - Pencarian / Search (via REST API)
 * - Detail Comic & Chapter List (via SSR HTML Parsing)
 * - Chapter Reader Images (via SSR HTML Parsing)
 * - Image Proxy (Bypass CDN Cloudflare & Hotlink Protection)
 * =====================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");

const BASE_SITE = "https://vortexscans.org";
const API_BASE = "https://api.vortexscans.org";
const IMAGE_HOSTS = new Set([
  "storage.vortexscans.org",
  "vortexscans.org",
  "www.vortexscans.org",
  "api.vortexscans.org",
  "i.ibb.co",
  "cdn.discordapp.com",
]);
const PER_PAGE = 20;

// ===========================
// 🛠️ HELPER FUNCTIONS
// ===========================

function clean(value, fallback = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim() || fallback;
}

function cleanSlug(value = "") {
  return decodeURIComponent(String(value ?? ""))
    .replace(/^https?:\/\/(?:www\.)?vortexscans\.org\/series\//i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^series\//i, "")
    .split(/[?#]/)[0]
    .trim();
}

function parsePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

function vortexHeaders(referer = `${BASE_SITE}/`) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8,en-US;q=0.7",
    Referer: referer,
  };
}

function timeAgo(dateString) {
  if (!dateString) return "";
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    if (seconds < 60) return "baru saja";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} menit lalu`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} jam lalu`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} hari lalu`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks} minggu lalu`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} bulan lalu`;
    const years = Math.floor(days / 365);
    return `${years} tahun lalu`;
  } catch {
    return dateString;
  }
}

function normalizeImage(value = "") {
  const src = clean(value).replace(/&amp;/g, "&");
  if (!src || /^data:|^blob:/i.test(src)) return "";
  if (src.startsWith("//")) return `https:${src}`;
  if (/^https?:\/\//i.test(src)) return src;
  return `${BASE_SITE}/${src.replace(/^\/+/, "")}`;
}

function baseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function proxyImage(value, req) {
  const url = normalizeImage(value);
  return url ? `${baseUrl(req)}/vortex/image?url=${encodeURIComponent(url)}` : "";
}

function rewriteImages(payload, req) {
  if (Array.isArray(payload)) return payload.map((item) => rewriteImages(item, req));
  if (!payload || typeof payload !== "object") return payload;

  const rewritten = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      rewritten[key] = value.map((img) => (typeof img === "string" ? proxyImage(img, req) : img));
      continue;
    }
    if (["image", "thumbnail", "cover", "featuredImage"].includes(key) && typeof value === "string") {
      rewritten[key] = proxyImage(value, req);
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

async function scrapeVortexPustaka({ page = 1, perPage = PER_PAGE } = {}) {
  try {
    const url = `${API_BASE}/api/posts?page=${page}&perPage=${perPage}`;
    const response = await axios.get(url, {
      headers: {
        ...vortexHeaders(),
        Accept: "application/json, text/plain, */*",
        Origin: BASE_SITE,
      },
      timeout: 20000,
    });

    const data = response.data || {};
    const posts = Array.isArray(data.posts) ? data.posts : [];
    const totalItems = data.totalCount || posts.length;
    const totalPages = Math.ceil(totalItems / perPage) || 1;

    const results = posts.map((post) => {
      const chapters = (post.chapters || []).map((ch) => ({
        title: ch.title || (ch.number ? `Chapter ${ch.number}` : ch.slug),
        link: `chapter/${post.slug}/${ch.slug}`,
        time: timeAgo(ch.createdAt),
        locked: Boolean(ch.isLocked || !ch.isAccessible),
      }));

      const latest = chapters[0] || {};
      const oldest = chapters[chapters.length - 1] || {};

      return {
        source: "vortex",
        title: post.postTitle || "",
        slug: post.slug || "",
        image: normalizeImage(post.featuredImage || ""),
        detail_link: `${BASE_SITE}/series/${post.slug}`,
        description: post.alternativeTitles || "",
        type_genre: (post.seriesType || "manhwa").toLowerCase(),
        info: timeAgo(post.lastChapterAddedAt || post.updatedAt),
        chapter_awal: oldest.title || "",
        chapter_terbaru: latest.title || "",
        chapters,
      };
    });

    return {
      success: true,
      meta: {
        currentPage: page,
        totalPages,
        totalItems,
        hasNextPage: page < totalPages,
      },
      data: results,
    };
  } catch (err) {
    console.error("❌ Vortex pustaka error:", err.message);
    throw err;
  }
}

// =====================================================
// 🔍 SCRAPER: SEARCH
// =====================================================

async function scrapeVortexSearch(query, page = 1, perPage = PER_PAGE) {
  try {
    const cleanQuery = clean(query);
    const url = `${API_BASE}/api/posts?searchTerm=${encodeURIComponent(cleanQuery)}&page=${page}&perPage=${perPage}`;
    const response = await axios.get(url, {
      headers: {
        ...vortexHeaders(),
        Accept: "application/json, text/plain, */*",
        Origin: BASE_SITE,
      },
      timeout: 20000,
    });

    const data = response.data || {};
    const posts = Array.isArray(data.posts) ? data.posts : [];
    const totalItems = data.totalCount || posts.length;
    const totalPages = Math.ceil(totalItems / perPage) || 1;

    const results = posts.map((post) => {
      const latestChapter = post.chapters?.[0];
      const updateText = latestChapter
        ? latestChapter.title || (latestChapter.number ? `Chapter ${latestChapter.number}` : latestChapter.slug)
        : "";

      return {
        title: post.postTitle || "",
        image: normalizeImage(post.featuredImage || ""),
        detail_link: `${BASE_SITE}/series/${post.slug}`,
        type_genre: (post.seriesType || "manhwa").toLowerCase(),
        update: updateText,
        rating: post.averageRating ? Number(post.averageRating).toFixed(1) : "0.0",
        slug: post.slug || "",
      };
    });

    return {
      success: true,
      query: cleanQuery,
      meta: {
        currentPage: page,
        totalPages,
        totalItems,
        hasNextPage: page < totalPages,
      },
      data: results,
    };
  } catch (err) {
    console.error("❌ Vortex search error:", err.message);
    return {
      success: true,
      query,
      meta: { currentPage: page, totalPages: 1, totalItems: 0, hasNextPage: false },
      data: [],
      warning: "Gagal melakukan pencarian Vortex Scans",
    };
  }
}

// =====================================================
// 📖 SCRAPER: DETAIL MANGA
// =====================================================

async function scrapeVortexDetail(slug) {
  const cleanSeriesSlug = cleanSlug(slug);
  if (!cleanSeriesSlug) throw new Error("Slug tidak diberikan");

  const url = `${BASE_SITE}/series/${encodeURIComponent(cleanSeriesSlug)}`;

  const response = await axios.get(url, {
    headers: vortexHeaders(),
    timeout: 25000,
  });

  const $ = cheerio.load(response.data);

  // Extract JSON-LD metadata if available
  let ldArticle = null;
  let ldImage = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html() || "{}");
      if (parsed["@graph"]) {
        const article = parsed["@graph"].find(
          (item) => item["@type"] === "Article" || item["@type"]?.includes("Article")
        );
        const imgObj = parsed["@graph"].find((item) => item["@type"] === "ImageObject");
        if (article) ldArticle = article;
        if (imgObj) ldImage = imgObj;
      }
    } catch (_) {}
  });

  // Extract Title
  let title = $("h1.break-words, h1.text-2xl, h1").last().text().trim();
  if (!title || ["Status", "Type", "Chapters", "Last update"].includes(title)) {
    title =
      ldArticle?.name?.replace(/\s*(?:Manhwa|Manga|Manhua)\s*-\s*Vortex\s*Scans$/i, "") ||
      $("title").text().split("-")[0].trim();
  }

  // Extract Thumbnail
  let thumbnail =
    $('img[alt*="' + title.replace(/"/g, "") + '"]').first().attr("src") ||
    $(".poster img, [class*='poster'] img, [class*='cover'] img, main img[src*='storage.vortexscans.org']")
      .first()
      .attr("src") ||
    ldArticle?.image?.["@id"] ||
    ldImage?.url ||
    "";
  thumbnail = normalizeImage(thumbnail);

  // Extract Synopsis
  let synopsis = "";
  if (ldArticle?.description) {
    synopsis = ldArticle.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (!synopsis || synopsis.startsWith("Read Comics, manga")) {
    synopsis = $("p[class*='description'], [class*='synopsis'], [class*='summary']").first().text().trim();
  }
  if (!synopsis || synopsis.startsWith("Read Comics, manga")) {
    $("main p, .prose p").each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 30 && !t.startsWith("Read Comics") && !synopsis) {
        synopsis = t;
      }
    });
  }

  // Extract Metadata: Status, Type, Author, Artist, Released
  let status = "Ongoing";
  let type = "Manhwa";
  let author = "-";
  let artist = "-";
  let released = "-";

  $("div, span, p, a").each((_, el) => {
    const t = $(el).text().trim().replace(/\s+/g, " ");
    if (t.startsWith("Status")) {
      const val = clean(t.replace(/^Status/i, ""));
      if (val) status = val;
    }
    if (t.startsWith("Type")) {
      const val = clean(t.replace(/^Type/i, ""));
      if (val) type = val;
    }
    if (t.startsWith("Author")) {
      const val = clean(t.replace(/^Author/i, ""));
      if (val) author = val;
    }
    if (t.startsWith("Artist")) {
      const val = clean(t.replace(/^Artist/i, ""));
      if (val) artist = val;
    }
    if (t.startsWith("Released") || t.startsWith("Release Year")) {
      const val = clean(t.replace(/^(?:Released|Release Year)/i, ""));
      if (val) released = val;
    }
  });

  // Extract Genres
  const genres = [];
  $("a[class*='rounded-lg'][class*='px-2.5'], a[href*='/genre/'], a[href*='/genres/'], [class*='badge']").each(
    (_, el) => {
      const href = $(el).attr("href") || "";
      if (href.includes("/series/")) return;
      const g = $(el).text().trim();
      if (
        g &&
        g.length < 30 &&
        !["Read Chapter 1", "Bookmark", "Bookmarks", "Discussion", "Status", "Type", "Ongoing", "Completed"].includes(g)
      ) {
        if (!genres.includes(g)) genres.push(g);
      }
    }
  );

  // Extract Chapters (skip "Read Chapter 1" hero button)
  const chapters = [];
  const seenSlugs = new Set();

  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (
      href.includes(`/series/${cleanSeriesSlug}/`) &&
      !href.endsWith(`/series/${cleanSeriesSlug}/`) &&
      !href.endsWith(`/series/${cleanSeriesSlug}`)
    ) {
      const chapSlug = href.split(`/series/${cleanSeriesSlug}/`)[1]?.replace(/^\/+|\/+$/g, "").split(/[?#]/)[0];
      if (!chapSlug || seenSlugs.has(chapSlug)) return;

      const rawText = $(el).text().trim().replace(/\s+/g, " ");
      if (rawText.toLowerCase().startsWith("read chapter")) {
        return; // Skip banner button
      }

      seenSlugs.add(chapSlug);

      let chapTitle = "";
      const chapSpan = $(el).find("span.font-medium, .text-medium, [class*='title']").first().text().trim().replace(/\s+/g, " ");
      if (chapSpan) {
        chapTitle = chapSpan;
      } else {
        const chapMatch = rawText.match(/Chapter\s*[\d.]+/i);
        chapTitle = chapMatch ? chapMatch[0] : chapSlug;
      }

      // Date parsing
      let date = $(el).find("time").text().trim() || $(el).find("span[title]").attr("title") || "";
      if (!date) {
        const dateMatch = rawText.match(
          /(\d+\s+(?:days?|months?|hours?|weeks?|years?)\s*(?:ago)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d+,?\s+\d{4})/i
        );
        if (dateMatch) date = dateMatch[0];
      }

      // Lock status
      const isLocked = $(el).find("div.absolute.inset-0.bg-black\\/50, svg path[d*='5.25'], [class*='lock']").length > 0;

      chapters.push({
        title: chapTitle || chapSlug,
        slug: chapSlug,
        link: `chapter/${cleanSeriesSlug}/${chapSlug}`,
        date: date || "",
        time: "",
        locked: isLocked,
      });
    }
  });

  return {
    success: true,
    data: {
      title,
      thumbnail,
      type,
      status,
      Pengarang: author,
      Umur: "-",
      Konsep: released,
      artist,
      genres,
      synopsis: synopsis || "Tidak ada sinopsis.",
      info: "",
      total_chapter: chapters.length,
      chapters,
    },
  };
}

// =====================================================
// 🖼️ SCRAPER: CHAPTER IMAGES
// =====================================================

async function scrapeVortexChapter(seriesSlug, chapterSlug) {
  const cleanSeries = cleanSlug(seriesSlug);
  const cleanChap = clean(chapterSlug).replace(/^\/+|\/+$/g, "");
  if (!cleanSeries || !cleanChap) throw new Error("Slug chapter tidak lengkap");

  const url = `${BASE_SITE}/series/${encodeURIComponent(cleanSeries)}/${encodeURIComponent(cleanChap)}`;

  const response = await axios.get(url, {
    headers: vortexHeaders(`${BASE_SITE}/series/${cleanSeries}`),
    timeout: 25000,
  });

  const $ = cheerio.load(response.data);
  const images = [];

  // Parse reader images
  $("[data-reader-page-image], img[src*='storage.vortexscans.org/upload/series/'], img[src*='storage.vortexscans.org/upload/']").each(
    (_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || "";
      if (
        src &&
        src.includes("storage.vortexscans.org") &&
        !src.includes("/banner/") &&
        !src.includes("/featured/") &&
        !src.includes("/emotes/") &&
        !src.includes("discord")
      ) {
        const norm = normalizeImage(src);
        if (norm && !images.includes(norm)) images.push(norm);
      }
    }
  );

  // Fallback: search all img tags if none matched above
  if (images.length === 0) {
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || "";
      if (src && src.includes("storage.vortexscans.org") && src.includes("/upload/")) {
        const norm = normalizeImage(src);
        if (norm && !images.includes(norm)) images.push(norm);
      }
    });
  }

  // Navigation (previous / next chapter)
  let prev = null;
  let next = null;

  $("a[href*='/series/" + cleanSeries + "/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().toLowerCase();
    const chap = href.split(`/series/${cleanSeries}/`)[1]?.replace(/^\/+|\/+$/g, "").split(/[?#]/)[0];
    if (chap && chap !== cleanChap) {
      if (text.includes("prev") || text.includes("previous") || $(el).attr("rel") === "prev") {
        prev = chap;
      }
      if (text.includes("next") || $(el).attr("rel") === "next") {
        next = chap;
      }
    }
  });

  const titleMatch = $("title").text().match(/Chapter\s*[\d.]+/i);
  const currentChapter = titleMatch ? titleMatch[0] : cleanChap;

  return {
    success: true,
    mangaId: cleanSeries,
    chapterSlug: cleanChap,
    currentChapter,
    prev,
    next,
    back_to_detail: cleanSeries,
    totalImages: images.length,
    images,
  };
}

// =====================================================
// 🚀 ROUTE REGISTRATION
// =====================================================

module.exports = function registerVortexRoutes(app, { getCache, setCache, coalescedScrape, getImageCache, setImageCache }) {
  // ── IMAGE PROXY ──────────────────────────────────────
  app.get("/vortex/image", async (req, res) => {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("No URL provided");
    }

    try {
      const imageUrl = normalizeImage(decodeURIComponent(url));
      const parsed = new URL(imageUrl);

      if (parsed.protocol !== "https:" || !IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
        return res.status(400).send("URL gambar Vortex tidak valid");
      }

      const cached = getImageCache(imageUrl || url);
      if (cached) {
        return res.set('Content-Type', cached.contentType).set('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800').send(cached.buffer);
      }

      const response = await axios.get(imageUrl, {
        headers: {
          Referer: `${BASE_SITE}/`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        },
        responseType: "stream",
        timeout: 25000,
      });

      res.set({
        "Content-Type": response.headers["content-type"] || "image/webp",
        ...(response.headers["content-length"] ? { "Content-Length": response.headers["content-length"] } : {}),
        "Cache-Control": "public, max-age=31536000",
      });

      const chunks = [];
      response.data.on('data', c => chunks.push(c));
      response.data.on('end', () => {
        const buf = Buffer.concat(chunks);
        setImageCache(imageUrl || url, buf, response.headers['content-type'] || 'image/jpeg');
        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800');
        res.send(buf);
      });
    } catch (err) {
      console.error(`[Vortex Proxy Error] URL: ${url} | Error: ${err.message}`);
      res.status(err.response?.status || 502).send("Gagal mengambil gambar Vortex");
    }
  });

  // ── PUSTAKA ─────────────────────────────────────────
  app.get("/vortex/pustaka", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) {
      return res.status(400).json({ success: false, message: "Page tidak valid" });
    }

    const cacheKey = `vortex:pustaka:p:${page}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeVortexPustaka({ page });

        if (!result.success || !result.data.length) {
          return {
            success: true,
            page,
            total: 0,
            data: [],
            warning: "Data kosong / Vortex Scans limit",
          };
        }

        return {
          success: true,
          source: "vortexscans.org",
          page,
          total: result.data.length,
          meta: result.meta,
          data: rewriteImages(result.data, req),
        };
      });

      setCache(cacheKey, responseData, 120); // Cache 2 menit
      res.json(responseData);
    } catch (err) {
      console.error(`[Vortex Pustaka Error] ${err.message}`);
      res.status(502).json({ success: false, page, total: 0, data: [], message: err.message });
    }
  });

  // ── SEARCH ──────────────────────────────────────────
  app.get("/vortex/search", async (req, res) => {
    const query = clean(req.query.q);
    if (!query) {
      return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    }

    const page = parsePage(req.query.page || "1");
    if (!page) {
      return res.status(400).json({ success: false, message: "Page tidak valid" });
    }

    const cacheKey = `vortex:search:${query.toLowerCase()}:p:${page}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeVortexSearch(query, page);
        if (result.success && result.data) {
          result.data = rewriteImages(result.data, req);
        }
        return result;
      });

      setCache(cacheKey, responseData, 300); // Cache 5 menit
      res.json(responseData);
    } catch (err) {
      console.error(`[Vortex Search Error] ${err.message}`);
      res.status(502).json({
        success: false,
        query,
        meta: { currentPage: page, totalPages: page, totalItems: 0, hasNextPage: false },
        data: [],
        message: "Gagal mencari komik Vortex",
      });
    }
  });

  // ── DETAIL ──────────────────────────────────────────
  app.get("/vortex/detail/:slug", async (req, res) => {
    const slug = cleanSlug(req.params.slug);
    if (!slug) {
      return res.status(400).json({ success: false, message: "Slug tidak diberikan!" });
    }

    const cacheKey = `vortex:detail:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeVortexDetail(slug);
        if (scraped.success) {
          scraped.data = rewriteImages(scraped.data, req);
        }
        return scraped;
      });

      if (result && result.success) {
        setCache(cacheKey, result, 900); // Cache 15 menit
      }
      res.status(result.success ? 200 : 502).json(result);
    } catch (err) {
      console.error(`[Vortex Detail Error] ${slug}: ${err.message}`);
      res.status(502).json({ success: false, message: err.message });
    }
  });

  // ── CHAPTER ─────────────────────────────────────────
  app.get("/vortex/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const seriesSlug = cleanSlug(req.params.seriesSlug);
    const chapterSlug = clean(req.params.chapterSlug).replace(/^\/+|\/+$/g, "");
    if (!seriesSlug || !chapterSlug) {
      return res.status(400).json({ success: false, message: "Slug series atau chapter tidak lengkap!" });
    }

    const cacheKey = `vortex:chapter:${seriesSlug}:${chapterSlug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeVortexChapter(seriesSlug, chapterSlug);
        if (scraped.success) {
          return rewriteImages(scraped, req);
        }
        return scraped;
      });

      if (result && result.success) {
        setCache(cacheKey, result, 7200); // Cache 2 jam
      }
      res.status(result.success ? 200 : 502).json(result);
    } catch (err) {
      console.error(`[Vortex Chapter Error] ${seriesSlug}/${chapterSlug}: ${err.message}`);
      res.status(502).json({ success: false, message: err.message });
    }
  });

  console.log(
    "✅ Vortex routes registered: /vortex/image, /vortex/pustaka, /vortex/search, /vortex/detail/:slug, /vortex/chapter/:seriesSlug/:chapterSlug"
  );
};

module.exports._test = {
  scrapeVortexPustaka,
  scrapeVortexSearch,
  scrapeVortexDetail,
  scrapeVortexChapter,
  normalizeImage,
  rewriteImages,
  cleanSlug,
  parsePage,
};
