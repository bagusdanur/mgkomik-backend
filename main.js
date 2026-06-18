const axios = require("axios");
const https = require("https");
const cloudscraper = require("cloudscraper");
const cheerio = require("cheerio");
const express = require("express");
const app = express();
const cors = require("cors");
const PORT = process.env.PORT || 3014;

app.use(cors({ origin: "*" }));

// ─────────────────────────────────────────────────────────────────────────────
// ANIMEID CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const ANIMEID_BASE_URL = "https://s13.nontonanimeid.boats";

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
  return new Promise((r) => setTimeout(r, ms));
}

function getRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

const axiosInstance = axios.create({
  timeout: 8000,
  headers: {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  },
});

async function fetchRetry(url, options = {}, retries = 2) {
  try {
    return await axiosInstance.get(url, {
      ...options,
      headers: {
        ...options.headers,
        "User-Agent": randomUA(),
        Referer: ANIMEID_BASE_URL + "/",
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

// ─────────────────────────────────────────────────────────────────────────────
// NEKOPOI CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const NEKO_BASE_URL = "https://nekopoi.care";
const NEKO_WORKER_URL = process.env.NEKO_WORKER_URL || "https://neko.ezcantik9.workers.dev/";
const nekoHttpsAgent = new https.Agent({ rejectUnauthorized: false });

function nekoHeaders(referer = NEKO_BASE_URL + "/") {
  return {
    "User-Agent": randomUA(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: referer,
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  };
}

async function fetchHtml(url) {
  const htmls = await fetchHtmlVariants(url);
  return htmls[0].html;
}

function normalizeHtmlPayload(payload) {
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    return payload.html || payload.body || payload.content || payload.data || null;
  }
  return null;
}

async function fetchHtmlVariants(url) {
  const attempts = [];

  if (NEKO_WORKER_URL) {
    attempts.push({
      label: "worker-raw",
      run: async () => {
      const separator = NEKO_WORKER_URL.includes("?") ? "" : "?url=";
      const proxyUrl = `${NEKO_WORKER_URL}${separator}${url}`;
      const { data } = await axios.get(proxyUrl, {
        timeout: 20000,
        headers: {
          "User-Agent": randomUA(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
          Referer: NEKO_BASE_URL + "/",
        },
      });
      return data;
      },
    });

    attempts.push({
      label: "worker-encoded",
      run: async () => {
      const separator = NEKO_WORKER_URL.includes("?") ? "" : "?url=";
      const proxyUrl = `${NEKO_WORKER_URL}${separator}${encodeURIComponent(url)}`;
      const { data } = await axios.get(proxyUrl, {
        timeout: 20000,
        headers: {
          "User-Agent": randomUA(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
          Referer: NEKO_BASE_URL + "/",
        },
      });
      return data;
      },
    });
  } else {
    attempts.push({
      label: "direct",
      run: async () => {
      const { data } = await axios.get(url, {
        timeout: 20000,
        headers: nekoHeaders(NEKO_BASE_URL + "/"),
        httpsAgent: nekoHttpsAgent,
        maxRedirects: 5,
      });
      return data;
      },
    });

    attempts.push({
      label: "cloudscraper",
      run: async () => {
      return await cloudscraper.get(url, {
        timeout: 20000,
        headers: nekoHeaders(NEKO_BASE_URL + "/"),
        agent: nekoHttpsAgent,
      });
      },
    });
  }

  const errors = [];
  const htmls = [];
  for (const attempt of attempts) {
    try {
      const payload = await attempt.run();
      const html = normalizeHtmlPayload(payload);
      if (typeof html === "string" && html.trim()) {
        htmls.push({ label: attempt.label, html });
      } else {
        errors.push(`${attempt.label}:non-html:${typeof payload}`);
      }
    } catch (err) {
      errors.push(`${attempt.label}:${err.response?.status || err.statusCode || err.code || err.message}`);
    }
  }

  if (htmls.length > 0) return htmls;
  throw new Error(`Semua fetch Nekopoi gagal: ${errors.filter(Boolean).join(" -> ")}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────────────────
const cache = new Map();

function setCache(key, data, ttl = 300) {
  cache.set(key, { data, expire: Date.now() + ttl * 1000 });
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expire) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMEID HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const extractSlug = (href) => {
  if (!href) return "";
  return href.replace(/\/$/, "").split("/").pop();
};

function animeidEpisodeUrl(slug) {
  return `${ANIMEID_BASE_URL}/${slug}/`;
}

function animeidAnimeUrl(slug) {
  return `${ANIMEID_BASE_URL}/anime/${slug}/`;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEKOPOI HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function nekoEpisodeUrl(slug) {
  return `${NEKO_BASE_URL}/${slug}/`;
}

function nekoAnimeUrl(slug) {
  return `${NEKO_BASE_URL}/${slug}/`;
}

function nekoTerbaruUrl(page = 1) {
  if (page <= 1) return `${NEKO_BASE_URL}/category/hentai/`;
  return `${NEKO_BASE_URL}/category/hentai/page/${page}/`;
}

function nekoSearchUrl(query, page = 1) {
  const encoded = encodeURIComponent(query);
  if (page <= 1) return `${NEKO_BASE_URL}/search/${encoded}`;
  return `${NEKO_BASE_URL}/search/${encoded}/page/${page}`;
}

function nekoSlug(href = "") {
  if (!href) return "";
  return href.replace(/\/$/, "").split("/").filter(Boolean).pop() || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMEID SCRAPERS
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeNontonAnimeOngoing() {
  try {
    const res = await fetchRetry(`${ANIMEID_BASE_URL}/ongoing-list/`);
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
        totalEpisode:
          $(el).find(".total-ep").text() === "?"
            ? null
            : parseInt($(el).find(".total-ep").text()) || null,
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
      genres.push({
        name: $(el).text().trim(),
        slug: extractSlug($(el).attr("href")),
      });
    });

    const details = {};
    article.find(".details-list li").each((i, el) => {
      const label = $(el).find(".detail-label").text().replace(":", "").trim();
      if (!label || $(el).hasClass("detail-separator")) return;
      const value = $(el).clone().children(".detail-label").remove().end().text().trim();
      if (label && value) details[label] = value;
    });

    const episodeList = [];
    const firstEpEl = article.find(".meta-episode-item.first a");
    const lastEpEl = article.find(".meta-episode-item.last a");

    let slugPattern = extractSlug(url);
    let totalEpisodes = 1;

    if (lastEpEl.length) {
      const lastSlug = extractSlug(lastEpEl.attr("href") || "");
      const match = lastSlug.match(/(.+?)(?:-s\d+-|-episode-|ep-)(\d+)$/);
      if (match) {
        slugPattern = match[1];
        totalEpisodes = parseInt(match[2]);
      }
    }

    article.find(".episode-list-items .episode-item").each((i, el) => {
      const slug = extractSlug($(el).attr("href") || "");
      const epNum = parseInt(slug.match(/(\d+)$/)?.[1] || 0);
      if (epNum > 0 && epNum <= totalEpisodes) {
        episodeList[epNum - 1] = {
          title: $(el).find(".ep-title").text().trim(),
          date: $(el).find(".ep-date").text().trim(),
          slug,
          source: "html",
        };
      }
    });

    if (firstEpEl.length) {
      const slug = extractSlug(firstEpEl.attr("href") || "");
      const epNum = parseInt(slug.match(/(\d+)$/)?.[1] || 1);
      if (epNum > 0 && epNum <= totalEpisodes) {
        episodeList[epNum - 1] = {
          title: firstEpEl.clone().children(".ep-label, .watched-status").remove().end().text().trim(),
          date: "",
          slug,
          source: "meta",
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
          source: "meta",
        };
      }
    }

    for (let i = 1; i <= totalEpisodes; i++) {
      if (!episodeList[i - 1]) {
        episodeList[i - 1] = {
          title: `Episode ${i}`,
          date: "",
          slug: `${slugPattern}-episode-${i}`,
          isGuessed: true,
          source: "hardcode",
        };
      }
    }

    const cleanEpisodeList = episodeList.slice(0, totalEpisodes).filter(Boolean);

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
        episodeList: cleanEpisodeList.reverse(),
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape: " + err.message };
  }
}

async function scrapeNontonAnimeEpisode(url) {
  try {
    const res = await fetchRetry(url);
    const cookies = res.headers["set-cookie"]?.map((c) => c.split(";")[0]).join("; ") || "";
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

    async function getPlayer({ post, nume, type }) {
      try {
        const params = new URLSearchParams();
        params.append("action", "player_ajax");
        params.append("nonce", nonce);
        params.append("serverName", type.toLowerCase());
        params.append("nume", nume);
        params.append("post", post);
        const { data } = await axios.post(ajaxUrl, params, {
          timeout: 6000,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": randomUA(),
            Origin: ANIMEID_BASE_URL,
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

    const slugFromAnimeid = (href) =>
      href ? href.replace(ANIMEID_BASE_URL, "").replace(/\//g, "") : "";

    const prevEl = $("#navigation-episode .nvs").eq(0);
    const nextEl = $("#navigation-episode .nvs").eq(2);
    const allEpisodeHref = $("#navigation-episode .nvsc a").attr("href") || "";

    return {
      success: true,
      data: {
        entryTitle: $(".entry-title").text().trim(),
        author: $(".entry-author b").text().trim(),
        date: {
          raw: $("time.updated").attr("datetime") || "",
          formatted: $("time.updated").text().trim(),
        },
        title: $(".name").text().trim() || $(".entry-title").text().trim(),
        thumbnail: $(".featuredimgs img").attr("src") || "",
        players,
        downloads,
        prev: slugFromAnimeid(prevEl.find(".dashicons-dismiss").length ? "" : prevEl.find("a").attr("href") || ""),
        allEpisode: allEpisodeHref ? allEpisodeHref.replace(/\/$/, "").split("/").filter(Boolean).pop() : "",
        next: slugFromAnimeid(nextEl.find(".dashicons-dismiss").length ? "" : nextEl.find("a").attr("href") || ""),
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape: " + err.message };
  }
}

async function scrapeNontonAnimeTerbaru() {
  try {
    const res = await fetchRetry(`${ANIMEID_BASE_URL}/`);
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
    return { success: true, total: items.length, data: items };
  } catch (err) {
    return { success: false, message: "Gagal scrape terbaru: " + err.message };
  }
}

async function scrapeNontonAnimeJadwal() {
  try {
    const res = await fetchRetry(`${ANIMEID_BASE_URL}/jadwal-rilis/`);
    const $ = cheerio.load(res.data);
    const HARI = ["senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu"];
    const jadwal = {};
    HARI.forEach((hari) => {
      const items = [];
      $(`#${hari} .as-anime-card`).each((i, el) => {
        const href = $(el).attr("href") || "";
        const slug = href.replace(/\/$/, "").split("/").filter(Boolean).pop();
        const status = $(el).attr("data-status") || "on-schedule";
        const isDelayed = status === "delayed";
        const releaseTime = isDelayed
          ? $(el).find(".as-delay-details").text().replace("Info:", "").trim()
          : $(el).find(".as-release-time").text().replace("🕒", "").trim();
        const rating = $(el).find(".as-rating").clone().children(".icon").remove().end().text().trim();
        const type = $(el).find(".as-type").clone().children(".icon").remove().end().text().trim();
        const episodes = $(el).find(".as-episodes").clone().children(".icon").remove().end().text().trim();
        items.push({
          title: $(el).find(".as-anime-title").text().trim(),
          thumbnail: $(el).find("img").attr("src") || "",
          slug, status, rating, type, episodes, releaseTime,
        });
      });
      jadwal[hari] = items;
    });
    const activeDay = $(".as-tab-link.active").attr("data-tab") || "senin";
    return { success: true, activeDay, data: jadwal };
  } catch (err) {
    return { success: false, message: "Gagal scrape jadwal: " + err.message };
  }
}

async function scrapeNontonAnimeSearchPaged(query, page = 1) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const pagePath = page > 1 ? `/page/${page}` : "";
    const url = `${ANIMEID_BASE_URL}${pagePath}/?s=${encodedQuery}`;
    const res = await fetchRetry(url);
    const $ = cheerio.load(res.data);
    const items = [];
    $(".as-anime-grid .as-anime-card").each((i, el) => {
      const href = $(el).attr("href") || "";
      const slug = href.replace(/\/$/, "").split("/").filter(Boolean).pop();
      let thumbnail = $(el).find("img").attr("src") || "";
      if (!thumbnail) {
        const style = $(el).attr("style") || "";
        const match = style.match(/url\(['"]?(.*?)['"]?\)/);
        thumbnail = match ? match[1] : "";
      }
      const rating = $(el).find(".as-rating").clone().children(".icon").remove().end().text().trim();
      const type = $(el).find(".as-type").clone().children(".icon").remove().end().text().trim();
      const season = $(el).find(".as-season").clone().children(".icon").remove().end().text().trim();
      const genres = [];
      $(el).find(".as-genres .as-genre-tag").each((j, genreEl) => {
        genres.push($(genreEl).text().trim());
      });
      items.push({
        title: $(el).find(".as-anime-title").text().trim(),
        thumbnail, slug, url: href,
        rating: rating || null,
        type: type || null,
        season: season || null,
        synopsis: $(el).find(".as-synopsis").text().trim(),
        genres,
      });
    });
    const currentPage = $(".wp-pagenavi .current").text().trim();
    const hasNext = $(".wp-pagenavi .nextpostslink").length > 0;
    const hasPrev = $(".wp-pagenavi .prevpostslink").length > 0;
    const totalPagesText = $(".wp-pagenavi .pages").text().trim();
    const totalMatch = totalPagesText.match(/dari\s+(\d+)/);
    const totalPages = totalMatch ? parseInt(totalMatch[1]) : 1;
    return {
      success: true, query,
      page: parseInt(currentPage) || page,
      totalPages, totalResults: items.length,
      hasNext, hasPrev, data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape search: " + err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEKOPOI SCRAPERS
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeNekopoiTerbaru(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const currentPage = parseInt($(".page-numbers.current").text().trim()) || 1;
    const lastPageEl = $(".page-numbers:not(.next):not(.prev):not(.dots)").last();
    const totalPages = parseInt(lastPageEl.text().trim()) || 1;
    const hasNext = $("a.next.page-numbers").length > 0;
    const hasPrev = $("a.prev.page-numbers").length > 0;
    const items = [];
    $(".nk-search-results ul li").each((_, el) => {
      const a = $(el).find("a.nk-search-item");
      const href = a.attr("href") || "";
      const slug = nekoSlug(href);
      const thumbStyle = a.find(".nk-search-thumb").attr("style") || "";
      const thumbMatch = thumbStyle.match(/url\(['"]?(.*?)['"]?\)/);
      const thumbnail = thumbMatch ? thumbMatch[1] : "";
      const title = a.find("h2").text().trim();
      const desc = a.find(".nk-search-desc").text().trim();
      const epMatch = title.match(/episode\s+(\d+)/i);
      const latestEpisode = epMatch ? parseInt(epMatch[1]) : null;
      const tagMatch = title.match(/^\[([^\]]+)\]/);
      const tag = tagMatch ? tagMatch[1] : "";
      items.push({ title, tag, thumbnail, slug, latestEpisode, desc, url: href });
    });
    return {
      success: true,
      total: items.length,
      pagination: { currentPage, totalPages, hasNext, hasPrev,
        nextPage: hasNext ? currentPage + 1 : null,
        prevPage: hasPrev ? currentPage - 1 : null,
      },
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape terbaru: " + err.message };
  }
}

async function scrapeNekopoiSearch(query, page = 1, debugMode = false) {
  try {
    const urls = [nekoSearchUrl(query, page)];
    let $;
    let items = [];
    const errors = [];
    const debug = {
      requestedPage: page,
      discoveredUrl: null,
      urls: [],
      candidates: [],
      errors,
    };

    const parseItems = ($doc) => {
      const results = [];
      $doc("#nk-content .nk-search-results a.nk-search-item, .nk-main-content .nk-search-results a.nk-search-item, a.nk-search-item").each((_, el) => {
        const a = $doc(el);
        const href = a.attr("href") || "";
        const slug = nekoSlug(href);
        const thumbStyle = a.find(".nk-search-thumb").attr("style") || "";
        const thumbMatch = thumbStyle.match(/url\(['"]?(.*?)['"]?\)/);
        const thumbnail = thumbMatch ? thumbMatch[1] : a.find("img").first().attr("src") || "";
        const title = a.find("h2, .entry-title, .title").first().text().trim();
        const desc = a.find(".nk-search-desc, p").first().text().trim();
        const tagMatch = title.match(/^\[([^\]]+)\]/);
        const tag = tagMatch ? tagMatch[1] : "";
        const epMatch = title.match(/episode\s+(\d+)/i);
        const latestEpisode = epMatch ? parseInt(epMatch[1]) : null;

        if (href || title) {
          results.push({ title, tag, thumbnail, slug, latestEpisode, desc, url: href });
        }
      });
      return results;
    };

    const parseCurrentPage = ($doc) => (
      parseInt($doc("nav.navigation.pagination .page-numbers.current").first().text().trim()) ||
      parseInt($doc(".nav-links .page-numbers.current").first().text().trim()) ||
      parseInt($doc(".page-numbers.current").first().text().trim()) ||
      page
    );

    if (page > 1) {
      try {
        const firstPageHtmls = await fetchHtmlVariants(nekoSearchUrl(query, 1));
        for (const { html } of firstPageHtmls) {
          const firstPage$ = cheerio.load(html);
          const discoveredUrl = firstPage$("nav.navigation.pagination .page-numbers, .nav-links .page-numbers")
            .filter((_, el) => firstPage$(el).text().trim() === String(page))
            .first()
            .attr("href");

          if (discoveredUrl) {
            debug.discoveredUrl = discoveredUrl;
            urls.unshift(discoveredUrl);
            break;
          }
        }
      } catch (err) {
        errors.push(err.message);
      }

    }

    const uniqueUrls = [...new Set(urls)];
    debug.urls = uniqueUrls;

    for (const url of uniqueUrls) {
      try {
        const htmls = await fetchHtmlVariants(url);

        for (const { label, html } of htmls) {
          const candidate$ = cheerio.load(html);
          const candidateItems = parseItems(candidate$);
          const candidatePage = parseCurrentPage(candidate$);
          const pageTitle = candidate$("title").first().text().trim() || null;
          const isBlockedPage = /internet baik/i.test(pageTitle || "");
          const pager = candidate$("nav.navigation.pagination .nav-links").first().length
            ? candidate$("nav.navigation.pagination .nav-links").first()
            : candidate$(".nav-links").first();

          debug.candidates.push({
            url,
            fetcher: label,
            htmlLength: html.length,
            itemCount: candidateItems.length,
            currentPage: candidatePage,
            totalPages: parseInt(pager.find(".page-numbers:not(.next):not(.prev):not(.dots)").last().text().trim()) || null,
            hasSearchResultsWrap: candidate$(".nk-search-results").length > 0,
            hasMainContent: candidate$(".nk-main-content").length > 0,
            firstTitle: candidateItems[0]?.title || null,
            firstHref: candidateItems[0]?.url || null,
            pageTitle,
            isBlockedPage,
          });

          if (isBlockedPage) {
            errors.push(`${label}:blocked:${pageTitle}`);
            continue;
          }

          if (!$) {
            $ = candidate$;
          }

          if (candidateItems.length > 0 && (items.length === 0 || candidatePage === page)) {
            $ = candidate$;
            items = candidateItems;
          }

          if (items.length > 0 && candidatePage === page) break;
        }

        if (items.length > 0 && parseCurrentPage($) === page) break;
      } catch (err) {
        errors.push(err.message);
      }
    }

    if (!$ && errors.length) throw new Error(errors.join(" | "));
    if (!$) throw new Error("Tidak ada HTML Nekopoi valid yang bisa diparse");

    const currentPage = parseCurrentPage($);
    const pager = $("nav.navigation.pagination .nav-links").first().length
      ? $("nav.navigation.pagination .nav-links").first()
      : $(".nav-links").first();
    const lastPageEl = pager.find(".page-numbers:not(.next):not(.prev):not(.dots)").last();
    const totalPages = Math.max(parseInt(lastPageEl.text().trim()) || currentPage || 1, currentPage || 1);
    const hasNext = pager.find("a.next.page-numbers").length > 0;
    const hasPrev = pager.find("a.prev.page-numbers").length > 0 || page > 1;
    const result = {
      success: true, query,
      pagination: { currentPage, totalPages, hasNext, hasPrev,
        nextPage: hasNext ? currentPage + 1 : null,
        prevPage: hasPrev ? currentPage - 1 : null,
      },
      total: items.length, data: items,
    };
    if (debugMode) result.debug = debug;
    return result;
  } catch (err) {
    return { success: false, message: "Gagal scrape search: " + err.message };
  }
}

async function scrapeNekopoiEpisode(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const players = [];
    $("#nk-player-tabs a").each((i, tabEl) => {
      const tabId = $(tabEl).attr("href");
      if (!tabId || tabId === "#") return;
      const frameId = tabId.replace("#", "");
      const iframe = $(`#${frameId} iframe`);
      const src = iframe.attr("src") || "";
      if (src) players.push({ label: $(tabEl).text().trim(), src });
    });
    const downloads = [];
    $(".nk-download-box .nk-download-row").each((_, row) => {
      const quality = $(row).find(".nk-download-name").text().trim();
      const links = [];
      $(row).find(".nk-download-links a").each((_, a) => {
        links.push({ label: $(a).text().trim(), href: $(a).attr("href") || "" });
      });
      if (quality || links.length) downloads.push({ quality, links });
    });
    const prevEl = $(".nk-episode-nav .nav-previous, .nav-previous").first();
    const nextEl = $(".nk-episode-nav .nav-next, .nav-next").first();
    const allEpisodeHref = $("a.nk-player-series").attr("href") || "";
    const thumbnail = $(".nk-featured-img img").attr("src") || $("meta[property='og:image']").attr("content") || "";
    const entryTitle = $(".nk-post-header h1").text().trim();
    const dateMeta = $(".nk-post-header-meta span").eq(1).text().trim();
    const synopsis = $(".konten p").first().text().trim();
    const genreRaw = $(".konten p:contains('Genre')").text().replace("Genre :", "").trim();
    const genres = genreRaw ? genreRaw.split(",").map((g) => g.trim()).filter(Boolean) : [];
    const producer = $(".konten p:contains('Producers')").text().replace("Producers :", "").trim();
    const duration = $(".konten p:contains('Duration')").text().replace("Duration :", "").trim();
    const size = $(".konten p:contains('Size')").text().replace("Size :", "").trim();
    return {
      success: true,
      data: {
        entryTitle, title: entryTitle, thumbnail,
        date: { raw: dateMeta, formatted: dateMeta },
        author: "", synopsis, genres, producer, duration, size, players, downloads,
        prev: (() => {
          const hasDismiss = prevEl.find(".dashicons-dismiss").length > 0;
          return nekoSlug(hasDismiss ? "" : prevEl.find("a").attr("href") || "");
        })(),
        next: (() => {
          const hasDismiss = nextEl.find(".dashicons-dismiss").length > 0;
          return nekoSlug(hasDismiss ? "" : nextEl.find("a").attr("href") || "");
        })(),
        allEpisode: allEpisodeHref ? allEpisodeHref.replace(/\/$/, "").split("/").filter(Boolean).pop() : "",
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape episode: " + err.message };
  }
}

async function scrapeNekopoiDetail(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const posterStyle = $(".nk-series-poster").attr("style") || "";
    const posterMatch = posterStyle.match(/url\(['"]?(.*?)['"]?\)/);
    const thumbnail = posterMatch ? posterMatch[1] : "";
    const title = $(".nk-series-info h2").clone().children().remove().end().text().trim().replace(/^Unduh\s+[""]|[""].*$/g, "").trim();
    const synopsis = $(".nk-series-synopsis p").text().trim();
    const meta = {};
    $(".nk-series-meta-list ul li").each((_, el) => {
      const key = $(el).find("b").text().trim().replace(":", "").toLowerCase();
      const val = $(el).clone().children("b").remove().end().text().trim().replace(/^:\s*/, "");
      if (key) meta[key] = val;
    });
    const genres = [];
    $(".nk-series-meta-list ul li").filter((_, el) => {
      return $(el).find("b").text().toLowerCase().includes("genre");
    }).find("a").each((_, a) => {
      genres.push({ name: $(a).text().trim(), slug: nekoSlug($(a).attr("href") || "") });
    });
    const latestEpisodeLabel = $(".latestepisode").text().trim();
    const latestEpisodeHref = $(".latestnow a").attr("href") || "";
    const episodeList = [];
    $(".nk-episode-grid ul li").each((_, el) => {
      const a = $(el).find("a.nk-episode-card");
      const href = a.attr("href") || "";
      const thumbStyle = a.find(".nk-episode-card-thumb").attr("style") || "";
      const thumbMatch = thumbStyle.match(/url\(['"]?(.*?)['"]?\)/);
      const thumb = thumbMatch ? thumbMatch[1] : "";
      episodeList.push({
        slug: nekoSlug(href),
        label: a.find(".nk-episode-badge").text().trim(),
        title: a.find(".nk-episode-card-title").text().trim(),
        date: a.find(".nk-episode-card-date").text().trim(),
        thumbnail: thumb, href,
      });
    });
    const firstEpisode = episodeList[episodeList.length - 1] || null;
    const lastEpisode = episodeList[0] || null;
    return {
      success: true,
      data: {
        title, thumbnail,
        japaneseTitle: meta["judul jepang"] || "",
        type: meta["jenis"] || "",
        totalEpisodes: meta["episode"] || "",
        status: meta["status"] || "",
        aired: meta["tayang"] || "",
        producer: meta["produser"] || "",
        duration: meta["durasi"] || "",
        score: meta["skor"] || "",
        genres, synopsis,
        latestEpisode: { label: latestEpisodeLabel, slug: nekoSlug(latestEpisodeHref), href: latestEpisodeHref },
        firstEpisode, lastEpisode, episodeList,
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape detail: " + err.message };
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// ANICHIN CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const ANICHIN_BASE_URL = "https://anichin.cafe";
 
const axiosAnichin = axios.create({
  timeout: 10000,
  headers: {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  },
});
 
async function fetchAnichin(url, retries = 2) {
  try {
    return await axiosAnichin.get(url, {
      headers: {
        "User-Agent": randomUA(),
        Referer: ANICHIN_BASE_URL + "/",
      },
    });
  } catch (err) {
    if (retries <= 0) throw err;
    const delay = err.response?.status === 403 ? 1500 : 500;
    console.log(`🔁 Anichin Retry (${retries} left) [${err.response?.status || err.code}]: ${url}`);
    await sleep(delay);
    return fetchAnichin(url, retries - 1);
  }
}
 
// ─────────────────────────────────────────────────────────────────────────────
// ANICHIN SCRAPER - TERBARU (Latest Release only)
// Semua page (1, 2, 3, dst) selalu render hothome + latesthome
// Fix: SELALU pakai .releases.latesthome sebagai container anchor
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeAnichinTerbaru(page = 1) {
  try {
    const url = page <= 1
      ? `${ANICHIN_BASE_URL}/`
      : `${ANICHIN_BASE_URL}/page/${page}/`;
 
    const res = await fetchAnichin(url);
    const $ = cheerio.load(res.data);
 
    // Selalu ambil dari .releases.latesthome — ada di semua page
    // Ini memastikan popular (hothome) tidak ikut masuk
    const container = $(".bixbox .releases.latesthome").closest(".bixbox");
 
    const items = [];
    container.find("article.bs").each((i, el) => {
      const anchor = $(el).find(".bsx > a");
      const href = anchor.attr("href") || "";
      const slug = href.replace(/\/$/, "").split("/").filter(Boolean).pop() || "";
 
      const thumbnail =
        anchor.find("img").attr("src") ||
        anchor.find("img").attr("data-src") ||
        "";
 
      // Judul seri (buang h2 dari .tt)
      const title = $(el)
        .find(".bsx .tt")
        .clone()
        .children("h2")
        .remove()
        .end()
        .text()
        .trim();
 
      // Judul episode lengkap
      const episodeTitle = $(el).find("h2[itemprop='headline']").text().trim();
 
      // Tipe: Donghua / Movie / ONA / dll
      const type = anchor.find(".typez").text().trim();
 
      // Label episode: "Ep 04" / "Ep 59 END" / "Movie"
      const episodeLabel = anchor.find(".bt .epx").text().trim();
      const epMatch = episodeLabel.match(/(\d+)/);
      const episode = epMatch ? parseInt(epMatch[1]) : null;
      const isEnd = /end/i.test(episodeLabel);
      const isMovie = /movie/i.test(type);
 
      // Sub / Dub
      const subDub = anchor.find(".bt .sb").text().trim();
 
      // Status: "Completed" atau "Ongoing"
      const statusBadge = anchor.find(".limit .status").text().trim();
      const status = statusBadge || "Ongoing";
 
      items.push({
        title,
        episodeTitle,
        slug,
        url: href,
        thumbnail,
        type,
        episode,
        episodeLabel,
        isEnd,
        isMovie,
        subDub,
        status,
      });
    });
 
    // Pagination — ambil dari .hpage dalam container latesthome
    const hasNext = container.find(".hpage a.r").length > 0;
    const hasPrev = container.find(".hpage a.l").length > 0;
 
    return {
      success: true,
      page,
      hasNext,
      hasPrev,
      nextPage: hasNext ? page + 1 : null,
      prevPage: hasPrev ? page - 1 : null,
      total: items.length,
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape anichin terbaru: " + err.message };
  }
}

async function scrapeAnichinEpisode(slug) {
  try {
    const url = `${ANICHIN_BASE_URL}/${slug}/`;
    const res = await fetchAnichin(url);
    const $ = cheerio.load(res.data);
 
    // ── THUMBNAIL ─────────────────────────────────────────────────────────
    const thumbnail = $(".megavid .tb img").attr("src") || "";
 
    // ── JUDUL EPISODE ─────────────────────────────────────────────────────
    const episodeTitle = $("h1.entry-title").text().trim();
 
    // ── META (type, subDub, tanggal, author, seri) ────────────────────────
    const type = $(".megavid .epx").clone().children(".lg").remove().end().text().trim();
    const subDub = $(".megavid .epx .lg").text().trim();
    const releasedOn = $(".megavid .updated").text().trim();
    const author = $(".megavid .fn a").text().trim();
    const seriesTitle = $(".megavid .year a[href*='/seri/']").text().trim();
    const seriesSlug = ($(".megavid .year a[href*='/seri/']").attr("href") || "")
      .replace(/\/$/, "").split("/").filter(Boolean).pop();
 
    // ── PLAYERS (dari select option, decode base64) ────────────────────────
    const players = [];
    $("select.mirror option").each((i, el) => {
      const val = $(el).attr("value") || "";
      const label = $(el).text().trim();
      if (!val || !label || label === "Select Video Server") return;
 
      let iframeSrc = "";
      try {
        const decoded = Buffer.from(val, "base64").toString("utf-8");
        const srcMatch = decoded.match(/src="([^"]+)"/);
        iframeSrc = srcMatch ? srcMatch[1] : "";
      } catch (e) {
        iframeSrc = "";
      }
 
      players.push({
        label,
        index: parseInt($(el).attr("data-index")) || i + 1,
        iframe: iframeSrc,
      });
    });
 
    // Tambah player aktif dari embed_holder (bisa beda dengan option pertama)
    const activeIframe = $("#pembed iframe").attr("src") || "";
 
    // ── NAVIGASI EPISODE ──────────────────────────────────────────────────
    const navEls = $(".naveps.bignav .nvs");
 
    // Prev: nvs pertama (bukan nvsc), cek apakah ada <a> atau <span class="nolink">
    const prevEl = navEls.eq(0);
    const prevHref = prevEl.find("a").attr("href") || "";
    const prev = prevHref
      ? prevHref.replace(/\/$/, "").split("/").filter(Boolean).pop()
      : null;
 
    // All episodes: nvsc
    const allEpisodeHref = $(".naveps.bignav .nvsc a").attr("href") || "";
    const allEpisodeSlug = allEpisodeHref
      ? allEpisodeHref.replace(/\/$/, "").split("/").filter(Boolean).pop()
      : null;
 
    // Next: nvs terakhir
    const nextEl = navEls.eq(2);
    const nextHref = nextEl.find("a").attr("href") || "";
    const next = nextHref
      ? nextHref.replace(/\/$/, "").split("/").filter(Boolean).pop()
      : null;
 
    // ── DOWNLOAD LINKS ────────────────────────────────────────────────────
    // Struktur: .soraddlx > .soraurlx (berisi strong kualitas + link-link)
    const downloads = [];
    $(".soraddlx .soraurlx").each((i, el) => {
      const quality = $(el).find("strong").text().trim();
      const links = [];
      $(el).find("a").each((j, a) => {
        links.push({
          label: $(a).text().trim(),
          url: $(a).attr("href") || "",
        });
      });
      if (quality) downloads.push({ quality, links });
    });
 
    // ── INFO SERI (dari .single-info) ─────────────────────────────────────
    const seriesInfo = {};
    $(".single-info .spe span").each((i, el) => {
      const text = $(el).text().trim();
      const colonIdx = text.indexOf(":");
      if (colonIdx === -1) return;
      const key = text.slice(0, colonIdx).trim().toLowerCase();
      const val = $(el).clone().children("b").remove().end().text().replace(/^:\s*/, "").trim();
      seriesInfo[key] = val;
    });
 
    const rating = $(".single-info .rating strong").text().replace("Rating", "").trim();
 
    const genres = [];
    $(".single-info .genxed a").each((i, el) => {
      genres.push({
        name: $(el).text().trim(),
        slug: ($(el).attr("href") || "").replace(/\/$/, "").split("/").filter(Boolean).pop(),
      });
    });
 
    const synopsis = $(".single-info .desc").clone().children(".colap").remove().end().text().trim();
 
    const alternativeTitle = $(".single-info .alter").text().trim();
 
    // ── RELATED EPISODES ──────────────────────────────────────────────────
    const relatedEpisodes = [];
    $(".bixbox:has(h3:contains('Related Episodes')) .stylefiv").each((i, el) => {
      const a = $(el).find(".thumb a");
      const href = a.attr("href") || "";
      relatedEpisodes.push({
        title: $(el).find(".inf h2 a").text().trim(),
        slug: href.replace(/\/$/, "").split("/").filter(Boolean).pop(),
        url: href,
        thumbnail: $(el).find("img").attr("src") || "",
        postedBy: $(el).find(".inf span").eq(0).text().replace("Posted by:", "").trim(),
        releasedOn: $(el).find(".inf span").eq(1).text().replace("Released on:", "").trim(),
      });
    });
 
    return {
      success: true,
      data: {
        episodeTitle,
        thumbnail,
        type,
        subDub,
        releasedOn,
        author,
        series: {
          title: seriesTitle,
          slug: seriesSlug,
        },
        activeIframe,
        players,
        navigation: {
          prev,
          allEpisode: allEpisodeSlug,
          next,
        },
        downloads,
        seriesInfo: {
          ...seriesInfo,
          rating,
          alternativeTitle,
          genres,
          synopsis,
        },
        relatedEpisodes,
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape anichin episode: " + err.message };
  }
}

async function scrapeAnichinSeri(slug) {
  try {
    const url = `${ANICHIN_BASE_URL}/seri/${slug}/`;
    const res = await fetchAnichin(url);
    const $ = cheerio.load(res.data);
 
    // ── THUMBNAIL ─────────────────────────────────────────────────────────
    const thumbnail = $(".bigcontent .thumbook .thumb img").attr("src") || "";
 
    // ── JUDUL ─────────────────────────────────────────────────────────────
    const title = $("h1.entry-title").text().trim();
    const alternativeTitle = $(".ninfo .alter").text().trim();
 
    // ── RATING ────────────────────────────────────────────────────────────
    const rating = $(".thumbook .rating strong").text().replace("Rating", "").trim();
 
    // ── META INFO (Status, Network, Studio, dll) ──────────────────────────
    const meta = {};
    $(".infox .spe span").each((i, el) => {
      const fullText = $(el).text().trim();
      const boldText = $(el).find("b").text().replace(":", "").trim();
      if (!boldText) return;
      const val = $(el).clone().children("b").remove().end().text().replace(/^:\s*/, "").trim();
      meta[boldText.toLowerCase()] = val;
    });
 
    // ── TANGGAL ───────────────────────────────────────────────────────────
    const releasedOn = $(".infox .spe time[itemprop='datePublished']").text().trim();
    const updatedOn = $(".infox .spe time[itemprop='dateModified']").text().trim();
 
    // ── GENRES ────────────────────────────────────────────────────────────
    const genres = [];
    $(".infox .genxed a").each((i, el) => {
      genres.push({
        name: $(el).text().trim(),
        slug: ($(el).attr("href") || "").replace(/\/$/, "").split("/").filter(Boolean).pop(),
      });
    });
 
    // ── SYNOPSIS ──────────────────────────────────────────────────────────
    const synopsis = $(".bixbox.synp .entry-content p").text().trim();
 
    // ── FIRST & LAST EPISODE ──────────────────────────────────────────────
    const firstEpEl = $(".lastend .inepcx").eq(0);
    const lastEpEl = $(".lastend .inepcx").eq(1);
 
    const lastEpHref = lastEpEl.find("a").attr("href") || "";
    const lastEpSlug = lastEpHref.replace(/\/$/, "").split("/").filter(Boolean).pop() || null;
 
    // First episode: anichin pakai JS untuk set href-nya (ts_set_first_ep),
    // href di HTML selalu "#", jadi kita derive dari episode list saja
    const firstEpLabel = firstEpEl.find(".epcur").text().trim();
    const lastEpLabel = lastEpEl.find(".epcur").text().trim();
 
    // ── EPISODE LIST ──────────────────────────────────────────────────────
    // Selector: .eplister ul li
    const episodeList = [];
    $(".eplister ul li").each((i, el) => {
      const a = $(el).find("a");
      const href = a.attr("href") || "";
      const epSlug = href.replace(/\/$/, "").split("/").filter(Boolean).pop() || "";
      const epNum = $(el).find(".epl-num").text().trim();
      const epTitle = $(el).find(".epl-title").text().trim();
      const epSub = $(el).find(".epl-sub span").text().trim();
      const epDate = $(el).find(".epl-date").text().trim();
      const isEnd = /end/i.test(epNum);
 
      episodeList.push({
        num: epNum,
        isEnd,
        title: epTitle,
        slug: epSlug,
        url: href,
        sub: epSub,
        date: epDate,
      });
    });
 
    // Episode list dari HTML urutan DESC (terbaru dulu), balik jadi ASC
    const episodeListAsc = [...episodeList].reverse();
 
    return {
      success: true,
      data: {
        title,
        alternativeTitle,
        thumbnail,
        rating,
        synopsis,
        info: {
          status: meta["status"] || "",
          network: meta["network"] || "",
          studio: meta["studio"] || "",
          released: meta["released"] || "",
          duration: meta["duration"] || "",
          season: meta["season"] || "",
          country: meta["country"] || "",
          type: meta["type"] || "",
          totalEpisodes: parseInt(meta["episodes"]) || null,
          postedBy: meta["posted by"] || "",
          releasedOn,
          updatedOn,
        },
        genres,
        latestEpisode: {
          label: lastEpLabel,
          slug: lastEpSlug,
          url: lastEpHref,
        },
        firstEpisodeLabel: firstEpLabel,
        totalEpisodesFound: episodeList.length,
        // episodeList: terbaru dulu (urutan dari HTML asli)
        episodeList,
        // episodeListAsc: dari ep 1 ke atas
        episodeListAsc,
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape anichin seri: " + err.message };
  }
}
 
app.get("/anichin/detail/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) {
    return res.status(400).json({ success: false, message: "Slug diperlukan" });
  }
 
  const cacheKey = `anichin_seri_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
 
  const result = await scrapeAnichinSeri(slug);
 
  // Cache 10 menit untuk seri ongoing, 1 jam untuk completed
  if (result.success) {
    const ttl = result.data.info.status === "Completed" ? 3600 : 600;
    setCache(cacheKey, result, ttl);
  }
 
  res.json(result);
});

app.get("/anichin/episode/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) {
    return res.status(400).json({ success: false, message: "Slug diperlukan" });
  }
 
  const cacheKey = `anichin_episode_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
 
  const result = await scrapeAnichinEpisode(slug);
 
  // Cache 10 menit — episode jarang berubah setelah upload
  if (result.success) setCache(cacheKey, result, 600);
 
  res.json(result);
});
 
// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: GET /anichin/terbaru
// ─────────────────────────────────────────────────────────────────────────────
app.get("/anichin/terbaru", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
 
  if (page < 1) {
    return res.status(400).json({ success: false, message: "Page minimal 1" });
  }
 
  const cacheKey = `anichin_terbaru_p${page}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
 
  const result = await scrapeAnichinTerbaru(page);
 
  if (result.success) setCache(cacheKey, result, page === 1 ? 120 : 300);
 
  res.json(result);
});
 
 

// ─────────────────────────────────────────────────────────────────────────────
// NEKOPOI ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/nekopoi/terbaru", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `neko_terbaru_${page}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  const result = await scrapeNekopoiTerbaru(nekoTerbaruUrl(page));
  if (result.success) setCache(cacheKey, result, 120);
  res.json(result);
});

app.get("/nekopoi/search", async (req, res) => {
  const { q, page, debug } = req.query;
  if (!q || q.trim().length < 2)
    return res.status(400).json({ success: false, message: "Parameter 'q' minimal 2 karakter" });
  const pageNum = parseInt(page) || 1;
  const debugMode = debug === "1" || debug === "true";
  const cacheKey = `neko_search_v2_${q.toLowerCase().replace(/\s+/g, "_")}_p${pageNum}`;
  const cached = debugMode ? null : getCache(cacheKey);
  if (cached) return res.json(cached);
  const result = await scrapeNekopoiSearch(q, pageNum, debugMode);
  if (!debugMode && result.success && result.total > 0) setCache(cacheKey, result, 300);
  res.json(result);
});

app.get("/nekopoi/episode/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.status(400).json({ success: false, message: "Slug diperlukan" });
  const cacheKey = `neko_episode_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  const result = await scrapeNekopoiEpisode(nekoEpisodeUrl(slug));
  if (result.success) setCache(cacheKey, result, 60 * 60 * 24 * 7);
  res.json(result);
});

app.get("/nekopoi/detail/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.status(400).json({ success: false, message: "Slug diperlukan" });
  const cacheKey = `neko_detail_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  const result = await scrapeNekopoiDetail(nekoAnimeUrl(slug));
  if (result.success) setCache(cacheKey, result, 60 * 60 * 24);
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// ANIMEID ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/animeid/terbaru", async (req, res) => {
  const cached = getCache("animeid_terbaru");
  if (cached) return res.json(cached);
  const result = await scrapeNontonAnimeTerbaru();
  if (result.success) setCache("animeid_terbaru", result, 120);
  res.json(result);
});

app.get("/animeid/ongoing", async (req, res) => {
  const cached = getCache("animeid_ongoing");
  if (cached) return res.json(cached);
  const result = await scrapeNontonAnimeOngoing();
  if (result.success) setCache("animeid_ongoing", result, 300);
  res.json(result);
});

app.get("/animeid/jadwal", async (req, res) => {
  const cached = getCache("animeid_jadwal");
  if (cached) return res.json(cached);
  const result = await scrapeNontonAnimeJadwal();
  if (result.success) setCache("animeid_jadwal", result, 86400);
  res.json(result);
});

app.get("/animeid/jadwal/:hari", async (req, res) => {
  const { hari } = req.params;
  const VALID = ["senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu"];
  if (!VALID.includes(hari))
    return res.status(400).json({ success: false, message: `Hari tidak valid. Pilih: ${VALID.join(", ")}` });
  const fullCached = getCache("animeid_jadwal");
  if (fullCached)
    return res.json({ success: true, hari, total: fullCached.data[hari]?.length || 0, data: fullCached.data[hari] || [] });
  const full = await scrapeNontonAnimeJadwal();
  if (!full.success) return res.json(full);
  setCache("animeid_jadwal", full, 86400);
  res.json({ success: true, hari, total: full.data[hari]?.length || 0, data: full.data[hari] || [] });
});

app.get("/animeid/search", async (req, res) => {
  const { q, page } = req.query;
  if (!q || q.trim().length < 2)
    return res.status(400).json({ success: false, message: "Parameter 'q' minimal 2 karakter" });
  const pageNum = parseInt(page) || 1;
  const cacheKey = `animeid_search_${q.toLowerCase().replace(/\s+/g, "_")}_p${pageNum}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  const result = await scrapeNontonAnimeSearchPaged(q, pageNum);
  if (result.success) setCache(cacheKey, result, 300);
  res.json(result);
});

app.get("/animeid/detail/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.status(400).json({ success: false, message: "Slug diperlukan" });
  const cacheKey = `animeid_detail_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  const result = await scrapeNontonAnimeDetail(animeidAnimeUrl(slug));
  if (result.success) setCache(cacheKey, result, 600);
  res.json(result);
});

app.get("/animeid/episode/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.status(400).json({ success: false, message: "Slug diperlukan" });
  const cacheKey = `animeid_episode_${slug}`;
  
  let result = getCache(cacheKey);
  if (!result) {
    result = await scrapeNontonAnimeEpisode(animeidEpisodeUrl(slug));
    if (result.success) {
      setCache(cacheKey, result, 600);
    }
  }

  // Clone and rewrite players to use the video-proxy locally (ONLY for kotakanimeid.link)
  if (result.success && result.data && Array.isArray(result.data.players)) {
    const modifiedResult = JSON.parse(JSON.stringify(result));
    let ryuLokalCount = 0;
    modifiedResult.data.players = modifiedResult.data.players.map((p) => {
      if (p.iframe && p.iframe.includes("kotakanimeid.link")) {
        ryuLokalCount++;
        return {
          ...p,
          name: `Ryu-Lokal ${ryuLokalCount}`,
          iframe: `${getRequestBaseUrl(req)}/animeid/video-proxy?url=${encodeURIComponent(p.iframe)}`,
          streamUrl: `${getRequestBaseUrl(req)}/animeid/resolve-stream?url=${encodeURIComponent(p.iframe)}`,
        };
      }
      return p;
    });
    return res.json(modifiedResult);
  }

  res.json(result);
});

app.get("/animeid/resolve-stream", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("url required");

  try {
    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://s13.nontonanimeid.boats/",
      },
    });

    const html = response.data;

    // Decrypt and route stream URL through our proxy (error 202000 / 403)
    const encryptRegex = /var\s+([a-zA-Z0-9_$]+)\s*=\s*\[([\d,\s]+)\];\s*(?:var\s+)?([a-zA-Z0-9_$]+)\s*=\s*atob\("([^"]+)"\);/;
    const match = html.match(encryptRegex);
    if (match) {
      const keys = match[2].split(",").map(Number);
      const base64Data = match[4];
      const encryptedBytes = Buffer.from(base64Data, "base64");
      let decryptedJs = "";
      for (let i = 0; i < encryptedBytes.length; i++) {
        decryptedJs += String.fromCharCode(encryptedBytes[i] ^ keys[i % keys.length]);
      }

      const fileMatch = decryptedJs.match(/"file"\s*:\s*"([^"]+)"/);
      if (fileMatch) {
        const rawUrl = fileMatch[1];
        const streamUrl = rawUrl.replace(/\\/g, ""); // Strip backslashes if present
        const cleanCdnUrl = streamUrl.replace(/^https?:\/\//, "");
        const proxiedStreamUrl = `${getRequestBaseUrl(req)}/animeid/stream-proxy/${cleanCdnUrl}`;
        return res.redirect(proxiedStreamUrl);
      }
    }

    res.status(404).send("Stream URL not found in player page");
  } catch (err) {
    console.error("Resolve stream error:", err.message);
    res.status(502).send("Gagal mengurai stream video");
  }
});

app.get("/animeid/video-proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("url required");

  try {
    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://s13.nontonanimeid.boats/",
      },
    });

    let html = response.data;

    // Bypass frame-busting/embed domain alert check
    html = html.replace(/function\s+showAlert\s*\(\)\s*\{/g, "function showAlert() { return;");

    // Strip CSP meta tag that forces upgrade to HTTPS on localhost
    html = html.replace(/<meta http-equiv=["']Content-Security-Policy["'] content=["']upgrade-insecure-requests["']\s*\/?>/gi, "");

    // Decrypt and route stream URL through our proxy (error 202000 / 403)
    const encryptRegex = /var\s+([a-zA-Z0-9_$]+)\s*=\s*\[([\d,\s]+)\];\s*(?:var\s+)?([a-zA-Z0-9_$]+)\s*=\s*atob\("([^"]+)"\);/;
    const match = html.match(encryptRegex);
    if (match) {
      try {
        const keys = match[2].split(",").map(Number);
        const base64Data = match[4];
        const encryptedBytes = Buffer.from(base64Data, "base64");
        let decryptedJs = "";
        for (let i = 0; i < encryptedBytes.length; i++) {
          decryptedJs += String.fromCharCode(encryptedBytes[i] ^ keys[i % keys.length]);
        }

        // Extract the stream URL (e.g. https://s1.kotakanimeid.link/go/dl/?url=... or googlevideo.com)
        const fileMatch = decryptedJs.match(/"file"\s*:\s*"([^"]+)"/);
        if (fileMatch) {
          const rawUrl = fileMatch[1];
          const streamUrl = rawUrl.replace(/\\/g, ""); // Strip backslashes if present
          const cleanCdnUrl = streamUrl.replace(/^https?:\/\//, "");
          const proxiedStreamUrl = `${getRequestBaseUrl(req)}/animeid/stream-proxy/${cleanCdnUrl}`;
          decryptedJs = decryptedJs.replace(rawUrl, proxiedStreamUrl);
        }

        // Replace the entire anonymous function script tag with the decrypted and modified JS
        const scriptBlockRegex = /<script>\(function\(\)\{[\s\S]+?<\/script>/;
        html = html.replace(scriptBlockRegex, `<script>\n${decryptedJs}\n</script>`);
      } catch (decryptErr) {
        console.error("Gagal mendecrypt player script:", decryptErr.message);
      }
    }

    // Inject base href tag to make relative assets work
    const urlObj = new URL(url);
    const origin = urlObj.origin + "/";
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head><base href="${origin}">`);
    } else {
      html = `<base href="${origin}">` + html;
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Content-Type", "text/html; charset=UTF-8");
    res.send(html);
  } catch (err) {
    console.error("AnimeID video proxy error:", err.message);
    res.status(502).send("Gagal memuat video");
  }
});

app.get(/^\/animeid\/stream-proxy\/(.+)/, async (req, res) => {
  const targetPath = req.params[0];
  if (!targetPath) return res.status(400).send("Path required");

  // Reconstruct the original target URL including any query parameters (seeks/signatures)
  const queryStr = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const targetUrl = `https://${targetPath}${queryStr}`;

  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": "https://s1.kotakanimeid.link/",
    };

    // Forward Range header if requested (critical for partial content and seek in players)
    if (req.headers.range) {
      headers["Range"] = req.headers.range;
    }

    const response = await axios({
      method: "get",
      url: targetUrl,
      responseType: "stream",
      headers,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 30000,
    });

    // Handle 302/301 redirects by rewriting the location header to our stream proxy
    if (response.status === 301 || response.status === 302) {
      const redirectUrl = response.headers.location;
      if (redirectUrl) {
        const cleanRedirectUrl = redirectUrl.replace(/^https?:\/\//, "");
        const proxiedRedirectUrl = `${getRequestBaseUrl(req)}/animeid/stream-proxy/${cleanRedirectUrl}`;
        return res.redirect(proxiedRedirectUrl);
      }
    }

    // Copy stream headers from source
    if (response.headers["content-type"]) {
      res.set("Content-Type", response.headers["content-type"]);
    }
    if (response.headers["content-length"]) {
      res.set("Content-Length", response.headers["content-length"]);
    }
    if (response.headers["content-range"]) {
      res.set("Content-Range", response.headers["content-range"]);
    }
    if (response.headers["accept-ranges"]) {
      res.set("Accept-Ranges", response.headers["accept-ranges"]);
    }

    // Set CORS headers
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "*");

    // Forward the exact HTTP response status code (e.g. 206 Partial Content for Range requests)
    res.status(response.status);

    response.data.pipe(res);
  } catch (err) {
    console.error("Stream proxy error for:", targetUrl, err.message);
    res.status(502).send("Gagal mengambil stream");
  }
});

app.get("/neko/image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("url required");

  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 10000,
      headers: {
        Referer: "https://nekopoi.care/",
        "User-Agent": randomUA(),
      },
    });

    res.set("Content-Type", response.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800"); // cache 7 hari
    res.send(response.data);
  } catch (err) {
    res.status(404).send("image not found");
  }
});

app.listen(3014, "0.0.0.0", () => {
  console.log("🚀 Server jalan di http://localhost:3014");
});