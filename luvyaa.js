/**
 * =====================================================
 * 🌸 SCRAPER LUVYAA - https://v4.luvyaa.co/
 * =====================================================
 * Menggunakan axios + cheerio (tanpa Puppeteer)
 * Output JSON menyamakan format scraper Kiryuu
 * Ditambah image proxy untuk mem-bypass pemblokiran cdn-nyaa.link
 * =====================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");

const LUVYAA_BASE_URL = "https://v4.luvyaa.co";

// ===========================
// 🛠️ HELPER FUNCTIONS
// ===========================

function luvyaaHeaders(referer = LUVYAA_BASE_URL + "/") {
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

async function luvyaaFetch(url, options = {}) {
  const fullUrl = url.startsWith("http") ? url : `${LUVYAA_BASE_URL}${url}`;
  const headers = luvyaaHeaders(options.referer || LUVYAA_BASE_URL + "/");
  const timeout = options.timeout || 20000;
  const errors = [];

  // Strategi 1: Axios direct
  try {
    const { data } = await axios.get(fullUrl, { headers, timeout });
    if (typeof data === "string" && !isCloudflareChallenge(data)) {
      return data;
    }
    errors.push("axios:cloudflare-challenge");
  } catch (err) {
    errors.push(`axios:${err.response?.status || err.code || err.message}`);
  }

  // Strategi 2: Cloudscraper
  try {
    const html = await cloudscraper.get({ uri: fullUrl, headers, timeout });
    if (typeof html === "string" && html.trim() && !isCloudflareChallenge(html)) {
      console.log(`[Luvyaa] ✅ Cloudscraper berhasil untuk ${fullUrl}`);
      return html;
    }
    errors.push("cloudscraper:cloudflare-challenge");
  } catch (err) {
    errors.push(`cloudscraper:${err.message}`);
  }

  // Strategi 3: Worker proxy (akunncoc992)
  const WORKER_PROXY = process.env.LUVYAA_PROXY_URL || "https://proxy.akunncoc992.workers.dev/";
  if (WORKER_PROXY) {
    try {
      const workerUrl = `${WORKER_PROXY}${WORKER_PROXY.includes("?") ? "&" : "?"}url=${encodeURIComponent(fullUrl)}&referer=${encodeURIComponent(LUVYAA_BASE_URL + "/")}`;
      const { data } = await axios.get(workerUrl, { timeout });
      if (typeof data === "string" && !isCloudflareChallenge(data)) {
        console.log(`[Luvyaa] ✅ Worker proxy berhasil untuk ${fullUrl}`);
        return data;
      }
      errors.push("worker:cloudflare-challenge");
    } catch (err) {
      errors.push(`worker:${err.response?.status || err.code || err.message}`);
    }
  }

  console.error(`[Luvyaa] ❌ Semua strategi gagal untuk ${fullUrl}: ${errors.join(" -> ")}`);
  throw new Error(`Luvyaa fetch gagal: ${errors.join(" -> ")}`);
}

function extractSlugFromUrl(url = "") {
  if (!url) return "";
  return url.replace(LUVYAA_BASE_URL, "").replace(/^\/|\/$/g, "");
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
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function toLuvyaaBackendImageUrl(url, req) {
  if (!url) return "";
  return `${getRequestBaseUrl(req)}/luvyaa/image?url=${encodeURIComponent(url)}`;
}

function rewriteLuvyaaImages(payload, req) {
  if (Array.isArray(payload)) {
    return payload.map((item) => rewriteLuvyaaImages(item, req));
  }
  if (!payload || typeof payload !== "object") return payload;

  const rewritten = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      rewritten[key] = value.map((img) => typeof img === "string" ? toLuvyaaBackendImageUrl(img, req) : img);
      continue;
    }
    if ((key === "image" || key === "thumbnail") && typeof value === "string") {
      rewritten[key] = toLuvyaaBackendImageUrl(value, req);
      continue;
    }
    if (value && typeof value === "object") {
      rewritten[key] = rewriteLuvyaaImages(value, req);
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

async function scrapeLuvyaaPustaka({ page = 1 } = {}) {
  try {
    const url =
      page === 1
        ? "https://v4.luvyaa.co/"
        : `https://v4.luvyaa.co/page/${page}/`;

    console.log("🌸 Luvyaa pustaka URL:", url);

    const html = await luvyaaFetch(url);
    const $ = cheerio.load(html);
    const results = [];

    $(".latest-update-box .utao, .listupd .utao").each((_, el) => {
      const link = $(el).find("a.series").first().attr("href") || "";
      if (!link) return;

      const title =
        $(el).find("a.series h4").first().text().trim() ||
        $(el).find("a.series").first().attr("title") ||
        "";

      const image = $(el).find("div.imgu img").first().attr("src") || "";
      const typeGenre = extractTypeFromClass(el, $);

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

      if (!title || !link) return;

      const slug = extractSlugFromUrl(link);
      const latest = chapters[0] || {};
      const oldest = chapters[chapters.length - 1] || {};

      results.push({
        source: "luvyaa",
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
    console.error("❌ Luvyaa pustaka error:", err.message);
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

async function scrapeLuvyaaDetail(url) {
  try {
    console.log("🌸 Luvyaa detail URL:", url);
    const html = await luvyaaFetch(url, { referer: LUVYAA_BASE_URL + "/" });
    const $ = cheerio.load(html);

    const title = $("h1.entry-title").first().text().trim();
    const thumbnail =
      $("img.wp-post-image").first().attr("src") ||
      $("div.thumb img").first().attr("src") ||
      "";

    const status = $("span.status-text").first().text().trim();

    const getMetaByLabel = (label) => {
      let result = "";
      $(".meta-item").each((_, el) => {
        const lbl = $(el).find(".meta-label").text().trim();
        if (lbl === label) {
          result = $(el).find(".meta-pill").first().text().trim();
        }
      });
      return result;
    };

    const type = getMetaByLabel("Type");
    const released = getMetaByLabel("Released");
    const author = getMetaByLabel("Author");
    const artist = getMetaByLabel("Artist");

    const genres = [];
    $(".meta-tags.mgen .meta-pill").each((_, el) => {
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
            // Hilangkan backslash escaping sebelum parsing JSON
            const unescaped = match[1].replace(/\\\//g, "/");
            lockedUrls = JSON.parse(unescaped);
          } catch (e) {}
        }
        break;
      }
    }

    const chapters = [];
    $("#chapterlist ul.clstyle li").each((_, el) => {
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
    console.error("❌ Luvyaa detail error:", err.message);
    return {
      success: false,
      message: "Gagal scrape detail.",
    };
  }
}

// =====================================================
// 🖼️ SCRAPER: CHAPTER IMAGES
// =====================================================

async function scrapeLuvyaaChapter(url) {
  try {
    console.log("🌸 Luvyaa chapter URL:", url);
    const html = await luvyaaFetch(url, { referer: LUVYAA_BASE_URL + "/" });
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

    const cleanNavLink = (link) => {
      if (!link) return null;
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
      back_to_detail: `${LUVYAA_BASE_URL}/${mangaId}/`,
      totalImages: images.length,
      images,
    };
  } catch (err) {
    console.error("❌ Luvyaa chapter error:", err.message);
    return {
      success: false,
      message: err.message,
    };
  }
}

// =====================================================
// 🔍 SCRAPER: SEARCH
// =====================================================

async function scrapeLuvyaaSearch(query) {
  try {
    const searchUrl = `${LUVYAA_BASE_URL}/?s=${encodeURIComponent(query)}`;
    console.log("🌸 Luvyaa search URL:", searchUrl);

    const html = await luvyaaFetch(searchUrl, { referer: LUVYAA_BASE_URL + "/" });
    const $ = cheerio.load(html);
    const results = [];

    $(".search-page-list .bs, .search-bixbox .bs").each((_, el) => {
      const link =
        $(el).find("a[href]").first().attr("href") || "";
      if (!link) return;

      const title =
        $(el).find("div.tt").first().text().trim() ||
        $(el).find("a[title]").first().attr("title") ||
        "";

      const image = $(el).find("img.ts-post-image").first().attr("src") || "";
      const typeGenre = extractTypeFromClass(el, $);

      const statusEl = $(el).find("span.status");
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
    console.error("❌ Luvyaa search error:", err.message);
    return {
      success: true,
      total: 0,
      query,
      data: [],
      warning: "Gagal melakukan pencarian Luvyaa",
    };
  }
}

// =====================================================
// 🎛️ SCRAPER: FILTER OPTIONS (genre / status / type / order)
// =====================================================
async function scrapeLuvyaaFilters() {
  try {
    const html = await luvyaaFetch(`/manga/?order=update`);
    const $ = cheerio.load(html);

    const collectRadios = (name) => {
      const out = [];
      $(`input[name="${name}"]`).each((_, el) => {
        const value = $(el).attr("value") || "";
        const id = $(el).attr("id");
        const label = (id ? $(`label[for="${id}"]`).text().trim() : "") || $(el).parent().text().trim();
        if (label) out.push({ value, label });
      });
      return out;
    };

    const genre = [];
    $('input[name="genre[]"]').each((_, el) => {
      const value = $(el).attr("value") || "";
      const id = $(el).attr("id");
      const label = (id ? $(`label[for="${id}"]`).text().trim() : "") || $(el).parent().text().trim();
      if (value && label) genre.push({ value, label });
    });

    return {
      tipe: [{ value: "", label: "Tipe" }, ...collectRadios("type").filter((o) => o.value)],
      status: [{ value: "", label: "Status" }, ...collectRadios("status").filter((o) => o.value)],
      genre: [{ value: "", label: "Genre 1" }, ...genre],
      genre2: [{ value: "", label: "Genre 2" }, ...genre],
      orderby: collectRadios("order"),
    };
  } catch (err) {
    console.error("❌ Luvyaa filter scrape error:", err.message);
    return {};
  }
}

// =====================================================
// 📚 SCRAPER: PUSTAKA WITH FILTER (Themesia archive)
// =====================================================
async function scrapeLuvyaaPustakaFilter({ orderby, tipe, genre, genre2, status, page = 1 } = {}) {
  try {
    const params = new URLSearchParams();
    if (genre) params.append("genre[]", genre);
    if (genre2) params.append("genre[]", genre2);
    if (status) params.append("status", status);
    if (tipe) params.append("type", tipe);
    if (orderby) params.append("order", orderby);
    if (page > 1) params.append("page", String(page));

    const url = `/manga/?${params.toString()}`;
    console.log("🌸 Luvyaa filter URL:", LUVYAA_BASE_URL + url);

    const html = await luvyaaFetch(url);
    const $ = cheerio.load(html);
    const results = [];

    $(".listupd .bsx").each((_, el) => {
      const $el = $(el);
      const link = $el.find("a[href]").first().attr("href") || "";
      if (!link) return;

      const title =
        $el.find("a[title]").first().attr("title") ||
        $el.find("div.tt").first().text().trim() ||
        "";

      const imgEl = $el.find("img").first();
      let image = imgEl.attr("data-src") || imgEl.attr("data-lazy-src") || imgEl.attr("src") || "";
      if (image.startsWith("data:image")) {
        image = $el.find("noscript img").first().attr("src") || image;
      }

      const typeGenre = extractTypeFromClass(el, $) || $el.find("span.type").text().trim() || "";
      const latestChapter = $el.find("div.epxs").text().trim();
      const rating = $el.find("div.numscore").text().trim();

      if (!title || !link) return;

      const slug = extractSlugFromUrl(link);
      results.push({
        source: "luvyaa",
        title,
        slug,
        image,
        detail_link: link,
        type_genre: typeGenre,
        info: latestChapter || (rating ? `⭐ ${rating}` : ""),
        chapter_terbaru: latestChapter || "",
      });
    });

    const hasNext =
      $(".pagination a.next, .hpage a.r").length > 0 ||
      $(`.pagination a.page-numbers:contains("${page + 1}")`).length > 0;

    return { data: results, hasMore: hasNext && results.length > 0 };
  } catch (err) {
    console.error("❌ Luvyaa pustaka-filter error:", err.message);
    return { data: [], hasMore: false };
  }
}

// =====================================================
// 🚀 ROUTE REGISTRATION
// =====================================================

module.exports = function registerLuvyaaRoutes(app, { getCache, setCache, coalescedScrape, getImageCache, setImageCache }) {

  // ── IMAGE PROXY ──────────────────────────────────────
  const LUVYAA_PLACEHOLDER_SVG = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400" fill="#18181b">
      <rect width="300" height="400" fill="#18181b"/>
      <circle cx="150" cy="170" r="30" fill="#27272a"/>
      <path d="M140 160l20 20M160 160l-20 20" stroke="#71717a" stroke-width="3" stroke-linecap="round"/>
      <text x="150" y="230" text-anchor="middle" fill="#a1a1aa" font-family="system-ui, sans-serif" font-size="14" font-weight="600">Gambar Tidak Tersedia</text>
      <text x="150" y="250" text-anchor="middle" fill="#71717a" font-family="system-ui, sans-serif" font-size="11">Luvyaa CDN 404 / expired</text>
    </svg>`
  );

  app.get("/luvyaa/image", async (req, res) => {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("No URL provided");
    }

    try {
      const decodedUrl = decodeURIComponent(url);

      const cached = getImageCache(decodedUrl);
      if (cached) {
        return res.set('Content-Type', cached.contentType).set('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800').send(cached.buffer);
      }

      const headers = luvyaaHeaders(LUVYAA_BASE_URL + "/");
      let imageBuffer, contentType = "image/jpeg";
      const errors = [];

      // Strategi 1: Direct Axios (Tercepat untuk cdn-nyaa.link & v4.luvyaa.co)
      try {
        const response = await axios.get(decodedUrl, {
          headers,
          responseType: "arraybuffer",
          timeout: 6000,
        });
        const ct = response.headers["content-type"] || "";
        if (ct.startsWith("image/") && response.data && response.data.length > 500) {
          imageBuffer = response.data;
          contentType = ct;
        } else {
          errors.push("direct:bukan-image");
        }
      } catch (err) {
        errors.push(`direct:${err.response?.status || err.message}`);
      }

      // Strategi 2: Cloudscraper
      if (!imageBuffer) {
        try {
          const csResult = await cloudscraper.get({
            uri: decodedUrl,
            headers,
            encoding: null,
            timeout: 8000,
          });
          if (Buffer.isBuffer(csResult) && csResult.length > 500) {
            imageBuffer = csResult;
            if (csResult[0] === 0xFF && csResult[1] === 0xD8) contentType = "image/jpeg";
            else if (csResult[0] === 0x89) contentType = "image/png";
            else if (csResult[0] === 0x52) contentType = "image/webp";
            else if (csResult[0] === 0x47) contentType = "image/gif";
          } else {
            errors.push("cloudscraper:response-terlalu-kecil");
          }
        } catch (err) {
          errors.push(`cloudscraper:${err.message}`);
        }
      }

      // Strategi 3: Worker proxy
      if (!imageBuffer) {
        const WORKER_PROXY = process.env.LUVYAA_PROXY_URL || "https://proxy.akunncoc992.workers.dev/";
        if (WORKER_PROXY) {
          try {
            const sep = WORKER_PROXY.includes("?") ? "&" : "?";
            const workerUrl = `${WORKER_PROXY}${sep}url=${encodeURIComponent(decodedUrl)}&referer=${encodeURIComponent(LUVYAA_BASE_URL + "/")}`;
            const response = await axios.get(workerUrl, {
              responseType: "arraybuffer",
              timeout: 8000,
            });
            const ct = response.headers["content-type"] || "";
            if (ct.startsWith("image/") && response.data && response.data.length > 500) {
              imageBuffer = response.data;
              contentType = ct;
            } else {
              errors.push("worker:bukan-image");
            }
          } catch (err) {
            errors.push(`worker:${err.response?.status || err.message}`);
          }
        }
      }

      if (!imageBuffer) {
        console.warn(`[Luvyaa Proxy Fallback] Mengembalikan placeholder untuk ${decodedUrl} (${errors.join(" -> ")})`);
        res.set({
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
        });
        return res.status(200).send(LUVYAA_PLACEHOLDER_SVG);
      }

      res.set({
        "Content-Type": contentType,
        "Content-Length": imageBuffer.length,
        "Cache-Control": "public, max-age=2592000, s-maxage=2592000",
      });
      setImageCache(decodedUrl, imageBuffer, contentType);
      res.send(imageBuffer);
    } catch (err) {
      console.error(`[Luvyaa Proxy Error] Fatal: ${err.message}`);
      res.set({
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      });
      res.status(200).send(LUVYAA_PLACEHOLDER_SVG);
    }
  });

  // ── PUSTAKA ─────────────────────────────────────────
  app.get("/luvyaa/pustaka", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `luvyaa:pustaka:p:${page}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeLuvyaaPustaka({ page });

        if (!result.data.length) {
          return {
            success: true,
            page,
            total: 0,
            data: [],
            warning: "Data kosong / Luvyaa limit",
          };
        }

        return {
          success: true,
          source: "v4.luvyaa.co",
          page,
          total: result.data.length,
          meta: result.meta,
          data: rewriteLuvyaaImages(result.data, req),
        };
      });

      setCache(cacheKey, responseData, 60);
      res.json(responseData);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── DETAIL ──────────────────────────────────────────
  app.get("/luvyaa/detail/:slug", async (req, res) => {
    const { slug } = req.params;
    if (!slug) {
      return res.status(400).json({ success: false, message: "Slug tidak diberikan!" });
    }

    const cacheKey = `luvyaa:detail:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const fullUrl = `${LUVYAA_BASE_URL}/${slug}/`;
        const scraped = await scrapeLuvyaaDetail(fullUrl);
        if (scraped.success) {
           scraped.data = rewriteLuvyaaImages(scraped.data, req);
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
  app.get(/^\/luvyaa\/chapter\/(.+)/, async (req, res) => {
    const slug = req.params[0];
    const cacheKey = `luvyaa:chapter:${slug}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const result = await coalescedScrape(cacheKey, async () => {
        const fullUrl = `${LUVYAA_BASE_URL}/${slug}/`;
        const scraped = await scrapeLuvyaaChapter(fullUrl);
        if (scraped.success) {
           return rewriteLuvyaaImages(scraped, req);
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

  // ── FILTER OPTIONS ──────────────────────────────────
  app.get("/luvyaa/filters", async (req, res) => {
    const cacheKey = "luvyaa:filters";
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const data = await scrapeLuvyaaFilters();
        return { success: true, data };
      });
      setCache(cacheKey, responseData, 43200); // 12 jam
      res.json(responseData);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── PUSTAKA FILTER ──────────────────────────────────
  app.get("/luvyaa/pustaka-filter", async (req, res) => {
    try {
      const { orderby, tipe, genre, genre2, status } = req.query;
      const page = Math.max(1, parseInt(req.query.page) || 1);

      const cacheKey = `luvyaa:pustaka-filter:o:${orderby}:t:${tipe}:g:${genre}:g2:${genre2}:s:${status}:p:${page}`;
      const cached = getCache(cacheKey);
      if (cached) {
        console.log(`⚡ [Cache Hit] ${cacheKey}`);
        return res.json(cached);
      }

      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeLuvyaaPustakaFilter({ orderby, tipe, genre, genre2, status, page });
        return {
          success: true,
          query: { page, orderby, tipe, genre, genre2, status },
          data: rewriteLuvyaaImages(result.data, req),
          hasMore: result.hasMore,
        };
      });

      setCache(cacheKey, responseData, 60); // 1 menit
      res.json(responseData);
    } catch (err) {
      console.error("❌ Luvyaa pustaka-filter route error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── SEARCH ──────────────────────────────────────────
  app.get("/luvyaa/search", async (req, res) => {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    }

    const cacheKey = `luvyaa:search:${q}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      return res.json(cached);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const result = await scrapeLuvyaaSearch(q);
        if (result.success && result.data) {
           result.data = rewriteLuvyaaImages(result.data, req);
        }
        return result;
      });

      setCache(cacheKey, responseData, 60);
      res.json(responseData);
    } catch (err) {
      console.error("❌ Luvyaa search route error:", err.message);
      res.status(200).json({
        success: true,
        total: 0,
        query: q,
        data: [],
        warning: "Gagal search Luvyaa",
      });
    }
  });

  console.log("✅ Luvyaa routes registered: /luvyaa/image, /luvyaa/pustaka, /luvyaa/detail/:slug, /luvyaa/chapter/:slug, /luvyaa/search, /luvyaa/filters, /luvyaa/pustaka-filter");
};
