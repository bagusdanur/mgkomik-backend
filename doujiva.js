/**
 * =====================================================
 * ⚡ SCRAPER DOUJIVA - https://doujiva.com/
 * =====================================================
 * Format output JSON disesuaikan dengan scraper Asura & Kiryuu
 * Memiliki fallback multi-strategi fetch + Image Proxy untuk CORS CDN
 * =====================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");
const cloudscraper = require("cloudscraper");

const DOUJIVA_SITE_BASE = "https://doujiva.com";

// ===========================
// 🛠️ HELPER FUNCTIONS
// ===========================

function doujivaHeaders(referer = DOUJIVA_SITE_BASE + "/") {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: referer,
    Connection: "keep-alive",
  };
}

function isCloudflareChallenge(html = "") {
  return /Just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies/i.test(
    String(html)
  );
}

async function doujivaFetch(endpoint, options = {}) {
  const fullUrl = endpoint.startsWith("http") ? endpoint : `${DOUJIVA_SITE_BASE}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const headers = doujivaHeaders(options.referer || DOUJIVA_SITE_BASE + "/");
  const timeout = options.timeout || 20000;
  const errors = [];

  // Strategi 1: Axios direct
  try {
    const { data } = await axios.get(fullUrl, { headers, timeout });
    if (typeof data === "string" && !isCloudflareChallenge(data)) {
      return data;
    }
    if (typeof data === "object") return data;
    errors.push("axios:cloudflare-challenge");
  } catch (err) {
    errors.push(`axios:${err.response?.status || err.code || err.message}`);
  }

  // Strategi 2: Cloudscraper
  try {
    const html = await cloudscraper.get({ uri: fullUrl, headers, timeout });
    if (typeof html === "string" && html.trim() && !isCloudflareChallenge(html)) {
      console.log(`[Doujiva] ✅ Cloudscraper berhasil untuk ${fullUrl}`);
      return html;
    }
    errors.push("cloudscraper:cloudflare-challenge");
  } catch (err) {
    errors.push(`cloudscraper:${err.message}`);
  }

  // Strategi 3: Worker proxy
  const WORKER_PROXY = process.env.DOUJIVA_PROXY_URL || process.env.NEKO_WORKER_URL || "https://proxy.kopipaitboskuh.workers.dev/?url=";
  if (WORKER_PROXY) {
    try {
      const workerUrl = `${WORKER_PROXY}${WORKER_PROXY.includes("?") ? "" : "?url="}${encodeURIComponent(fullUrl)}`;
      const { data } = await axios.get(workerUrl, { timeout });
      if (typeof data === "string" && !isCloudflareChallenge(data)) {
        console.log(`[Doujiva] ✅ Worker proxy berhasil untuk ${fullUrl}`);
        return data;
      }
      errors.push("worker:cloudflare-challenge");
    } catch (err) {
      errors.push(`worker:${err.response?.status || err.code || err.message}`);
    }
  }

  console.error(`[Doujiva] ❌ Semua strategi gagal untuk ${fullUrl}: ${errors.join(" -> ")}`);
  throw new Error(`Doujiva fetch gagal: ${errors.join(" -> ")}`);
}

function getRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function toDoujivaBackendImageUrl(url, req) {
  if (!url) return "";
  if (url.startsWith("/")) {
    url = `${DOUJIVA_SITE_BASE}${url}`;
  }
  return `${getRequestBaseUrl(req)}/doujiva/image?url=${encodeURIComponent(url)}`;
}

function rewriteDoujivaImages(payload, req) {
  if (Array.isArray(payload)) {
    return payload.map((item) => rewriteDoujivaImages(item, req));
  }
  if (!payload || typeof payload !== "object") return payload;

  const rewritten = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      rewritten[key] = value.map((img) => typeof img === "string" ? toDoujivaBackendImageUrl(img, req) : img);
      continue;
    }
    if ((key === "image" || key === "thumbnail" || key === "cover") && typeof value === "string") {
      rewritten[key] = toDoujivaBackendImageUrl(value, req);
      continue;
    }
    if (value && typeof value === "object") {
      rewritten[key] = rewriteDoujivaImages(value, req);
      continue;
    }
    rewritten[key] = value;
  }
  return rewritten;
}

// Helper untuk ekstrak JSON dari Next.js App Router __next_f stream
function extractNextFlightData(html) {
  const matches = [];
  const regex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const rawStr = match[1]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      matches.push(rawStr);
    } catch {
      // Ignore parse errors
    }
  }
  return matches.join("\n");
}

// =====================================================
// 📚 SCRAPER: PUSTAKA / LATEST UPDATES
// =====================================================

async function scrapeDoujivaPustaka({ page = 1, sort = "latest" } = {}) {
  try {
    let endpoint = `/?page=${page}`;
    if (sort && sort !== "latest") {
      endpoint = `/?sort=${sort}&page=${page}`;
    }
    console.log("⚡ Doujiva pustaka:", endpoint);

    const html = await doujivaFetch(endpoint);
    const $ = cheerio.load(html);
    const results = [];

    // Parse dari elemen HTML (DOM)
    $(".content-grid > div, grid > div, article, .group").each((_, el) => {
      const linkEl = $(el).find("a[href*='/g/'], a[href*='/manga/'], a[href*='/read/']").first();
      const href = linkEl.attr("href") || $(el).attr("href") || "";
      if (!href) return;

      const title = $(el).find("h2, h3, .title, font, p.font-bold, p.font-semibold").first().text().trim() || linkEl.text().trim();
      const imgEl = $(el).find("img").first();
      let image = imgEl.attr("src") || imgEl.attr("data-src") || "";

      const slug = href.replace(DOUJIVA_SITE_BASE, "").replace(/^\/|\/$/g, "");
      const chapterText = $(el).find(".chapter, .ep, span.text-xs").first().text().trim() || "Chapter 1";

      if (title && slug) {
        results.push({
          source: "doujiva",
          title,
          slug,
          image,
          detail_link: href.startsWith("http") ? href : `${DOUJIVA_SITE_BASE}/${slug}`,
          description: "",
          type_genre: "doujinshi",
          info: "Updated",
          chapter_awal: "Chapter 1",
          chapter_terbaru: chapterText,
          chapters: [
            {
              title: chapterText,
              link: `chapter/${slug}`,
              time: "baru saja",
              locked: false,
            }
          ],
        });
      }
    });

    // Fallback parser dari __next_f stream jika DOM kosong
    if (results.length === 0) {
      const flightData = extractNextFlightData(html);
      const idMatches = [...flightData.matchAll(/"id":"([^"]+)","title":"([^"]+)"/g)];
      for (const m of idMatches) {
        const id = m[1];
        const title = m[2];
        results.push({
          source: "doujiva",
          title,
          slug: `g/${id}`,
          image: `https://t.nhentai.net/galleries/${id}/cover.jpg`,
          detail_link: `${DOUJIVA_SITE_BASE}/g/${id}`,
          description: "",
          type_genre: "doujinshi",
          info: "Updated",
          chapter_awal: "Chapter 1",
          chapter_terbaru: "Chapter 1",
          chapters: [
            {
              title: "Full Chapter",
              link: `chapter/g/${id}`,
              time: "baru saja",
              locked: false,
            }
          ],
        });
      }
    }

    return {
      success: true,
      meta: {
        currentPage: page,
        totalPages: 50,
        totalItems: results.length * 50,
      },
      data: results,
    };
  } catch (err) {
    console.error("❌ Doujiva pustaka error:", err.message);
    return {
      success: false,
      meta: { currentPage: page, totalPages: 1, totalItems: 0 },
      data: [],
    };
  }
}

// =====================================================
// 📖 SCRAPER: DETAIL MANGA / DOUJIN
// =====================================================

async function scrapeDoujivaDetail(slug) {
  try {
    const cleanSlug = slug.trim().replace(/^\/|\/$/g, "");
    const endpoint = cleanSlug.startsWith("g/") || cleanSlug.startsWith("manga/") ? `/${cleanSlug}` : `/g/${cleanSlug}`;
    console.log("⚡ Doujiva detail:", endpoint);

    const html = await doujivaFetch(endpoint);
    const $ = cheerio.load(html);

    const title = $("h1").first().text().trim() || $("title").text().split("—")[0].trim() || "Doujin Details";
    const thumbnail = $("img.cover, .aspect-\\[3\\/4\\] img, img[alt*='cover']").first().attr("src") || $("img").first().attr("src") || "";
    const synopsis = $(".synopsis, .description, p.text-sm").first().text().trim() || "Tidak ada sinopsis.";

    const genres = [];
    $("a[href*='/tag/'], a[href*='/category/'], .tag").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    const artist = $("a[href*='/artist/']").first().text().trim() || "-";
    const author = $("a[href*='/group/']").first().text().trim() || artist;

    const chapters = [
      {
        title: "Full Chapter / Read Online",
        slug: cleanSlug,
        link: `chapter/${cleanSlug}`,
        date: "baru saja",
      }
    ];

    // Jika ada daftar chapter/halaman khusus
    $(".chapter-list a, .episodes a").each((i, el) => {
      const chHref = $(el).attr("href");
      const chTitle = $(el).text().trim() || `Chapter ${i + 1}`;
      if (chHref) {
        const chSlug = chHref.replace(DOUJIVA_SITE_BASE, "").replace(/^\/|\/$/g, "");
        chapters.push({
          title: chTitle,
          slug: chSlug,
          link: `chapter/${chSlug}`,
          date: "baru saja",
        });
      }
    });

    return {
      success: true,
      data: {
        title,
        thumbnail,
        type: "doujinshi",
        status: "Completed",
        Pengarang: author,
        Umur: "18+",
        Konsep: "Doujinshi",
        artist,
        genres,
        synopsis,
        info: "",
        total_chapter: chapters.length,
        chapters,
      },
    };
  } catch (err) {
    console.error("❌ Doujiva detail error:", err.message);
    return {
      success: false,
      message: "Gagal scrape detail Doujiva.",
    };
  }
}

// =====================================================
// 🖼️ SCRAPER: CHAPTER IMAGES
// =====================================================

async function scrapeDoujivaChapter(seriesSlug, chapterSlug) {
  try {
    const cleanSeriesSlug = seriesSlug ? seriesSlug.trim().replace(/^\/|\/$/g, "") : "";
    const cleanChapterSlug = chapterSlug ? chapterSlug.trim().replace(/^\/|\/$/g, "") : cleanSeriesSlug;
    
    let endpoint = `/${cleanChapterSlug}`;
    if (!cleanChapterSlug.startsWith("g/") && !cleanChapterSlug.startsWith("manga/")) {
      endpoint = `/g/${cleanChapterSlug}`;
    }
    console.log("⚡ Doujiva chapter:", endpoint);

    const html = await doujivaFetch(endpoint);
    const $ = cheerio.load(html);

    const images = [];

    // Extract dari img tag di DOM
    $("img[src*='/galleries/'], img[data-src*='/galleries/'], .reader-image img, .page-image img").each((_, el) => {
      const src = $(el).attr("data-src") || $(el).attr("src");
      if (src && !images.includes(src)) {
        images.push(src);
      }
    });

    // Fallback: parse URL gambar dari Next.js __next_f data
    if (images.length === 0) {
      const flightData = extractNextFlightData(html);
      const imgRegex = /https:\/\/i\.nhentai\.net\/galleries\/[0-9]+\/[0-9]+\.(jpg|png|webp)/g;
      const foundImgs = flightData.match(imgRegex);
      if (foundImgs) {
        foundImgs.forEach((img) => {
          if (!images.includes(img)) images.push(img);
        });
      }
    }

    const title = $("h1").first().text().trim() || `Chapter ${cleanChapterSlug}`;

    return {
      success: true,
      mangaId: cleanSeriesSlug,
      chapterSlug: cleanChapterSlug,
      currentChapter: title,
      prev: null,
      next: null,
      back_to_detail: cleanSeriesSlug,
      totalImages: images.length,
      images,
    };
  } catch (err) {
    console.error("❌ Doujiva chapter error:", err.message);
    return {
      success: false,
      message: err.message,
    };
  }
}

// =====================================================
// 🔍 SCRAPER: SEARCH
// =====================================================

async function scrapeDoujivaSearch(query, page = 1) {
  try {
    const endpoint = `/?q=${encodeURIComponent(query)}&page=${page}`;
    console.log("⚡ Doujiva search:", endpoint);

    const html = await doujivaFetch(endpoint);
    const $ = cheerio.load(html);
    const results = [];

    $(".content-grid > div, grid > div, article, .group").each((_, el) => {
      const linkEl = $(el).find("a[href*='/g/'], a[href*='/manga/']").first();
      const href = linkEl.attr("href") || "";
      if (!href) return;

      const title = $(el).find("h2, h3, .title, p.font-bold").first().text().trim() || linkEl.text().trim();
      const image = $(el).find("img").first().attr("src") || "";
      const slug = href.replace(DOUJIVA_SITE_BASE, "").replace(/^\/|\/$/g, "");

      if (title && slug) {
        results.push({
          title,
          image,
          detail_link: `${DOUJIVA_SITE_BASE}/${slug}`,
          type_genre: "doujinshi",
          update: "Full",
          rating: "5.0",
          slug,
        });
      }
    });

    return {
      success: true,
      query,
      meta: {
        currentPage: page,
        totalPages: 10,
        totalItems: results.length * 10,
      },
      data: results,
    };
  } catch (err) {
    console.error("❌ Doujiva search error:", err.message);
    return {
      success: true,
      query,
      meta: { currentPage: page, totalPages: 1, totalItems: 0 },
      data: [],
      warning: "Gagal melakukan pencarian Doujiva",
    };
  }
}

// =====================================================
// 🚀 ROUTE REGISTRATION
// =====================================================

module.exports = function registerDoujivaRoutes(app, { getCache, setCache, coalescedScrape }) {

  // ── IMAGE PROXY ──────────────────────────────────────
  app.get("/doujiva/image", async (req, res) => {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("No URL provided");
    }

    try {
      const decodedUrl = decodeURIComponent(url);
      
      const response = await axios.get(decodedUrl, {
        headers: {
          "Referer": DOUJIVA_SITE_BASE + "/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
        },
        responseType: "stream",
        timeout: 20000,
      });

      res.set({
        "Content-Type": response.headers["content-type"] || "image/jpeg",
        "Content-Length": response.headers["content-length"],
        "Cache-Control": "public, max-age=31536000",
      });

      response.data.pipe(res);
    } catch (err) {
      console.error(`[Doujiva Proxy Error] URL: ${url} | Error: ${err.message}`);
      res.status(err.response?.status || 500).send(err.message);
    }
  });

  // ── PUSTAKA ─────────────────────────────────────────
  app.get("/doujiva/pustaka", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const sort = req.query.sort || "latest";
    const cacheKey = `doujiva:pustaka:s:${sort}:p:${page}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeDoujivaPustaka({ page, sort });

        if (!result.success || !result.data.length) {
          return {
            success: true,
            page,
            total: 0,
            data: [],
            warning: "Data kosong / Doujiva limit",
          };
        }

        return {
          success: true,
          source: "doujiva.com",
          page,
          total: result.data.length,
          meta: result.meta,
          data: rewriteDoujivaImages(result.data, req),
        };
      });

      setCache(cacheKey, responseData, 120); // Cache 2 menit
      res.json(responseData);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── DETAIL ──────────────────────────────────────────
  app.get("/doujiva/detail/*", async (req, res) => {
    const slug = req.params[0];
    if (!slug) {
      return res.status(400).json({ success: false, message: "Slug tidak diberikan!" });
    }

    const cacheKey = `doujiva:detail:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeDoujivaDetail(slug);
        if (scraped.success) {
          scraped.data = rewriteDoujivaImages(scraped.data, req);
        }
        return scraped;
      });

      if (result && result.success) {
        setCache(cacheKey, result, 900); // Cache 15 menit
      }
      res.json(result);
    } catch (err) {
      console.error("Route error:", err.message);
      res.status(500).json({ success: false, message: "Terjadi kesalahan pada server" });
    }
  });

  // ── CHAPTER ─────────────────────────────────────────
  app.get("/doujiva/chapter/*", async (req, res) => {
    const fullSlug = req.params[0];
    if (!fullSlug) {
      return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap!" });
    }

    const parts = fullSlug.split("/").filter(Boolean);
    const seriesSlug = parts.length > 1 ? parts.slice(0, -1).join("/") : parts[0];
    const chapterSlug = fullSlug;

    const cacheKey = `doujiva:chapter:${chapterSlug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeDoujivaChapter(seriesSlug, chapterSlug);
        if (scraped.success) {
          return rewriteDoujivaImages(scraped, req);
        }
        return scraped;
      });

      if (result && result.success) {
        setCache(cacheKey, result, 7200); // Cache 2 jam
      }
      res.json(result);
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  // ── SEARCH ──────────────────────────────────────────
  app.get("/doujiva/search", async (req, res) => {
    const { q } = req.query;
    const page = parseInt(req.query.page) || 1;

    if (!q) {
      return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    }

    const cacheKey = `doujiva:search:${q}:p:${page}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeDoujivaSearch(q, page);
        if (result.success && result.data) {
          result.data = rewriteDoujivaImages(result.data, req);
        }
        return result;
      });

      setCache(cacheKey, responseData, 300); // Cache 5 menit
      res.json(responseData);
    } catch (err) {
      console.error("❌ Doujiva search route error:", err.message);
      res.status(200).json({
        success: true,
        query: q,
        meta: { currentPage: page, totalPages: 1, totalItems: 0 },
        data: [],
        warning: "Gagal search Doujiva",
      });
    }
  });

  console.log("✅ Doujiva routes registered: /doujiva/image, /doujiva/pustaka, /doujiva/detail/*, /doujiva/chapter/*, /doujiva/search");
};
