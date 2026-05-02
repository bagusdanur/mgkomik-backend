const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const app = express();
const cors = require("cors");
const PORT = process.env.PORT || 3012;

app.use(cors({ origin: "*" }));

const BASE_URL = "https://s13.nontonanimeid.boats";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ✅ FIX 1: Timeout lebih pendek (8 detik)
const axiosInstance = axios.create({
  timeout: 8000,
  headers: {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  },
});

// ✅ FIX 2: Retry lebih cepat, delay lebih pendek
async function fetchRetry(url, options = {}, retries = 2) {
  try {
    return await axiosInstance.get(url, {
      ...options,
      headers: {
        ...options.headers,
        "User-Agent": randomUA(),
        "Referer": BASE_URL + "/",
      },
    });
  } catch (err) {
    if (retries <= 0) throw err;

    const delay = err.response?.status === 403 ? 1500 : 500;
    console.log(`🔁 Retry (${retries} left) [${err.response?.status || err.code}]: ${url}`);
    await sleep(delay);
    return fetchRetry(url, options, retries - 1);
  }
}

// ✅ FIX 3: Cache pakai key yang benar per slug
const cache = new Map();

function setCache(key, data, ttl = 300) {
  cache.set(key, { data, expire: Date.now() + ttl * 1000 });
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expire) { cache.delete(key); return null; }
  return item.data;
}

// ================= HELPERS =================
const extractSlug = (href) => {
  if (!href) return "";
  return href.replace(/\/$/, "").split("/").pop();
};

function buildUrl(slug) { return `${BASE_URL}/${slug}/`; }
function buildAnimeUrl(slug) { return `${BASE_URL}/anime/${slug}/`; }

