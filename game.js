const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3015;

const GAME_BASE_URL = "https://androidadult.com";
const PROXY_URL =
  process.env.GAME_PROXY_URL || "https://proxy.kopipaitboskuh.workers.dev/?url=";

// Nonce Cache for Search
let cachedNonce = "";
let cachedNonceTime = 0;

async function getSearchNonce() {
  const now = Date.now();
  if (cachedNonce && (now - cachedNonceTime < 10 * 60 * 1000)) { // 10 minutes cache
    return cachedNonce;
  }
  
  try {
    const url = `https://androidadult.com/`;
    const { data } = await axios.get(PROXY_URL + encodeURIComponent(url));
    const nonceMatch = data.match(/"nonce":"([^"]+)"/);
    if (nonceMatch) {
      cachedNonce = nonceMatch[1];
      cachedNonceTime = now;
      return cachedNonce;
    }
  } catch (err) {
    console.error("Failed to get nonce:", err.message);
  }
  return null;
}

app.use(cors({ origin: "*" }));

// ==========================================
// 🛠️ HELPERS
// ==========================================

function gameUrl(path = "/") {
  if (!path) return "";
  if (path.startsWith("//")) return `https:${path}`;
  return path.startsWith("http") ? path : `${GAME_BASE_URL}${path}`;
}

