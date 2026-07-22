/**
 * =====================================================
 * Scraper route Doujiva, menggunakan sumber https://manga18.me/
 * =====================================================
 * Format output JSON disesuaikan dengan scraper Asura & Kiryuu
 * Memiliki fallback multi-strategi fetch + Image Proxy untuk CORS CDN
 * =====================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const DOUJIVA_SITE_BASE = "https://manga18.me";
const MANGA18_HOST = "manga18.me";
let manga18DnsCache = { addresses: [], expiresAt: 0 };

// ===========================
// 🛠️ HELPER FUNCTIONS
// ===========================

function doujivaHeaders(referer = DOUJIVA_SITE_BASE + "/") {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: referer,
    Connection: "keep-alive",
  };

  // cf_clearance is bound to the visitor IP and User-Agent. On a VPS it can
  // be supplied without hard-coding a short-lived cookie in the repository.
  if (process.env.DOUJIVA_COOKIE) {
    headers.Cookie = process.env.DOUJIVA_COOKIE;
  }
  return headers;
}

function isCloudflareChallenge(html = "") {
  return /Just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies|SITUS DIBLOKIR|Trustpositif/i.test(
    String(html)
  );
}

async function resolveManga18PublicDns() {
  if (manga18DnsCache.addresses.length && manga18DnsCache.expiresAt > Date.now()) {
    return manga18DnsCache.addresses;
  }
  const { data } = await axios.get("https://dns.google/resolve", {
    params: { name: MANGA18_HOST, type: "A" },
    headers: { Accept: "application/dns-json" },
    timeout: 10000,
  });
  const addresses = (data?.Answer || [])
    .filter((answer) => answer.type === 1 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(answer.data))
    .map((answer) => answer.data);
  if (!addresses.length) throw new Error("DNS publik Manga18 tidak menghasilkan alamat IPv4");
  manga18DnsCache = { addresses, expiresAt: Date.now() + 5 * 60 * 1000 };
  return addresses;
}

async function createManga18PublicDnsAgent() {
  const addresses = await resolveManga18PublicDns();
  let cursor = 0;
  return new https.Agent({
    lookup(hostname, options, callback) {
      if (hostname === MANGA18_HOST || hostname === `www.${MANGA18_HOST}`) {
        const address = addresses[cursor++ % addresses.length];
        if (options?.all) {
          return callback(null, [{ address, family: 4 }]);
        }
        return callback(null, address, 4);
      }
      require("dns").lookup(hostname, options, callback);
    },
  });
}

async function fetchManga18WithPublicDns(fullUrl, headers, timeout) {
  const agent = await createManga18PublicDnsAgent();
  const { data } = await axios.get(fullUrl, { headers, timeout, httpsAgent: agent });
  return data;
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

  // Strategi 2: DNS-over-HTTPS, untuk jaringan yang mengarahkan domain ke
  // halaman Trustpositif/Komdigi.
  try {
    const html = await fetchManga18WithPublicDns(fullUrl, headers, timeout);
    if (typeof html === "string" && html.trim() && !isCloudflareChallenge(html)) {
      console.log(`[Manga18] DNS publik berhasil untuk ${fullUrl}`);
      return html;
    }
    errors.push("public-dns:respons-diblokir");
  } catch (err) {
    errors.push(`public-dns:${err.response?.status || err.code || err.message}`);
  }

  // Strategi 3: Worker proxy
  const WORKER_PROXY = process.env.DOUJIVA_PROXY_URL || "https://proxy.kopipaitboskuh.workers.dev/?url=";
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

// =====================================================
// 📚 SCRAPER: PUSTAKA / LATEST UPDATES
// =====================================================

async function scrapeDoujivaPustaka({ page = 1, sort = "latest" } = {}) {
  try {
    const sortMap = { latest: "latest", alphabet: "alphabet", rating: "rating", trending: "trending" };
    const orderby = sortMap[sort] || "latest";
    const endpoint = page > 1 ? `/manga/${page}?orderby=${orderby}` : `/manga?orderby=${orderby}`;
    console.log("⚡ Doujiva pustaka:", endpoint);

    const html = await doujivaFetch(endpoint);
    const $ = cheerio.load(html);
    const results = [];

    $(".manga-listing-item .page-item-detail").each((_, el) => {
      const linkEl = $(el).find(".item-title a[href^='/manga/']").first();
      const href = linkEl.attr("href") || "";
      if (!href) return;

      const title = linkEl.text().replace(/\s+/g, " ").trim();
      const imgEl = $(el).find(".item-thumb img").first();
      const image = imgEl.attr("data-src") || imgEl.attr("src") || "";

      const slug = href.replace(DOUJIVA_SITE_BASE, "").replace(/^\/|\/$/g, "");
      const chapterEl = $(el).find(".chapter-item .chapter a").first();
      const chapterText = chapterEl.text().replace(/\s+/g, " ").trim() || "Chapter 1";
      const chapterHref = chapterEl.attr("href") || href;
      const rating = $(el).find(".item-rate [data-rating]").attr("data-rating") || $(el).find(".item-rate span").last().text().trim();

      if (title && slug) {
        results.push({
          source: "doujiva",
          title,
          slug,
          image,
          detail_link: href.startsWith("http") ? href : `${DOUJIVA_SITE_BASE}/${slug}`,
          description: "",
          type_genre: "doujinshi",
          info: rating ? `Rating ${rating}` : "Updated",
          chapter_awal: "Chapter 1",
          chapter_terbaru: chapterText,
          chapters: [
            {
              title: chapterText,
              link: `chapter/${chapterHref.replace(/^\/|\/$/g, "")}`,
              time: $(el).find(".chapter-item .post-on").first().text().trim() || "baru saja",
              locked: false,
            }
          ],
        });
      }
    });

    const pageNumbers = $(".pagination [data-page]").map((_, el) => Number($(el).attr("data-page")) + 1).get().filter(Number.isFinite);
    const totalPages = Math.max(page, ...pageNumbers);

    return {
      success: true,
      meta: {
        currentPage: page,
        totalPages,
        totalItems: results.length * totalPages,
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
    const endpoint = cleanSlug.startsWith("manga/") ? `/${cleanSlug}` : `/manga/${cleanSlug}`;
    console.log("⚡ Doujiva detail:", endpoint);

    const html = await doujivaFetch(endpoint);
    const $ = cheerio.load(html);

    const title = $(".manga-summary .post-title h1").first().text().replace(/\s+/g, " ").trim() || $("h1").first().text().trim();
    const coverEl = $(".manga-summary .summary_image img").first();
    const thumbnail = coverEl.attr("data-src") || coverEl.attr("src") || "";
    const synopsis = $(".panel-story-description .ss-manga").first().text().replace(/\s+/g, " ").trim() || $("meta[name='description']").attr("content") || "Tidak ada sinopsis.";

    const genres = [];
    $(".genres-content a[href^='/genre/']").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    const artist = $(".artist-content a").map((_, el) => $(el).text().trim()).get().filter(Boolean).join(", ") || "-";
    const author = $(".author-content a").map((_, el) => $(el).text().trim()).get().filter(Boolean).join(", ") || artist;
    const getField = (label) => {
      let value = "";
      $(".post-content_item").each((_, el) => {
        const heading = $(el).find(".summary-heading").text().replace(/\s+/g, " ").trim().toLowerCase();
        if (heading.startsWith(label.toLowerCase())) value = $(el).find(".summary-content").first().text().replace(/\s+/g, " ").trim();
      });
      return value;
    };
    const chapters = [];
    $(".row-content-chapter li").each((i, el) => {
      const anchor = $(el).find("a.chapter-name").first();
      const chHref = anchor.attr("href");
      const chTitle = anchor.text().replace(/\s+/g, " ").trim() || `Chapter ${i + 1}`;
      if (chHref) {
        const chSlug = chHref.replace(DOUJIVA_SITE_BASE, "").replace(/^\/|\/$/g, "");
        chapters.push({
          title: chTitle,
          slug: chSlug,
          link: `chapter/${chSlug}`,
          date: $(el).find(".chapter-time").text().trim() || "baru saja",
        });
      }
    });

    return {
      success: true,
      data: {
        title,
        thumbnail,
        type: "doujinshi",
        status: getField("status") || "Unknown",
        Pengarang: author,
        Umur: "18+",
        Konsep: getField("alternative") || "Manga18",
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
    const normalizeChapterSlug = (value = "") => value
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .replace(/^(?:doujiva\/)?chapter\//i, "");
    const cleanSeriesSlug = normalizeChapterSlug(seriesSlug);
    const cleanChapterSlug = normalizeChapterSlug(chapterSlug || cleanSeriesSlug);
    
    const endpoint = cleanChapterSlug.startsWith("manga/") ? `/${cleanChapterSlug}` : `/manga/${cleanChapterSlug}`;
    console.log("⚡ Doujiva chapter:", endpoint);

    const html = await doujivaFetch(endpoint);
    const $ = cheerio.load(html);

    const images = [];

    $(".read-content img, .reading-content img, #readerarea img").each((_, el) => {
      const src = $(el).attr("data-src")
        || $(el).attr("data-original")
        || $(el).attr("data-lazy-src")
        || $(el).attr("src");
      if (src && !images.includes(src)) {
        images.push(src);
      }
    });
    if (images.length === 0) {
      const matches = html.match(/https?:\\?\/\\?\/img-r\d+\.manga18\.me\\?\/[^"'<>\\\s]+?\.(?:jpe?g|png|webp)(?:\?[^"'<>\\\s]*)?/gi) || [];
      for (const match of matches) {
        const src = match.replace(/\\\//g, "/");
        if (!images.includes(src)) images.push(src);
      }
    }
    const title = $("h1").first().text().replace(/\s+/g, " ").trim() || $("title").text().split("-")[0].trim() || `Chapter ${cleanChapterSlug}`;
    const prevHref = $(".navi-change-chapter-btn-prev").first().attr("href") || "";
    const nextHref = $(".navi-change-chapter-btn-next").first().attr("href") || "";

    if (images.length === 0) {
      return {
        success: false,
        message: "Gambar chapter Manga18 tidak ditemukan",
      };
    }

    return {
      success: true,
      mangaId: cleanSeriesSlug,
      chapterSlug: cleanChapterSlug,
      currentChapter: title,
      prev: prevHref ? prevHref.replace(/^\/manga\//, "") : null,
      next: nextHref ? nextHref.replace(/^\/manga\//, "") : null,
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
    const endpoint = page > 1
      ? `/search/${page}?q=${encodeURIComponent(query)}`
      : `/search?q=${encodeURIComponent(query)}`;
    console.log("⚡ Doujiva search:", endpoint);

    const html = await doujivaFetch(endpoint);
    const $ = cheerio.load(html);
    const results = [];

    $(".manga-listing-item .page-item-detail").each((_, el) => {
      const linkEl = $(el).find(".item-title a[href^='/manga/']").first();
      const href = linkEl.attr("href") || "";
      if (!href) return;

      const title = linkEl.text().replace(/\s+/g, " ").trim();
      const imgEl = $(el).find(".item-thumb img").first();
      const image = imgEl.attr("data-src") || imgEl.attr("src") || "";
      const slug = href.replace(DOUJIVA_SITE_BASE, "").replace(/^\/|\/$/g, "");
      const rating = $(el).find(".item-rate [data-rating]").attr("data-rating") || $(el).find(".item-rate span").last().text().trim();

      if (title && slug) {
        results.push({
          title,
          image,
          detail_link: `${DOUJIVA_SITE_BASE}/${slug}`,
          type_genre: "doujinshi",
          update: $(el).find(".chapter-item .chapter a").first().text().trim() || "Updated",
          rating: rating || "0",
          slug,
        });
      }
    });

    const pageNumbers = $(".pagination [data-page]").map((_, el) => Number($(el).attr("data-page")) + 1).get().filter(Number.isFinite);
    const totalPages = Math.max(page, ...pageNumbers);
    return {
      success: true,
      query,
      meta: {
        currentPage: page,
        totalPages,
        totalItems: results.length * totalPages,
      },
      data: results,
    };
  } catch (err) {
    console.error("❌ Doujiva search error:", err.message);
    return {
      success: false,
      query,
      meta: { currentPage: page, totalPages: 1, totalItems: 0 },
      data: [],
      message: err.message,
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
      const parsedImageUrl = new URL(decodedUrl);
      const allowedImageHost = parsedImageUrl.hostname === MANGA18_HOST || parsedImageUrl.hostname.endsWith(`.${MANGA18_HOST}`);
      if (!allowedImageHost) {
        return res.status(400).send("URL gambar Manga18 tidak valid");
      }
      const requestOptions = {
        headers: doujivaHeaders(DOUJIVA_SITE_BASE + "/"),
        responseType: "stream",
        timeout: 20000,
      };
      if (parsedImageUrl.hostname === MANGA18_HOST || parsedImageUrl.hostname === `www.${MANGA18_HOST}`) {
        requestOptions.httpsAgent = await createManga18PublicDnsAgent();
      }
      const response = await axios.get(decodedUrl, requestOptions);

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

        if (!result.success) {
          return {
            success: false,
            page,
            total: 0,
            data: [],
            message: "Sumber Doujiva tidak dapat diakses",
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

      if (!responseData.success) {
        return res.status(502).json(responseData);
      }
      setCache(cacheKey, responseData, 120); // Cache 2 menit
      res.json(responseData);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── DETAIL ──────────────────────────────────────────
  app.get(/^\/doujiva\/detail\/(.+)/, async (req, res) => {
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
      res.status(result?.success ? 200 : 502).json(result);
    } catch (err) {
      console.error("Route error:", err.message);
      res.status(500).json({ success: false, message: "Terjadi kesalahan pada server" });
    }
  });

  // ── CHAPTER ─────────────────────────────────────────
  app.get(/^\/doujiva\/chapter\/(.+)/, async (req, res) => {
    const fullSlug = String(req.params[0] || "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/^(?:doujiva\/)?chapter\//i, "");
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
      res.status(result?.success ? 200 : 502).json(result);
    } catch (err) {
      res.status(502).json({ success: false, message: err.message });
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

      if (!responseData.success) {
        return res.status(502).json(responseData);
      }
      setCache(cacheKey, responseData, 300); // Cache 5 menit
      res.json(responseData);
    } catch (err) {
      console.error("❌ Doujiva search route error:", err.message);
      res.status(502).json({
        success: false,
        query: q,
        meta: { currentPage: page, totalPages: 1, totalItems: 0 },
        data: [],
        warning: "Gagal search Doujiva",
      });
    }
  });

  console.log("✅ Doujiva routes registered: /doujiva/image, /doujiva/pustaka, /doujiva/detail/*, /doujiva/chapter/*, /doujiva/search");
};
