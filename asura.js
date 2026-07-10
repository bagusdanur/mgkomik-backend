/**
 * =====================================================
 * ⚡ SCRAPER ASURA SCANS - https://asurascans.com/
 * =====================================================
 * Menggunakan official REST API: https://api.asurascans.com
 * Tanpa parsing HTML, sangat stabil & cepat!
 * Output JSON menyamakan format scraper Kiryuu & Luvyaa
 * Ditambah image proxy untuk mem-bypass CDN Cloudflare
 * =====================================================
 */

const axios = require("axios");

const ASURA_API_BASE = "https://api.asurascans.com/api";
const ASURA_SITE_BASE = "https://asurascans.com";

// ===========================
// 🛠️ HELPER FUNCTIONS
// ===========================

function asuraHeaders(referer = ASURA_SITE_BASE + "/") {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8,en-US;q=0.7",
    Referer: referer,
    Origin: ASURA_SITE_BASE,
    Connection: "keep-alive",
  };
}

async function asuraFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${ASURA_API_BASE}${endpoint}`;
  const { data } = await axios.get(url, {
    headers: asuraHeaders(options.referer || ASURA_SITE_BASE + "/"),
    timeout: options.timeout || 20000,
  });
  return data;
}

function timeAgo(dateString) {
  if (!dateString) return "";
  try {
    const date = new Date(dateString);
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

function getRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function toAsuraBackendImageUrl(url, req) {
  if (!url) return "";
  return `${getRequestBaseUrl(req)}/asura/image?url=${encodeURIComponent(url)}`;
}

function rewriteAsuraImages(payload, req) {
  if (Array.isArray(payload)) {
    return payload.map((item) => rewriteAsuraImages(item, req));
  }
  if (!payload || typeof payload !== "object") return payload;

  const rewritten = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      rewritten[key] = value.map((img) => typeof img === "string" ? toAsuraBackendImageUrl(img, req) : img);
      continue;
    }
    if ((key === "image" || key === "thumbnail" || key === "cover") && typeof value === "string") {
      rewritten[key] = toAsuraBackendImageUrl(value, req);
      continue;
    }
    if (value && typeof value === "object") {
      rewritten[key] = rewriteAsuraImages(value, req);
      continue;
    }
    rewritten[key] = value;
  }
  return rewritten;
}

// =====================================================
// 📚 SCRAPER: PUSTAKA / LATEST UPDATES
// =====================================================

async function scrapeAsuraPustaka({ page = 1 } = {}) {
  try {
    const url = `/series?page=${page}&per_page=20&order=latest`;
    console.log("⚡ Asura pustaka API:", url);

    const response = await asuraFetch(url);
    const results = [];

    if (response && Array.isArray(response.data)) {
      for (const item of response.data) {
        const chapters = (item.latest_chapters || []).map(ch => ({
          title: `Chapter ${ch.number}`,
          link: `chapter/${item.slug}/${ch.slug}`,
          time: timeAgo(ch.published_at),
          locked: ch.is_locked || false,
        }));

        const latest = chapters[0] || {};
        const oldest = chapters[chapters.length - 1] || {};

        results.push({
          source: "asurascans",
          title: item.title || "",
          slug: item.slug || "",
          image: item.cover || "",
          detail_link: `${ASURA_SITE_BASE}${item.public_url || ""}`,
          description: item.description || "",
          type_genre: item.type || "manhwa",
          info: timeAgo(item.last_chapter_at),
          chapter_awal: oldest.title || "",
          chapter_terbaru: latest.title || "",
          chapters,
        });
      }
    }

    const totalPages = response.meta?.last_page || Math.ceil((response.meta?.total || 0) / 20) || 1;

    return {
      success: true,
      meta: {
        currentPage: page,
        totalPages: totalPages,
        totalItems: response.meta?.total || results.length,
      },
      data: results,
    };
  } catch (err) {
    console.error("❌ Asura pustaka error:", err.message);
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

async function scrapeAsuraDetail(slug) {
  try {
    const cleanSlug = slug.trim().replace(/\/$/, "");
    console.log("⚡ Asura detail API:", `/series/${cleanSlug}`);

    const [detailRes, chaptersRes] = await Promise.all([
      asuraFetch(`/series/${cleanSlug}`),
      asuraFetch(`/series/${cleanSlug}/chapters`)
    ]);

    const series = detailRes.series || {};
    const title = series.title || "";
    const thumbnail = series.cover || "";
    const status = series.status || "-";
    const type = series.type || "manhwa";
    const author = series.author || "-";
    const artist = series.artist || "-";
    const released = series.release_year || "-";
    const synopsis = series.description || "Tidak ada sinopsis.";

    const genres = (series.genres || []).map(g => g.name || g);

    const chapters = (chaptersRes.data || []).map(ch => ({
      title: ch.title || `Chapter ${ch.number}`,
      slug: ch.slug,
      link: `chapter/${cleanSlug}/${ch.slug}`,
      date: timeAgo(ch.published_at),
    }));

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
        synopsis,
        info: "",
        total_chapter: chapters.length,
        chapters,
      },
    };
  } catch (err) {
    console.error("❌ Asura detail error:", err.message);
    return {
      success: false,
      message: "Gagal scrape detail Asura.",
    };
  }
}

// =====================================================
// 🖼️ SCRAPER: CHAPTER IMAGES
// =====================================================

async function scrapeAsuraChapter(seriesSlug, chapterSlug) {
  try {
    const cleanSeriesSlug = seriesSlug.trim();
    const cleanChapterSlug = chapterSlug.trim();
    const url = `/series/${cleanSeriesSlug}/chapters/${cleanChapterSlug}`;
    console.log("⚡ Asura chapter API:", url);

    const response = await asuraFetch(url);
    const data = response.data || {};
    const chData = data.chapter || {};

    const title = chData.title || `Chapter ${chData.number}`;
    const images = (chData.pages || []).map(p => p.url).filter(Boolean);

    const prevUrl = data.prev_chapter ? data.prev_chapter.slug : null;
    const nextUrl = data.next_chapter ? data.next_chapter.slug : null;

    return {
      success: true,
      mangaId: cleanSeriesSlug,
      chapterSlug: cleanChapterSlug,
      currentChapter: title,
      prev: prevUrl,
      next: nextUrl,
      back_to_detail: cleanSeriesSlug,
      totalImages: images.length,
      images,
    };
  } catch (err) {
    console.error("❌ Asura chapter error:", err.message);
    return {
      success: false,
      message: err.message,
    };
  }
}

// =====================================================
// 🔍 SCRAPER: SEARCH
// =====================================================

async function scrapeAsuraSearch(query) {
  try {
    const url = `/series?page=1&per_page=30&search=${encodeURIComponent(query)}`;
    console.log("⚡ Asura search API:", url);

    const response = await asuraFetch(url);
    const results = [];

    if (response && Array.isArray(response.data)) {
      for (const item of response.data) {
        const latestChapter = item.latest_chapters?.[0];
        const updateText = latestChapter ? `Chapter ${latestChapter.number}` : "";

        results.push({
          title: item.title || "",
          image: item.cover || "",
          detail_link: `${ASURA_SITE_BASE}${item.public_url || ""}`,
          type_genre: item.type || "manhwa",
          update: updateText,
          rating: item.rating ? Number(item.rating).toFixed(1) : "0.0",
          slug: item.slug || "",
        });
      }
    }

    return {
      success: true,
      total: results.length,
      query,
      data: results,
    };
  } catch (err) {
    console.error("❌ Asura search error:", err.message);
    return {
      success: true,
      total: 0,
      query,
      data: [],
      warning: "Gagal melakukan pencarian Asura Scans",
    };
  }
}

// =====================================================
// 🚀 ROUTE REGISTRATION
// =====================================================

module.exports = function registerAsuraRoutes(app, { getCache, setCache, coalescedScrape }) {

  // ── IMAGE PROXY ──────────────────────────────────────
  app.get("/asura/image", async (req, res) => {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("No URL provided");
    }

    try {
      const decodedUrl = decodeURIComponent(url);
      
      const response = await axios.get(decodedUrl, {
        headers: {
          "Referer": ASURA_SITE_BASE + "/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
        },
        responseType: "stream",
        timeout: 20000,
      });

      res.set({
        "Content-Type": response.headers["content-type"],
        "Content-Length": response.headers["content-length"],
        "Cache-Control": "public, max-age=31536000",
      });

      response.data.pipe(res);
    } catch (err) {
      console.error(`[Asura Proxy Error] URL: ${url} | Error: ${err.message}`);
      res.status(err.response?.status || 500).send(err.message);
    }
  });

  // ── PUSTAKA ─────────────────────────────────────────
  app.get("/asura/pustaka", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `asura:pustaka:p:${page}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeAsuraPustaka({ page });

        if (!result.success || !result.data.length) {
          return {
            success: true,
            page,
            total: 0,
            data: [],
            warning: "Data kosong / Asura Scans limit",
          };
        }

        return {
          success: true,
          source: "asurascans.com",
          page,
          total: result.data.length,
          meta: result.meta,
          data: rewriteAsuraImages(result.data, req),
        };
      });

      setCache(cacheKey, responseData, 120); // Cache 2 menit
      res.json(responseData);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── DETAIL ──────────────────────────────────────────
  app.get("/asura/detail/:slug", async (req, res) => {
    const { slug } = req.params;
    if (!slug) {
      return res.status(400).json({ success: false, message: "Slug tidak diberikan!" });
    }

    const cacheKey = `asura:detail:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeAsuraDetail(slug);
        if (scraped.success) {
           scraped.data = rewriteAsuraImages(scraped.data, req);
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
  app.get("/asura/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const { seriesSlug, chapterSlug } = req.params;
    if (!seriesSlug || !chapterSlug) {
      return res.status(400).json({ success: false, message: "Slug series atau chapter tidak lengkap!" });
    }

    const cacheKey = `asura:chapter:${seriesSlug}:${chapterSlug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const scraped = await scrapeAsuraChapter(seriesSlug, chapterSlug);
        if (scraped.success) {
            return rewriteAsuraImages(scraped, req);
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
  app.get("/asura/search", async (req, res) => {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    }

    const cacheKey = `asura:search:${q}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeAsuraSearch(q);
        if (result.success && result.data) {
           result.data = rewriteAsuraImages(result.data, req);
        }
        return result;
      });

      setCache(cacheKey, responseData, 300); // Cache 5 menit
      res.json(responseData);
    } catch (err) {
      console.error("❌ Asura search route error:", err.message);
      res.status(200).json({
        success: true,
        total: 0,
        query: q,
        data: [],
        warning: "Gagal search Asura Scans",
      });
    }
  });

  console.log("✅ Asura scans routes registered: /asura/image, /asura/pustaka, /asura/detail/:slug, /asura/chapter/:seriesSlug/:chapterSlug, /asura/search");
};