function gameSlug(url) {
  try {
    return new URL(gameUrl(url)).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function normalizeImageUrl(url = "") {
  const value = String(url).trim();
  if (!value || value.startsWith("data:")) return "";
  try {
    if (value.startsWith("//")) return `https:${value}`;
    return value.startsWith("http") ? value : `${GAME_BASE_URL}${value}`;
  } catch {
    return "";
  }
}

function getImage(el, $) {
  const img = $(el);
  return normalizeImageUrl(
    img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("data-original") ||
      img.attr("src") ||
      ""
  );
}

// ==========================================
// 🌐 FETCH WITH PROXY
// ==========================================

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function gameFetch(url) {
  const targetUrl = gameUrl(url);
  const proxyUrl = `${PROXY_URL}${encodeURIComponent(targetUrl)}`;
  const headers = {
    "User-Agent": randomUA(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: GAME_BASE_URL,
  };

  // Coba proxy dulu
  try {
    const { data } = await axios.get(proxyUrl, { headers, timeout: 20000 });
    if (typeof data === "string" && data.trim()) return data;
  } catch (err) {
    console.log(`⚠️ Proxy gagal (${err.message}), coba direct...`);
  }

  // Fallback direct
  const { data } = await axios.get(targetUrl, { headers, timeout: 20000 });
  return data;
}

// ==========================================
// 💾 MEMORY CACHE
// ==========================================

const cache = new Map();

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data, ttlSeconds = 300) {
  cache.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
  if (cache.size > 500) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

// Bersihkan cache kadaluwarsa tiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of cache.entries()) {
    if (now > item.expiry) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ==========================================
// 🎮 SCRAPER: GAME TERBARU (LISTING + PAGINATION)
// ==========================================

function parsePlatforms($, el) {
  const platforms = [];
  $(el)
    .find(".iright .mtt img, .mtt img")
    .each((_, imgEl) => {
      const alt = ($(imgEl).attr("alt") || "").toLowerCase();
      if (alt.includes("android")) platforms.push("android");
      else if (alt.includes("mod")) platforms.push("mod");
      else if (alt.includes("pc")) platforms.push("pc");
    });
  return [...new Set(platforms)];
}

async function scrapeGameTerbaru({ page = 1 } = {}) {
  try {
    const cacheKey = `game-terbaru-${page}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const path = page === 1 ? "/" : `/page/${page}/`;
    const html = await gameFetch(path);
    const $ = cheerio.load(html);
    const results = [];

    // Parse carousel/featured games
    $(".carousel .game").each((_, el) => {
      const item = $(el);
      const anchor = item.find(".dl a").first();
      const detailPath = anchor.attr("href") || "";
      const title = item.find(".ginfo h3.tt").first().text().replace(/\s+/g, " ").trim();
      const bannerImg = getImage(item.find(".bimg img").first(), $);
      const thumbnail = normalizeImageUrl(
        item.find(".lgicon img").first().attr("data-src") ||
          item.find(".lgicon img").first().attr("src") ||
          ""
      );
      const engine =
        item.find(".engine").first().text().replace(/\s+/g, " ").trim() || "";
      const status =
        item
          .find(".enginestatus span")
          .not(".engine")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim() || "";
      const date = item.find("span.dt").first().text().replace(/\s+/g, " ").trim();
      const slug = gameSlug(detailPath);
      const isHot = item.find(".hotgames").length > 0;
      const platforms = parsePlatforms($, el);

      if (!title || !detailPath) return;

      results.push({
        source: "androidadult",
        title,
        slug,
        image: bannerImg,
        thumbnail,
        detail_link: gameUrl(detailPath),
        engine,
        status,
        date,
        platforms,
        is_hot: isHot,
      });
    });

    // Parse appitem listing (latest games grid) — di halaman page 2+
    $(".block .appitems .appitem, .updatedgames .appitem").each((_, el) => {
      const item = $(el);
      const anchor = item.find("> a").first();
      const href = anchor.attr("href") || "";

      // Skip ad items (external links)
      if (!href || !href.includes("androidadult.com")) return;

      const title = item.find(".appinfo h3.title").first().text().replace(/\s+/g, " ").trim();
      const thumbnail = normalizeImageUrl(
        item.find(".applogo img").first().attr("data-src") ||
          item.find(".applogo img").first().attr("src") ||
          ""
      );
      const version = item.find(".appinfo span.v").first().text().replace(/\s+/g, " ").trim();
      const isMod = item.find("span.mod").length > 0;
      const slug = gameSlug(href);

      if (!title || !slug) return;

      // Cek duplikat
      if (results.some((r) => r.slug === slug)) return;

      results.push({
        source: "androidadult",
        title,
        slug,
        image: thumbnail,
        thumbnail,
        detail_link: gameUrl(href),
        engine: "",
        status: "",
        date: "",
        version,
        platforms: isMod ? ["mod"] : [],
        is_hot: false,
      });
    });

    // Pagination
    const pages = [];
    $(".pagination a, .page-numbers").each((_, el) => {
      const pageNum = parseInt($(el).text().trim(), 10);
      if (!Number.isNaN(pageNum)) pages.push(pageNum);
    });
    const hasNextPage = $("a.next.page-numbers, .pagination a.next").length > 0;

    const result = {
      success: true,
      source: "androidadult.com",
      page,
      totalPages: pages.length ? Math.max(...pages) : hasNextPage ? page + 1 : page,
      total: results.length,
      data: results,
    };

    setCache(cacheKey, result, 300);
    return result;
  } catch (err) {
    console.error("Game terbaru error:", err.message);
    return {
      success: false,
      source: "androidadult.com",
      page,
      total: 0,
      data: [],
      message: "Gagal scrape halaman",
      error: err.message,
    };
  }
}

// ==========================================
// 🔥 SCRAPER: GAME TRENDING
// ==========================================

async function scrapeGameTrending() {
  try {
    const cacheKey = "game-trending";
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const html = await gameFetch("/");
    const $ = cheerio.load(html);
    const results = [];

    // Trending section: .block yang berisi h4 TRENDING
    $(".block")
      .filter((_, el) => $(el).find("h4").text().includes("TRENDING"))
      .find(".appitems .appitem")
      .each((_, el) => {
        const item = $(el);
        const anchor = item.find("> a").first();
        const href = anchor.attr("href") || "";

        // Skip external/ad links
        if (!href || !href.includes("androidadult.com")) return;

        const title = item.find(".appinfo h3.title").first().text().replace(/\s+/g, " ").trim();
        const thumbnail = normalizeImageUrl(
          item.find(".applogo img").first().attr("data-src") ||
            item.find(".applogo img").first().attr("src") ||
            ""
        );
        const version = item.find(".appinfo span.v").first().text().replace(/\s+/g, " ").trim();
        const isMod = item.find("span.mod").length > 0;
        const slug = gameSlug(href);

        if (!title || !slug) return;

        results.push({
          source: "androidadult",
          title,
          slug,
          image: thumbnail,
          thumbnail,
          detail_link: gameUrl(href),
          version,
          is_mod: isMod,
        });
      });

    const result = {
      success: true,
      source: "androidadult.com",
      total: results.length,
      data: results,
    };

    setCache(cacheKey, result, 300);
    return result;
  } catch (err) {
    console.error("Game trending error:", err.message);
    return {
      success: false,
      source: "androidadult.com",
      total: 0,
      data: [],
      message: "Gagal scrape trending",
      error: err.message,
    };
  }
}

// ==========================================
// 📄 SCRAPER: GAME DETAIL
// ==========================================

async function scrapeGameDetail(slug) {
  try {
    const cacheKey = `game-detail-${slug}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const detailPath = slug.startsWith("http") ? slug : `/${slug.replace(/^\/+/, "")}/`;
    const html = await gameFetch(detailPath);
    const $ = cheerio.load(html);

    // Title
    const title = $(".tinfo h2").first().text().replace(/\s+/g, " ").trim() ||
      $("h1").first().text().replace(/\s+/g, " ").trim() ||
      $("title").text().split("|")[0].trim();

    // Thumbnail
    const thumbnail = normalizeImageUrl(
      $(".tinfo img").first().attr("src") ||
        $(".tinfo img").first().attr("data-src") ||
        ""
    );

    // Banner
    const banner = normalizeImageUrl(
      $(".gbanner img").first().attr("src") ||
        $(".gbanner img").first().attr("data-src") ||
        ""
    );

    // Status
    const status = $(".tinfo .stat span.Ongoing, .tinfo .stat span.Completed")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    // Developer
    const developer = $(".tinfo .devtxt b a").first().text().replace(/\s+/g, " ").trim() ||
      $(".tinfo .devtxt b").first().text().replace(/\s+/g, " ").trim();

    // Description / excerpt
    const description = $(".excerpt").first().text().replace(/\s+/g, " ").trim();

    // Info spans (ENGINE, DOWNLOADS, UPDATED ON, ANIMATED, VOICED, UNCENSORED)
    const info = {};
    $(".minfo span").each((_, el) => {
      const label = $(el).find("b").first().text().replace(/\s+/g, " ").trim().toLowerCase();
      const value = $(el).find("p").first().text().replace(/\s+/g, " ").trim();
      if (label && value) info[label] = value;
    });

    // Tags / genres dari OG meta tags
    const tags = [];
    $('meta[property="article:tag"]').each((_, el) => {
      const tag = $(el).attr("content");
      if (tag) tags.push(tag);
    });

    // Screenshots dari gallery
    const screenshots = [];
    $(".gal img").each((_, el) => {
      const src = normalizeImageUrl(
        $(el).attr("data-src") || $(el).attr("data-lazy-src") || $(el).attr("src") || ""
      );
      if (src && !src.includes("lazy_placeholder")) screenshots.push(src);
    });

    // Download links with platform/category info
    const downloads = [];
    const dlHtml = $("input[name='getdownloadlinks']").attr("value");
    
    if (dlHtml) {
      const lines = dlHtml.split(/<br\s*\/?>|\n/i);
      let currentCategory = "";
      let currentPlatform = "";

      lines.forEach(line => {
        const lineStr = line.trim();
        if (!lineStr) return;
        
        const $line = cheerio.load(lineStr, null, false);
        const isCategory = lineStr.includes('color:') || ($line('span').length > 0 && !$line('a').length && !$line('b').text().includes('Win') && !$line('b').text().includes('Android'));
        
        if (isCategory) {
          const text = $line.text().trim();
          if (text) currentCategory = text;
        } else {
          let labelText = "";
          const firstAIndex = lineStr.indexOf('<a ');
          
          if (firstAIndex !== -1) {
            const prefixHtml = lineStr.substring(0, firstAIndex);
            labelText = cheerio.load(prefixHtml, null, false).text().replace(":", "").trim();
          } else {
            labelText = $line.text().split(":")[0].trim();
          }
          
          if (labelText && labelText.length < 50) {
            currentPlatform = labelText;
          }

          $line("a").each((_, el) => {
            const href = $line(el).attr("href") || "";
            const text = $line(el).text().replace(/\s+/g, " ").trim();
            if (href && text && !href.startsWith("#")) {
              downloads.push({ 
                name: text, 
                url: href,
                platform: currentPlatform,
                category: currentCategory
              });
            }
          });
        }
      });
    }

    // Fallback if the hidden input doesn't exist
    if (downloads.length === 0) {
      $(".downloadfiles a, #downloadfiles a, a.bgdownload").each((_, el) => {
        const href = $(el).attr("href") || "";
        const text = $(el).text().replace(/\s+/g, " ").trim();
        if (href && text && !href.startsWith("#")) {
          downloads.push({ name: text, url: href, platform: "", category: "" });
        }
      });
    }

    // Platform badges
    const platforms = [];
    $(".tinfo .iright .mtt img").each((_, el) => {
      const alt = ($(el).attr("alt") || "").toLowerCase();
      if (alt.includes("android")) platforms.push("android");
      else if (alt.includes("mod")) platforms.push("mod");
      else if (alt.includes("pc")) platforms.push("pc");
    });

    // Rating
    const ratingText = $(".glsr-star-rating").first().attr("data-rating") || "";

    // Updated date
    const updatedOn = info["updated on"] || "";

    // Translate description
    let description_id = description;
    try {
      const transUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=id&dt=t&q=${encodeURIComponent(description)}`;
      const { data } = await axios.get(transUrl);
      if (data && data[0]) {
        description_id = data[0].map((item) => item[0]).join("");
      }
    } catch (err) {
      console.log("⚠️ Gagal translate description:", err.message);
    }

    // Group downloads
    const groupedDownloads = {
      android: [],
      win: [],
      other: []
    };

    downloads.forEach(dl => {
      const p = (dl.platform || "").toLowerCase();
      if (p.includes("android") || p.includes("apk")) {
        groupedDownloads.android.push(dl);
      } else if (p.includes("win") || p.includes("pc")) {
        groupedDownloads.win.push(dl);
      } else {
        groupedDownloads.other.push(dl);
      }
    });

    const result = {
      success: true,
      source: "androidadult",
      data: {
        title,
        slug: gameSlug(detailPath),
        thumbnail,
        banner,
        status,
        developer,
        description: description_id,
        description_en: description,
        engine: info["engine"] || "",
        downloads_count: info["downloads"] || "",
        updated_on: updatedOn,
        animated: info["animated"] || "",
        voiced: info["voiced"] || "",
        uncensored: info["uncensored"] || "",
        rating: ratingText,
        tags,
        platforms: [...new Set(platforms)],
        screenshots,
        downloads: groupedDownloads,
      },
    };

    setCache(cacheKey, result, 600);
    return result;
  } catch (err) {
    console.error("Game detail error:", err.message);
    return {
      success: false,
      source: "androidadult",
      message: "Gagal scrape detail game",
      error: err.message,
    };
  }
}

// ==========================================
// 🔍 SCRAPER: SEARCH GAME
// ==========================================

const scrapeGameSearch = async (req, res) => {
  try {
    const { q, page = 1 } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, message: "Query 'q' is required" });
    }

    const nonce = await getSearchNonce();
    if (!nonce) {
      throw new Error("Gagal mengambil search nonce dari server");
    }

    const postData = new URLSearchParams({
      action: 'ags_search',
      nonce: nonce,
      q: q,
      page: page,
      orderby: 'relevance',
      order: 'DESC'
    }).toString();

    const ajaxUrl = "https://androidadult.com/wp-admin/admin-ajax.php";
    const { data } = await axios.post(PROXY_URL + encodeURIComponent(ajaxUrl), postData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (!data.success) {
      return res.json({
        success: true,
        source: "androidadult.com",
        query: q,
        page: parseInt(page),
        totalPages: 0,
        total: 0,
        data: []
      });
    }

    const searchData = data.data || {};
    const items = searchData.results || [];

    const parsedData = items.map(item => {
      let endpoint = "";
      let slug = "";
      if (item.permalink) {
        slug = item.permalink.replace(/\/$/, "").split("/").pop();
        endpoint = `/game/detail/${slug}`;
      }
      return {
        title: item.title,
        slug: slug,
        thumbnail: item.thumbnail,
        version: item.version || "",
        rating: item.rating || 0,
        engine: item.engine_name || "",
        tags: (item.tags || []).map(t => t.name),
        endpoint: endpoint
      };
    });

    res.json({
      success: true,
      source: "androidadult.com",
      query: q,
      page: parseInt(page),
      totalPages: searchData.max_pages || 1,
      total: searchData.total || 0,
      data: parsedData,
    });

  } catch (error) {
    console.error("Search Error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 🚀 EXPRESS ROUTES
// ==========================================

app.get("/", (_, res) => {
  res.json({
    success: true,
    source: "androidadult.com",
    endpoints: [
      "/game/terbaru?page=1",
      "/game/trending",
      "/game/detail/:slug",
      "/game/search?q=keyword&page=1",
    ],
  });
});

app.get("/game/terbaru", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = await scrapeGameTerbaru({ page });
  if (!result.success) return res.status(500).json(result);
  res.json(result);
});

app.get("/game/trending", async (_, res) => {
  const result = await scrapeGameTrending();
  if (!result.success) return res.status(500).json(result);
  res.json(result);
});

app.get("/game/detail/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) {
    return res.status(400).json({ success: false, message: "Slug tidak diberikan!" });
  }
  const result = await scrapeGameDetail(slug);
  if (!result.success) return res.status(500).json(result);
  res.json(result);
});

app.get("/game/search", scrapeGameSearch);

// ==========================================
// 🏃 START SERVER
// ==========================================

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🎮 Game scraper (androidadult.com) jalan di http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  scrapeGameTerbaru,
  scrapeGameTrending,
  scrapeGameDetail,
  scrapeGameSearch,
};