// ================= SCRAPER: ONGOING =================
async function scrapeNontonAnimeOngoing() {
  try {
    const res = await fetchRetry(`${BASE_URL}/ongoing-list/`);
    const $ = cheerio.load(res.data);

    const items = [];
    $(".gacha-grid .gacha-card").each((i, el) => {
      const href = $(el).attr("href") || "";
      items.push({
        title: $(el).find(".info-panel .title").text().trim(),
        thumbnail: $(el).find(".image-area img").attr("src") || "",
        slug: extractSlug(href),
        rarity: ($(el).attr("class") || "").match(/rarity-(\d+)/)?.[1] || null,
        isHot: $(el).find(".hot-tag").length > 0,
        currentEpisode: parseInt($(el).find(".current-ep").text()) || null,
        totalEpisode: $(el).find(".total-ep").text() === "?" ? null : parseInt($(el).find(".total-ep").text()) || null,
      });
    });

    return {
      success: true,
      season: {
        name: $(".as-season-name").text().trim(),
        progress: $(".as-season-percentage").text().trim(),
      },
      total: items.length,
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape: " + err.message };
  }
}

async function scrapeNontonAnimeDetail(url) {
  try {
    const res = await fetchRetry(url);
    const $ = cheerio.load(res.data);
    const article = $("article");

    const genres = [];
    article.find(".anime-card__genres .genre-tag").each((i, el) => {
      genres.push({ name: $(el).text().trim(), slug: extractSlug($(el).attr("href")) });
    });

    const details = {};
    article.find(".details-list li").each((i, el) => {
      const label = $(el).find(".detail-label").text().replace(":", "").trim();
      if (!label || $(el).hasClass("detail-separator")) return;
      const value = $(el).clone().children(".detail-label").remove().end().text().trim();
      if (label && value) details[label] = value;
    });

    // ================= HARDCODE 1-28 + REAL DATA =================
    const baseSlug = extractSlug(url); // "digimon-beatbreak"
    const episodeList = [];

    // 1. Real episodes dari HTML (dengan date)
    article.find(".episode-list-items .episode-item").each((i, el) => {
      const slug = extractSlug($(el).attr("href") || "");
      const epNum = parseInt(slug.match(/episode-(\d+)$/)?.[1] || 0);
      
      episodeList[epNum - 1] = {  // index 0 = ep1
        title: $(el).find(".ep-title").text().trim(),
        date: $(el).find(".ep-date").text().trim(),
        slug,
        source: "html"
      };
    });

    // ================= DYNAMIC TOTAL & SLUG PATTERN =================

// ================= DYNAMIC TOTAL & SLUG PATTERN =================

// 1. Extract pattern dari first/last episode
const firstEpEl = article.find(".meta-episode-item.first a");
const lastEpEl = article.find(".meta-episode-item.last a");

let slugPattern = extractSlug(url); // fallback: "shingeki-no-kyojin"
let totalEpisodes = 1; // default

if (lastEpEl.length) {
  const lastSlug = extractSlug(lastEpEl.attr("href") || "");
  // Extract pattern: shingeki-no-kyojin-s1
  const match = lastSlug.match(/(.+?)(?:-s\d+-|-episode-|ep-)(\d+)$/);
  if (match) {
    slugPattern = match[1]; // shingeki-no-kyojin-s1
    totalEpisodes = parseInt(match[2]); // 25
  }
}

console.log(`📊 Pattern: "${slugPattern}", Total: ${totalEpisodes}`);



// 2. Real episodes dari HTML
article.find(".episode-list-items .episode-item").each((i, el) => {
  const slug = extractSlug($(el).attr("href") || "");
  const epNum = parseInt(slug.match(/(\d+)$/)?.[1] || 0);
  if (epNum > 0 && epNum <= totalEpisodes) {
    episodeList[epNum - 1] = {
      title: $(el).find(".ep-title").text().trim(),
      date: $(el).find(".ep-date").text().trim(),
      slug,
      source: "html"
    };
  }
});

// 3. First & Last
if (firstEpEl.length) {
  const slug = extractSlug(firstEpEl.attr("href") || "");
  const epNum = parseInt(slug.match(/(\d+)$/)?.[1] || 1);
  if (epNum > 0 && epNum <= totalEpisodes) {
    episodeList[epNum - 1] = {
      title: firstEpEl.clone().children(".ep-label, .watched-status").remove().end().text().trim(),
      date: "",
      slug,
      source: "meta"
    };
  }
}

if (lastEpEl.length) {
  const slug = extractSlug(lastEpEl.attr("href") || "");
  const epNum = parseInt(slug.match(/(\d+)$/)?.[1] || totalEpisodes);
  if (epNum > 0 && epNum <= totalEpisodes) {
    episodeList[epNum - 1] = {
      title: lastEpEl.clone().children(".ep-label, .watched-status").remove().end().text().trim(),
      date: "",
      slug,
      source: "meta"
    };
  }
}

// 4. HARDCODE dengan CORRECT pattern
for (let i = 1; i <= totalEpisodes; i++) {
  if (!episodeList[i - 1]) {
    const targetSlug = `${slugPattern}-episode-${i}`;
    episodeList[i - 1] = {
      title: `Episode ${i}`,
      date: "",
      slug: targetSlug,
      isGuessed: true,
      source: "hardcode"
    };
  }
}

// 5. Clean & return
const cleanEpisodeList = episodeList.slice(0, totalEpisodes).filter(Boolean);

console.log(`🎉 ${cleanEpisodeList.length}/${totalEpisodes} episodes`);


    return {
      success: true,
      data: {
        title: article.find(".entry-title").text().trim(),
        thumbnail: article.find(".anime-card__sidebar img").attr("src") || "",
        score: article.find(".anime-card__score .value").text().trim(),
        type: article.find(".anime-card__score .type").text().trim(),
        trailerUrl: article.find("a.trailerbutton").attr("href") || "",
        details,
        genres,
        synopsis: article.find(".synopsis-prose").text().trim(),
        status: article.find(".info-item.status-airing, .info-item.status-finished").text().trim(),
        episodes: article.find(".anime-card__quick-info .info-item").eq(1).text().trim(),
        duration: article.find(".anime-card__quick-info .info-item").eq(2).text().trim(),
        season: {
          name: article.find(".info-item.season a").text().trim(),
          slug: extractSlug(article.find(".info-item.season a").attr("href") || ""),
        },
        firstEpisode: {
          label: firstEpEl.find(".ep-label").text().trim(),
          title: firstEpEl.clone().children(".ep-label, .watched-status").remove().end().text().trim(),
          slug: extractSlug(firstEpEl.attr("href") || ""),
        },
        lastEpisode: {
          label: lastEpEl.find(".ep-label").text().trim(),
          title: lastEpEl.clone().children(".ep-label, .watched-status").remove().end().text().trim(),
          slug: extractSlug(lastEpEl.attr("href") || ""),
        },
        episodeList: cleanEpisodeList.reverse(), // ✅ EXACTLY 28 episodes, index 0=ep1, index 27=ep28
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape: " + err.message };
  }
}

// ================= SCRAPER: EPISODE =================
async function scrapeNontonAnimeEpisode(url) {
  try {
    const res = await fetchRetry(url);
    const cookies = res.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
    const $ = cheerio.load(res.data);

    let nonce = "", ajaxUrl = "";
    const scriptSrc = $("#ajax_video-js-extra").attr("src") || "";
    if (scriptSrc.includes("base64,")) {
      const decoded = Buffer.from(scriptSrc.split("base64,")[1], "base64").toString("utf-8");
      nonce = decoded.match(/"nonce":"(.*?)"/)?.[1] || "";
      ajaxUrl = decoded.match(/"url":"(.*?)"/)?.[1] || "";
    }

    const servers = [];
    $(".serverplayer").each((i, el) => {
      servers.push({
        name: $(el).text().trim(),
        post: $(el).attr("data-post"),
        nume: $(el).attr("data-nume"),
        type: $(el).attr("data-type"),
      });
    });

    const defaultIframe = $("#videoku iframe").attr("src") || "";
    const activeIndex = $(".serverplayer.current1").index();

    // ✅ FIX 4: Player fetch paralel dengan timeout lebih pendek
    async function getPlayer({ post, nume, type }) {
      try {
        const params = new URLSearchParams();
        params.append("action", "player_ajax");
        params.append("nonce", nonce);
        params.append("serverName", type.toLowerCase());
        params.append("nume", nume);
        params.append("post", post);

        const { data } = await axios.post(ajaxUrl, params, {
          timeout: 6000, // ✅ timeout lebih pendek untuk player
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": randomUA(),
            Origin: BASE_URL,
            Referer: url,
            "X-Requested-With": "XMLHttpRequest",
            Cookie: cookies,
          },
        });

        return cheerio.load(data)("iframe").attr("src") || "";
      } catch (err) {
        return "";
      }
    }

    const players = await Promise.all(
      servers.map(async (srv, i) => ({
        name: srv.name,
        iframe: i === activeIndex && defaultIframe ? defaultIframe : await getPlayer(srv),
      }))
    );

    const downloads = [];
    $("#download_area .listlink a").each((i, el) => {
      downloads.push({ name: $(el).text().trim(), url: $(el).attr("href") });
    });

    const slugFromHref = (href) => href ? href.replace(BASE_URL, "").replace(/\//g, "") : "";

    const prevEl = $("#navigation-episode .nvs").eq(0);
    const nextEl = $("#navigation-episode .nvs").eq(2);
    const allEpisodeHref = $("#navigation-episode .nvsc a").attr("href") || "";

    return {
      success: true,
      data: {
        entryTitle: $(".entry-title").text().trim(),
        author: $(".entry-author b").text().trim(),
        date: { raw: $("time.updated").attr("datetime") || "", formatted: $("time.updated").text().trim() },
        title: $(".name").text().trim() || $(".entry-title").text().trim(),
        thumbnail: $(".featuredimgs img").attr("src") || "",
        players,
        downloads,
        prev: slugFromHref(prevEl.find(".dashicons-dismiss").length ? "" : prevEl.find("a").attr("href") || ""),
        allEpisode: allEpisodeHref ? allEpisodeHref.replace(/\/$/, "").split("/").filter(Boolean).pop() : "",
        next: slugFromHref(nextEl.find(".dashicons-dismiss").length ? "" : nextEl.find("a").attr("href") || ""),
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape: " + err.message };
  }
}

// ================= SCRAPER: TERBARU =================
async function scrapeNontonAnimeTerbaru() {
  try {
    const res = await fetchRetry(`${BASE_URL}/`);
    const $ = cheerio.load(res.data);

    const items = [];
    $("#postbaru .misha_posts_wrap article.animeseries").each((i, el) => {
      const anchor = $(el).find("a").first();
      const href = anchor.attr("href") || "";
      const slug = href.replace(/\/$/, "").split("/").filter(Boolean).pop();
      const epText = $(el).find("span.types.episodes").text().trim();

      items.push({
        title: $(el).find("h3.entry-title span").text().trim(),
        thumbnail: $(el).find("img").attr("src") || "",
        slug,
        latestEpisode: parseInt(epText.replace(/\D/g, "")) || null,
        url: href,
      });
    });

    return {
      success: true,
      total: items.length,
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape terbaru: " + err.message };
  }
}
// ================= ROUTES =================

app.get("/animeid/terbaru", async (req, res) => {
  const cached = getCache("terbaru");
  if (cached) {
    console.log("✅ Cache hit: terbaru");
    return res.json(cached);
  }

  console.log("🔍 Scraping terbaru...");
  const result = await scrapeNontonAnimeTerbaru();
  if (result.success) setCache("terbaru", result, 120); // cache 2 menit
  res.json(result);

});app.get("/animeid/terbaru", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  if (page < 1) return res.status(400).json({ success: false, message: "Page minimal 1" });

  const cacheKey = `terbaru_page_${page}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit: ${cacheKey}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping terbaru page ${page}...`);
  const result = await scrapeNontonAnimeTerbaru(page);
  if (result.success) setCache(cacheKey, result, 120); // cache 2 menit (konten cepat berubah)
  res.json(result);
});

// ✅ FIX 5: Cache per slug yang benar
app.get("/animeid/detail/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.status(400).json({ success: false, message: "Slug diperlukan" });

  const cacheKey = `detail_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit: ${cacheKey}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping detail: ${slug}`);
  const result = await scrapeNontonAnimeDetail(buildAnimeUrl(slug));
  if (result.success) setCache(cacheKey, result, 600); // cache 10 menit
  res.json(result);
});

app.get("/animeid/episode/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.status(400).json({ success: false, message: "Slug diperlukan" });

  const cacheKey = `episode_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit: ${cacheKey}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping episode: ${slug}`);
  const result = await scrapeNontonAnimeEpisode(buildUrl(slug));
  if (result.success) setCache(cacheKey, result, 600);
  res.json(result);
});

app.get("/animeid/ongoing", async (req, res) => {
  const cached = getCache("ongoing_list");
  if (cached) {
    console.log("✅ Cache hit: ongoing");
    return res.json(cached);
  }

  console.log("🔍 Scraping ongoing...");
  const result = await scrapeNontonAnimeOngoing();
  if (result.success) setCache("ongoing_list", result, 300); // cache 5 menit
  res.json(result);
});

app.listen(PORT, () => console.log(`🚀 Server jalan di http://localhost:${PORT}`));