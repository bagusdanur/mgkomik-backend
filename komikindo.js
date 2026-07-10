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

function isCloudflareChallenge(html = "") {
  return /Just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies/i.test(
    String(html),
  );
}

async function customFetch(url, options = {}) {
  const fullUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  const reqHeaders = headers(options.referer || BASE_URL + "/");
  const timeout = options.timeout || 20000;
  const errors = [];

  // Strategi 1: Axios direct
  try {
    const { data } = await axios.get(fullUrl, { headers: reqHeaders, timeout });
    if (typeof data === "string" && !isCloudflareChallenge(data)) {
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
      return html;
    }
    errors.push("cloudscraper:cloudflare-challenge");
  } catch (err) {
    errors.push(`cloudscraper:${err.message}`);
  }

  // Strategi 3: Worker proxy
  const WORKER_PROXY = process.env.KOMIKINDO_PROXY_URL || "https://proxy.kopipaitboskuh.workers.dev/";
  if (WORKER_PROXY) {
    try {
      const separator = WORKER_PROXY.endsWith("=") ? "" : (WORKER_PROXY.includes("?") ? "&url=" : "?url=");
      const workerUrl = `${WORKER_PROXY}${separator}${encodeURIComponent(fullUrl)}&referer=${encodeURIComponent(BASE_URL + "/")}`;
      const { data } = await axios.get(workerUrl, { timeout });
      if (typeof data === "string" && !isCloudflareChallenge(data)) {
        console.log(`[Komikindo] ✅ Worker proxy berhasil untuk ${fullUrl}`);
        return data;
      }
      errors.push("worker:cloudflare-challenge");
    } catch (err) {
      errors.push(`worker:${err.response?.status || err.code || err.message}`);
    }
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
  return `${req.protocol}://${req.get("host")}`;
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

async function scrapePustaka({ page = 1 } = {}) {
  try {
    const url =
      page === 1
        ? `${BASE_URL}/`
        : `${BASE_URL}/page/${page}/`;

    console.log("🌸 Komikindo pustaka URL:", url);

    const html = await customFetch(url);
    const $ = cheerio.load(html);
    const results = [];

    $(".listupd .uta, .listupd .bs").each((_, el) => {
      const link = $(el).find("a.series").first().attr("href") || $(el).find("a").first().attr("href") || "";
      if (!link) return;

      const title =
        $(el).find("h4").first().text().trim() ||
        $(el).find("a").first().attr("title") ||
        $(el).find(".tt").first().text().trim() ||
        "";

      const imgEl = $(el).find("img").first();
      let image = imgEl.attr("data-src") || imgEl.attr("data-lazy-src") || imgEl.attr("src") || "";
      if (image.startsWith("data:image")) {
        image = $(el).find("noscript img").first().attr("src") || image;
      }
      const typeGenre = extractTypeFromClass(el, $) || $(el).find('ul').attr('class') || "";

      const chapters = [];
      $(el)
        .find("ul li")
        .each((i, ch) => {
          const chLink = $(ch).find("a").attr("href") || "";
          const rawTitle = $(ch).find("a").text().trim();
          const chTitle = rawTitle.replace(/^🔒\s*/, "").trim();
          const rawTime = $(ch).find("span").text().trim();
          const chTime = translateTime(rawTime);
          const isLocked = rawTitle.startsWith("🔒");

          if (chLink && chTitle && !isLocked) {
            chapters.push({
              title: chTitle,
              link: chLink,
              time: chTime,
              locked: isLocked,
            });
          }
        });

      // Fallback if structure is .bs
      if (chapters.length === 0) {
        const latestChapText = $(el).find(".epxs").text().trim();
        if (latestChapText) {
          chapters.push({ title: latestChapText, time: "", link: "", locked: false });
        }
      }

      if (!title || !link) return;

      const slug = extractSlugFromUrl(link);
      const latest = chapters[0] || {};
      const oldest = chapters[chapters.length - 1] || {};

      results.push({
        source: "komikindo",
        title,
        slug,
        image,
        detail_link: link,
        description: "",
        type_genre: typeGenre,
        info: latest.time || "",
        chapter_awal: oldest.title || "",
        chapter_terbaru: latest.title || "",
        chapters,
      });
    });

    let totalPages = 1;
    const pages = [];
    $(".pagination a.page-numbers, .hpage a").each((_, el) => {
      const text = $(el).text().trim();
      if (/^\d+$/.test(text)) pages.push(parseInt(text));
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
    console.log("🌸 Komikindo detail URL:", url);
    const html = await customFetch(url, { referer: BASE_URL + "/" });
    const $ = cheerio.load(html);

    const title = $("h1.entry-title").first().text().trim();
    const thumbnailEl = $("img.wp-post-image").first().length ? $("img.wp-post-image").first() : $("div.thumb img").first();
    let thumbnail = thumbnailEl.attr("data-src") || thumbnailEl.attr("data-lazy-src") || thumbnailEl.attr("src") || "";
    if (thumbnail.startsWith("data:image")) {
      thumbnail = $("noscript img.wp-post-image").first().attr("src") || thumbnail;
    }

    const status = $(".imptdt:contains('Status') i").first().text().trim() || $("span.status-text").first().text().trim();

    const getMetaByLabel = (label) => {
      let result = "";
      $(".imptdt").each((_, el) => {
        const lbl = $(el).text().trim();
        if (lbl.includes(label)) {
          result = $(el).find("i").text().trim() || $(el).text().replace(label, "").trim();
        }
      });
      // Fallback to meta-item
      if (!result) {
        $(".meta-item").each((_, el) => {
          const lbl = $(el).find(".meta-label").text().trim();
          if (lbl === label) {
            result = $(el).find(".meta-pill").first().text().trim();
          }
        });
      }
      return result;
    };

    const type = getMetaByLabel("Type") || $(".imptdt:contains('Type') a").text().trim();
    const released = getMetaByLabel("Released") || getMetaByLabel("Posted On");
    const author = getMetaByLabel("Author") || $(".imptdt:contains('Author') i").text().trim();
    const artist = getMetaByLabel("Artist") || $(".imptdt:contains('Artist') i").text().trim();

    const genres = [];
    $(".mgen a, .meta-tags.mgen .meta-pill").each((_, el) => {
      const g = $(el).text().trim();
      if (g) genres.push(g);
    });

    const synopsis =
      $('[itemprop="description"]').first().text().trim() ||
      $(".entry-content").first().text().trim() ||
      "Tidak ada sinopsis.";

    let lockedUrls = [];
    const scriptTags = $("script").toArray();
    for (const script of scriptTags) {
      const scriptContent = $(script).html() || "";
      if (scriptContent.includes("var lockedUrls")) {
        const match = scriptContent.match(/var lockedUrls\s*=\s*(\[[^\]]*\]);/);
        if (match && match[1]) {
          try {
            const unescaped = match[1].replace(/\\\//g, "/");
            lockedUrls = JSON.parse(unescaped);
          } catch (e) {}
        }
        break;
      }
    }

    const chapters = [];
    $("#chapterlist ul li").each((_, el) => {
      const chLink = $(el).find("a").attr("href") || "";
      const chTitle = $(el).find("span.chapternum").text().trim();
      const chDate = $(el).find("span.chapterdate").text().trim();
      const chSlug = extractSlugFromUrl(chLink);

      if (chLink && chTitle && !lockedUrls.includes(chLink)) {
        chapters.push({
          title: chTitle,
          slug: chSlug,
          link: chLink,
          date: chDate,
        });
      }
    });

    chapters.reverse();

    return {
      success: true,
      data: {
        title: title || "",
        thumbnail: thumbnail || "",
        type: type || "",
        status: status || "-",
        Pengarang: author || "-",
        Umur: "-",
        Konsep: released || "-",
        artist: artist || "-",
        genres: genres || [],
        synopsis: synopsis || "",
        info: "",
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
    console.log("🌸 Komikindo chapter URL:", url);
    const html = await customFetch(url, { referer: BASE_URL + "/" });
    const $ = cheerio.load(html);

    const title = $("h1.entry-title").first().text().trim();

    let images = [];
    let prevUrl = null;
    let nextUrl = null;

    const scriptTags = $("script").toArray();
    for (const script of scriptTags) {
      const scriptContent = $(script).html() || "";
      if (scriptContent.includes("ts_reader.run(")) {
        const match = scriptContent.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
        if (match && match[1]) {
          try {
            const readerData = JSON.parse(match[1]);
            if (
              readerData.sources &&
              readerData.sources.length > 0 &&
              readerData.sources[0].images
            ) {
              images = readerData.sources[0].images;
            }
            prevUrl = readerData.prevUrl || null;
            nextUrl = readerData.nextUrl || null;
          } catch (parseErr) {
            console.warn("⚠️ Gagal parse ts_reader JSON:", parseErr.message);
          }
        }
        break;
      }
    }

    if (images.length === 0) {
      $("#readerarea img").each((i, el) => {
        const src = $(el).attr("src");
        if (src) images.push(src);
      });
      prevUrl = $(".nextprev a:contains('Prev')").attr("href") || null;
      nextUrl = $(".nextprev a:contains('Next')").attr("href") || null;
    }

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
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    console.log("🌸 Komikindo search URL:", searchUrl);

    const html = await customFetch(searchUrl, { referer: BASE_URL + "/" });
    const $ = cheerio.load(html);
    const results = [];

    $(".listupd .bs, .search-page-list .bs, .search-bixbox .bs").each((_, el) => {
      const link =
        $(el).find("a[href]").first().attr("href") || "";
      if (!link) return;

      const title =
        $(el).find("div.tt").first().text().trim() ||
        $(el).find("a[title]").first().attr("title") ||
        "";

      const imgEl = $(el).find("img").first();
      let image = imgEl.attr("data-src") || imgEl.attr("data-lazy-src") || imgEl.attr("src") || "";
      if (image.startsWith("data:image")) {
        image = $(el).find("noscript img").first().attr("src") || image;
      }
      const typeGenre = extractTypeFromClass(el, $) || $(el).find('ul').attr('class') || "";

      const statusEl = $(el).find("span.status").length ? $(el).find("span.status") : $(el).find(".epx");
      const statusText = statusEl.text().trim();
      const statusClass = (statusEl.attr("class") || "")
        .split(" ")
        .find((c) => c !== "status") || "";

      const latestChapter = $(el).find("div.epxs").text().trim();
      const rating = $(el).find("div.numscore").text().trim();
      const update =
        latestChapter && statusText
          ? `${latestChapter} • ${statusText}`
          : latestChapter || statusText || "";

      if (!title || !link) return;

      results.push({
        title,
        image,
        detail_link: link,
        type_genre: typeGenre,
        update,
        rating,
      });
    });

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
// 🚀 ROUTE REGISTRATION
// =====================================================

module.exports = function registerKomikindoRoutes(app, { getCache, setCache, coalescedScrape }) {

  // ── IMAGE PROXY ──────────────────────────────────────
  app.get("/komikid/image", async (req, res) => {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("No URL provided");
    }

    try {
      const decodedUrl = decodeURIComponent(url);
      const reqHeaders = headers(BASE_URL + "/");
      let imageBuffer, contentType;
      const errors = [];

      // Strategi 1: Direct Axios (Langsung tanpa worker proxy)
      try {
        const response = await axios.get(decodedUrl, {
          headers: reqHeaders,
          responseType: "arraybuffer",
          timeout: 15000,
        });
        const ct = response.headers["content-type"] || "";
        if (ct.startsWith("image/")) {
          imageBuffer = response.data;
          contentType = ct;
          console.log(`[Komikindo Proxy] ✅ Direct axios berhasil untuk ${decodedUrl}`);
        } else {
          errors.push("direct:bukan-image");
        }
      } catch (err) {
        errors.push(`direct:${err.response?.status || err.message}`);
      }

      // Strategi 2: Worker proxy
      if (!imageBuffer) {
        const WORKER_PROXY = process.env.KOMIKINDO_PROXY_URL || "https://proxy.kopipaitboskuh.workers.dev/";
        if (WORKER_PROXY) {
          try {
            const separator = WORKER_PROXY.endsWith("=") ? "" : (WORKER_PROXY.includes("?") ? "&url=" : "?url=");
            const workerUrl = `${WORKER_PROXY}${separator}${encodeURIComponent(decodedUrl)}&referer=${encodeURIComponent(BASE_URL + "/")}`;
            const response = await axios.get(workerUrl, {
              responseType: "arraybuffer",
              timeout: 15000,
            });
            const ct = response.headers["content-type"] || "";
            if (ct.startsWith("image/")) {
              imageBuffer = response.data;
              contentType = ct;
              console.log(`[Komikindo Proxy] ✅ Worker proxy berhasil untuk ${decodedUrl}`);
            } else {
              errors.push("worker:bukan-image");
            }
          } catch (err) {
            errors.push(`worker:${err.response?.status || err.message}`);
          }
        }
      }

      if (!imageBuffer) {
        console.error(`[Komikindo Proxy Error] Gagal fetch image: ${errors.join(" -> ")}`);
        return res.status(502).send("Gagal mengambil gambar dari sumber Komikindo");
      }

      res.set({
        "Content-Type": contentType,
        "Content-Length": imageBuffer.length,
        "Cache-Control": "public, max-age=31536000",
      });
      res.send(imageBuffer);
    } catch (err) {
      console.error(`[Komikindo Proxy Error] Fatal: ${err.message}`);
      res.status(500).send(err.message);
    }
  });

  // ── PUSTAKA ─────────────────────────────────────────
  app.get("/komikid/pustaka", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `komikindo:pustaka:p:${page}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
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
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
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
        setCache(cacheKey, result, 900);
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
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
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

  // ── SEARCH ──────────────────────────────────────────
  app.get("/komikid/search", async (req, res) => {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    }

    const cacheKey = `komikindo:search:${q}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
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

  console.log("✅ Komikindo routes registered: /komikid/image, /komikid/pustaka, /komikid/detail/:slug, /komikid/chapter/:slug, /komikid/search");
};
