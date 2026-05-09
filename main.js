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
  return new Promise((r) => setTimeout(r, ms));
}

// ✅ FIX 1: Timeout lebih pendek (8 detik)
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

// ✅ FIX 2: Retry lebih cepat, delay lebih pendek
async function fetchRetry(url, options = {}, retries = 2) {
  try {
    return await axiosInstance.get(url, {
      ...options,
      headers: {
        ...options.headers,
        "User-Agent": randomUA(),
        Referer: BASE_URL + "/",
      },
    });
  } catch (err) {
    if (retries <= 0) throw err;

    const delay = err.response?.status === 403 ? 1500 : 500;
    console.log(
      `🔁 Retry (${retries} left) [${err.response?.status || err.code}]: ${url}`,
    );
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
  if (Date.now() > item.expire) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

// ================= HELPERS =================
const extractSlug = (href) => {
  if (!href) return "";
  return href.replace(/\/$/, "").split("/").pop();
};

function buildUrl(slug) {
  return `${BASE_URL}/${slug}/`;
}
function buildAnimeUrl(slug) {
  return `${BASE_URL}/anime/${slug}/`;
}

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
      const value = $(el)
        .clone()
        .children(".detail-label")
        .remove()
        .end()
        .text()
        .trim();
      if (label && value) details[label] = value;
    });

    // ================= HARDCODE 1-28 + REAL DATA =================
    const baseSlug = extractSlug(url); // "digimon-beatbreak"
    const episodeList = [];

    // 1. Real episodes dari HTML (dengan date)
    article.find(".episode-list-items .episode-item").each((i, el) => {
      const slug = extractSlug($(el).attr("href") || "");
      const epNum = parseInt(slug.match(/episode-(\d+)$/)?.[1] || 0);

      episodeList[epNum - 1] = {
        // index 0 = ep1
        title: $(el).find(".ep-title").text().trim(),
        date: $(el).find(".ep-date").text().trim(),
        slug,
        source: "html",
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
          source: "html",
        };
      }
    });

    // 3. First & Last
    if (firstEpEl.length) {
      const slug = extractSlug(firstEpEl.attr("href") || "");
      const epNum = parseInt(slug.match(/(\d+)$/)?.[1] || 1);
      if (epNum > 0 && epNum <= totalEpisodes) {
        episodeList[epNum - 1] = {
          title: firstEpEl
            .clone()
            .children(".ep-label, .watched-status")
            .remove()
            .end()
            .text()
            .trim(),
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
          title: lastEpEl
            .clone()
            .children(".ep-label, .watched-status")
            .remove()
            .end()
            .text()
            .trim(),
          date: "",
          slug,
          source: "meta",
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
          source: "hardcode",
        };
      }
    }

    // 5. Clean & return
    const cleanEpisodeList = episodeList
      .slice(0, totalEpisodes)
      .filter(Boolean);

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
        status: article
          .find(".info-item.status-airing, .info-item.status-finished")
          .text()
          .trim(),
        episodes: article
          .find(".anime-card__quick-info .info-item")
          .eq(1)
          .text()
          .trim(),
        duration: article
          .find(".anime-card__quick-info .info-item")
          .eq(2)
          .text()
          .trim(),
        season: {
          name: article.find(".info-item.season a").text().trim(),
          slug: extractSlug(
            article.find(".info-item.season a").attr("href") || "",
          ),
        },
        firstEpisode: {
          label: firstEpEl.find(".ep-label").text().trim(),
          title: firstEpEl
            .clone()
            .children(".ep-label, .watched-status")
            .remove()
            .end()
            .text()
            .trim(),
          slug: extractSlug(firstEpEl.attr("href") || ""),
        },
        lastEpisode: {
          label: lastEpEl.find(".ep-label").text().trim(),
          title: lastEpEl
            .clone()
            .children(".ep-label, .watched-status")
            .remove()
            .end()
            .text()
            .trim(),
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
    const cookies =
      res.headers["set-cookie"]?.map((c) => c.split(";")[0]).join("; ") || "";
    const $ = cheerio.load(res.data);

    let nonce = "",
      ajaxUrl = "";
    const scriptSrc = $("#ajax_video-js-extra").attr("src") || "";
    if (scriptSrc.includes("base64,")) {
      const decoded = Buffer.from(
        scriptSrc.split("base64,")[1],
        "base64",
      ).toString("utf-8");
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
        iframe:
          i === activeIndex && defaultIframe
            ? defaultIframe
            : await getPlayer(srv),
      })),
    );

    const downloads = [];
    $("#download_area .listlink a").each((i, el) => {
      downloads.push({ name: $(el).text().trim(), url: $(el).attr("href") });
    });

    const slugFromHref = (href) =>
      href ? href.replace(BASE_URL, "").replace(/\//g, "") : "";

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
        prev: slugFromHref(
          prevEl.find(".dashicons-dismiss").length
            ? ""
            : prevEl.find("a").attr("href") || "",
        ),
        allEpisode: allEpisodeHref
          ? allEpisodeHref.replace(/\/$/, "").split("/").filter(Boolean).pop()
          : "",
        next: slugFromHref(
          nextEl.find(".dashicons-dismiss").length
            ? ""
            : nextEl.find("a").attr("href") || "",
        ),
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

// ================= SCRAPER: JADWAL =================
// Tambahkan fungsi ini ke server.js kamu (sebelum bagian ROUTES)

async function scrapeNontonAnimeJadwal() {
  try {
    const res = await fetchRetry(`${BASE_URL}/jadwal-rilis/`);
    const $ = cheerio.load(res.data);

    const HARI = [
      "senin",
      "selasa",
      "rabu",
      "kamis",
      "jumat",
      "sabtu",
      "minggu",
    ];
    const jadwal = {};

    HARI.forEach((hari) => {
      const items = [];

      $(`#${hari} .as-anime-card`).each((i, el) => {
        const href = $(el).attr("href") || "";
        const slug = href.replace(/\/$/, "").split("/").filter(Boolean).pop();
        const status = $(el).attr("data-status") || "on-schedule"; // "on-schedule" | "delayed"

        const isDelayed = status === "delayed";

        // jam tayang atau info libur
        const releaseTime = isDelayed
          ? $(el).find(".as-delay-details").text().replace("Info:", "").trim()
          : $(el).find(".as-release-time").text().replace("🕒", "").trim();

        // rating, type, episodes — pakai class spesifik, strip icon emoji
        const rating = $(el)
          .find(".as-rating")
          .clone()
          .children(".icon")
          .remove()
          .end()
          .text()
          .trim();
        const type = $(el)
          .find(".as-type")
          .clone()
          .children(".icon")
          .remove()
          .end()
          .text()
          .trim();
        const episodes = $(el)
          .find(".as-episodes")
          .clone()
          .children(".icon")
          .remove()
          .end()
          .text()
          .trim();

        items.push({
          title: $(el).find(".as-anime-title").text().trim(),
          thumbnail: $(el).find("img").attr("src") || "",
          slug,
          status, // "on-schedule" | "delayed"
          rating, // "8.91"
          type, // "TV" | "ONA"
          episodes, // "4 / 19"
          releaseTime, // "21:10 WIB" atau "Rilis Kembali 8 Mei"
        });
      });

      jadwal[hari] = items;
    });

    // hari aktif dari tab HTML (biasanya hari ini)
    const activeDay = $(".as-tab-link.active").attr("data-tab") || "senin";

    return {
      success: true,
      activeDay,
      data: jadwal,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape jadwal: " + err.message };
  }
}

// ================= SCRAPER: SEARCH WITH PAGE =================
async function scrapeNontonAnimeSearchPaged(query, page = 1) {
  try {
    const encodedQuery = encodeURIComponent(query);
    // Format URL pagination: /page/2/?s=classroom
    const pagePath = page > 1 ? `/page/${page}` : "";
    const url = `${BASE_URL}${pagePath}/?s=${encodedQuery}`;

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

      const rating = $(el)
        .find(".as-rating")
        .clone()
        .children(".icon")
        .remove()
        .end()
        .text()
        .trim();
      const type = $(el)
        .find(".as-type")
        .clone()
        .children(".icon")
        .remove()
        .end()
        .text()
        .trim();
      const season = $(el)
        .find(".as-season")
        .clone()
        .children(".icon")
        .remove()
        .end()
        .text()
        .trim();

      const genres = [];
      $(el)
        .find(".as-genres .as-genre-tag")
        .each((j, genreEl) => {
          genres.push($(genreEl).text().trim());
        });

      items.push({
        title: $(el).find(".as-anime-title").text().trim(),
        thumbnail,
        slug,
        url: href,
        rating: rating || null,
        type: type || null,
        season: season || null,
        synopsis: $(el).find(".as-synopsis").text().trim(),
        genres,
      });
    });

    // Pagination parsing
    const currentPage = $(".wp-pagenavi .current").text().trim();
    const hasNext = $(".wp-pagenavi .nextpostslink").length > 0;
    const hasPrev = $(".wp-pagenavi .prevpostslink").length > 0;
    const totalPagesText = $(".wp-pagenavi .pages").text().trim();

    // Extract total pages dari text "Halaman 1 dari 3"
    const totalMatch = totalPagesText.match(/dari\s+(\d+)/);
    const totalPages = totalMatch ? parseInt(totalMatch[1]) : 1;

    return {
      success: true,
      query,
      page: parseInt(currentPage) || page,
      totalPages,
      totalResults: items.length,
      hasNext,
      hasPrev,
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape search: " + err.message };
  }
}

const BASE_URLs = "https://nekopoi.care";
const WORKER_URL = "https://sekte.ezcantik9.workers.dev";

function buildNekoUrl(slug) {               // ✅ was: buildUrl (konflik!)
  return `${BASE_URLs}/${slug}/`;
}

function slugFromHref(href = "") {
  if (!href) return "";
  return href.replace(/\/$/, "").split("/").filter(Boolean).pop() || "";
}

// ✅ Ubah ini — fetch lewat CF Worker
async function fetchHtml(url) {
  const { data } = await axios.get(`${WORKER_URL}?url=${encodeURIComponent(url)}`, {
    timeout: 15000,
  });
  return data;
}
// ─── Scraper: Halaman Episode ─────────────────────────────────────────────────
/**
 * Scrape halaman episode nekopoi
 * Contoh URL: https://nekopoi.care/chimimonryou-episode-1-subtitle-indonesia/
 */
// ─── Scraper: Episode ─────────────────────────────────────────────────────────
async function scrapeNekopoiEpisode(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
 
    // ── Players ──────────────────────────────────────────────────────────────
    // Struktur: #nk-stream-1, #nk-stream-2, #nk-stream-3
    // Tab label: #nk-player-tabs a
    const players = [];
    $("#nk-player-tabs a").each((i, tabEl) => {
      const tabId = $(tabEl).attr("href"); // contoh: "#nk-stream-1"
      if (!tabId || tabId === "#") return;
      const frameId = tabId.replace("#", ""); // "nk-stream-1"
      const iframe = $(`#${frameId} iframe`);
      const src = iframe.attr("src") || "";
      if (src) {
        players.push({
          label: $(tabEl).text().trim(), // "Server 1"
          src,
        });
      }
    });
 
    // ── Downloads ─────────────────────────────────────────────────────────────
    // Struktur: .nk-download-box > .nk-download-row
    //   .nk-download-name = nama/resolusi
    //   .nk-download-links a = link download
    const downloads = [];
    $(".nk-download-box .nk-download-row").each((_, row) => {
      const quality = $(row).find(".nk-download-name").text().trim();
      const links = [];
      $(row).find(".nk-download-links a").each((_, a) => {
        links.push({
          label: $(a).text().trim(),   // "KrakenFiles", "Mp4Upload", dll
          href: $(a).attr("href") || "",
        });
      });
      if (quality || links.length) downloads.push({ quality, links });
    });
 
    // ── Navigasi prev / next ──────────────────────────────────────────────────
    // Struktur: .nk-episode-nav (kosong di halaman ini, tapi strukturnya ada)
    const prevEl = $(".nk-episode-nav .nav-previous, .nav-previous").first();
    const nextEl = $(".nk-episode-nav .nav-next, .nav-next").first();
 
    // ── All Episode (link seri) ───────────────────────────────────────────────
    // Struktur: a.nk-player-series[href="/hentai/slug/"]
    const allEpisodeHref = $("a.nk-player-series").attr("href") || "";
 
    // ── Thumbnail ─────────────────────────────────────────────────────────────
    // Struktur: .nk-featured-img img
    const thumbnail =
      $(".nk-featured-img img").attr("src") ||
      $("meta[property='og:image']").attr("content") ||
      "";
 
    // ── Judul ─────────────────────────────────────────────────────────────────
    // Struktur: .nk-post-header h1
    const entryTitle = $(".nk-post-header h1").text().trim();
 
    // ── Tanggal ───────────────────────────────────────────────────────────────
    // Struktur: .nk-post-header-meta span (teks: "Selasa, 5 Mei 2026")
    // Tidak ada tag <time>, ambil dari span kedua
    const dateMeta = $(".nk-post-header-meta span").eq(1).text().trim();
 
    // ── Info konten (sinopsis, genre, producer, durasi, size) ─────────────────
    // Struktur: .konten p
    const synopsis = $(".konten p").first().text().trim();
 
    const genreRaw = $(".konten p:contains('Genre')").text().replace("Genre :", "").trim();
    const genres = genreRaw
      ? genreRaw.split(",").map((g) => g.trim()).filter(Boolean)
      : [];
 
    const producer = $(".konten p:contains('Producers')").text().replace("Producers :", "").trim();
    const duration = $(".konten p:contains('Duration')").text().replace("Duration :", "").trim();
    const size     = $(".konten p:contains('Size')").text().replace("Size :", "").trim();
 
    return {
      success: true,
      data: {
        entryTitle,
        // Tidak ada .entry-title / .name di tema ini, pakai nk-post-header h1
        title: entryTitle,
        thumbnail,
        date: {
          raw: dateMeta,       // "Selasa, 5 Mei 2026"
          formatted: dateMeta,
        },
        // Tidak ada author di halaman episode
        author: "",
        synopsis,
        genres,
        producer,
        duration,
        size,
        players,
        downloads,
        prev: (() => {
          const hasDismiss = prevEl.find(".dashicons-dismiss").length > 0;
          return slugFromHref(hasDismiss ? "" : prevEl.find("a").attr("href") || "");
        })(),
        next: (() => {
          const hasDismiss = nextEl.find(".dashicons-dismiss").length > 0;
          return slugFromHref(hasDismiss ? "" : nextEl.find("a").attr("href") || "");
        })(),
        allEpisode: allEpisodeHref
          ? allEpisodeHref.replace(/\/$/, "").split("/").filter(Boolean).pop()
          : "",
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape episode: " + err.message };
  }
}
 

function buildAnimeUrls(slug) {
  return `${BASE_URLs}/hentai/${slug}/`;
  // hasil: https://nekopoi.care/hentai/chimimonryou/
}
// ─── Scraper: Halaman Anime (daftar episode) ──────────────────────────────────
// ─── Scraper: Anime Detail ────────────────────────────────────────────────────
async function scrapeNekopoiDetail(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
 
    // ── Poster / Thumbnail ────────────────────────────────────────────────────
    // Struktur: .nk-series-poster (background-image style)
    const posterStyle = $(".nk-series-poster").attr("style") || "";
    const posterMatch = posterStyle.match(/url\(['"]?(.*?)['"]?\)/);
    const thumbnail = posterMatch ? posterMatch[1] : "";
 
    // ── Judul ─────────────────────────────────────────────────────────────────
    // Struktur: .nk-series-info h2
    const title = $(".nk-series-info h2")
      .clone()
      .children()
      .remove()
      .end()
      .text()
      .trim()
      .replace(/^Unduh\s+[""]|[""].*$/g, "")
      .trim();
 
    // ── Synopsis ──────────────────────────────────────────────────────────────
    // Struktur: .nk-series-synopsis p (skip div.nk-latest-episode)
    const synopsis = $(".nk-series-synopsis p").text().trim();
 
    // ── Meta list ─────────────────────────────────────────────────────────────
    // Struktur: .nk-series-meta-list ul li
    // Format: <b>Key</b>: value
    const meta = {};
    $(".nk-series-meta-list ul li").each((_, el) => {
      const key = $(el).find("b").text().trim().replace(":", "").toLowerCase();
      // Ambil teks setelah <b>, strip leading ": "
      const val = $(el).clone().children("b").remove().end().text().trim().replace(/^:\s*/, "");
      if (key) meta[key] = val;
    });
 
    // Genre dari link di dalam meta list
    const genres = [];
    $(".nk-series-meta-list ul li").filter((_, el) => {
      return $(el).find("b").text().toLowerCase().includes("genre");
    }).find("a").each((_, a) => {
      genres.push({
        name: $(a).text().trim(),
        slug: slugFromHref($(a).attr("href") || ""),
      });
    });
 
    // ── Episode terbaru (dari .nk-latest-episode) ─────────────────────────────
    // Struktur: .nk-latest-episode .latestepisode + .latestnow a
    const latestEpisodeLabel = $(".latestepisode").text().trim();  // "Episode 1"
    const latestEpisodeHref  = $(".latestnow a").attr("href") || "";
 
    // ── Daftar Episode ────────────────────────────────────────────────────────
    // Struktur: .nk-episode-grid ul li a.nk-episode-card
    const episodeList = [];
    $(".nk-episode-grid ul li").each((_, el) => {
      const a     = $(el).find("a.nk-episode-card");
      const href  = a.attr("href") || "";
 
      // Thumb dari background-image style
      const thumbStyle = a.find(".nk-episode-card-thumb").attr("style") || "";
      const thumbMatch = thumbStyle.match(/url\(['"]?(.*?)['"]?\)/);
      const thumb = thumbMatch ? thumbMatch[1] : "";
 
      episodeList.push({
        slug:  slugFromHref(href),
        label: a.find(".nk-episode-badge").text().trim(),   // "Ep 1"
        title: a.find(".nk-episode-card-title").text().trim(),
        date:  a.find(".nk-episode-card-date").text().trim(),
        thumbnail: thumb,
        href,
      });
    });
 
    // First & last episode
    const firstEpisode = episodeList[episodeList.length - 1] || null;
    const lastEpisode  = episodeList[0] || null;
 
    return {
      success: true,
      data: {
        title,
        thumbnail,
        // Meta dari .nk-series-meta-list
        japaneseTitle: meta["judul jepang"] || "",
        type:          meta["jenis"] || "",
        totalEpisodes: meta["episode"] || "",
        status:        meta["status"] || "",
        aired:         meta["tayang"] || "",
        producer:      meta["produser"] || "",
        duration:      meta["durasi"] || "",
        score:         meta["skor"] || "",
        genres,
        synopsis,
        latestEpisode: {
          label: latestEpisodeLabel,
          slug:  slugFromHref(latestEpisodeHref),
          href:  latestEpisodeHref,
        },
        firstEpisode,
        lastEpisode,
        // Index 0 = episode terbaru, index terakhir = episode pertama
        episodeList,
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape detail: " + err.message };
  }
}


function buildTerbaruUrl(page = 1) {
  if (page <= 1) return `${BASE_URLs}/category/hentai/`;
  return `${BASE_URLs}/category/hentai/page/${page}/`;
}

function slugFromHrefs(href = "") {
  if (!href) return "";
  return href.replace(/\/$/, "").split("/").filter(Boolean).pop() || "";
}

// ─── Scraper: Terbaru ─────────────────────────────────────────────────────────
async function scrapeNekopoiTerbaru(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
 
    // Pagination info
    // Struktur: .nav-links .page-numbers
    const currentPage = parseInt($(".page-numbers.current").text().trim()) || 1;
    const lastPageEl = $(".page-numbers:not(.next):not(.prev):not(.dots)").last();
    const totalPages = parseInt(lastPageEl.text().trim()) || 1;
    const hasNext = $("a.next.page-numbers").length > 0;
    const hasPrev = $("a.prev.page-numbers").length > 0;
 
    const items = [];
 
    // Struktur: .nk-search-results ul li a.nk-search-item
    $(".nk-search-results ul li").each((_, el) => {
      const a    = $(el).find("a.nk-search-item");
      const href = a.attr("href") || "";
      const slug = slugFromHrefs(href);
 
      // Thumbnail dari background-image style
      const thumbStyle = a.find(".nk-search-thumb").attr("style") || "";
      const thumbMatch = thumbStyle.match(/url\(['"]?(.*?)['"]?\)/);
      const thumbnail  = thumbMatch ? thumbMatch[1] : "";
 
      const title = a.find("h2").text().trim();
      const desc  = a.find(".nk-search-desc").text().trim();
 
      // Extract episode number dari judul
      // Contoh: "Episode 1", "Episode 3", dll
      const epMatch = title.match(/episode\s+(\d+)/i);
      const latestEpisode = epMatch ? parseInt(epMatch[1]) : null;
 
      // Extract tag prefix: [NEW Release], [UNCENSORED], [4K], [BATCH], [PREVIEW]
      const tagMatch = title.match(/^\[([^\]]+)\]/);
      const tag = tagMatch ? tagMatch[1] : "";
 
      items.push({
        title,
        tag,
        thumbnail,
        slug,
        latestEpisode,
        desc,
        url: href,
      });
    });
 
    return {
      success: true,
      total: items.length,
      pagination: {
        currentPage,
        totalPages,
        hasNext,
        hasPrev,
        nextPage: hasNext ? currentPage + 1 : null,
        prevPage: hasPrev ? currentPage - 1 : null,
      },
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape terbaru: " + err.message };
  }
}


function buildSearchUrl(query, page = 1) {
  const encoded = encodeURIComponent(query);
  if (page <= 1) return `${BASE_URLs}/search/${encoded}/`;
  return `${BASE_URLs}/search/${encoded}/page/${page}/`;
}

async function scrapeNekopoiSearch(query, page = 1) {
  try {
    const url = buildSearchUrl(query, page);
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const items = [];

    $(".nk-search-results ul li").each((_, el) => {
      const a = $(el).find("a.nk-search-item");
      const href = a.attr("href") || "";
      const slug = slugFromHrefs(href);

      // Thumbnail dari background-image
      const thumbStyle = a.find(".nk-search-thumb").attr("style") || "";
      const thumbMatch = thumbStyle.match(/url\(['"]?(.*?)['"]?\)/);
      const thumbnail = thumbMatch ? thumbMatch[1] : "";

      const title = a.find("h2").text().trim();
      const desc = a.find(".nk-search-desc").text().trim();

      // Extract tag prefix: [NEW Release], [UNCENSORED], [4K], [3D], [L2D], dll
      const tagMatch = title.match(/^\[([^\]]+)\]/);
      const tag = tagMatch ? tagMatch[1] : "";

      // Extract episode number dari judul
      const epMatch = title.match(/episode\s+(\d+)/i);
      const latestEpisode = epMatch ? parseInt(epMatch[1]) : null;

      items.push({
        title,
        tag,
        thumbnail,
        slug,
        latestEpisode,
        desc,
        url: href,
      });
    });

    // Pagination
    const currentPage = parseInt($(".page-numbers.current").text().trim()) || page;
    const lastPageEl = $(".nav-links .page-numbers:not(.next):not(.prev):not(.dots)").last();
    const totalPages = parseInt(lastPageEl.text().trim()) || 1;
    const hasNext = $("a.next.page-numbers").length > 0;
    const hasPrev = $("a.prev.page-numbers").length > 0;

    return {
      success: true,
      query,
      pagination: {
        currentPage,
        totalPages,
        hasNext,
        hasPrev,
        nextPage: hasNext ? currentPage + 1 : null,
        prevPage: hasPrev ? currentPage - 1 : null,
      },
      total: items.length,
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape search: " + err.message };
  }
}

app.get("/nekopoi/search", async (req, res) => {
  const { q, page } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({
      success: false,
      message: "Parameter 'q' minimal 2 karakter",
    });
  }

  const pageNum = parseInt(page) || 1;
  const cacheKey = `neko_search_${q.toLowerCase().replace(/\s+/g, "_")}_p${pageNum}`;
  const cached = getCache(cacheKey);

  if (cached) {
    console.log(`✅ Cache hit: ${cacheKey}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping nekopoi search: "${q}" page ${pageNum}`);

  const result = await scrapeNekopoiSearch(q, pageNum);

  if (result.success) {
    setCache(cacheKey, result, 300); // cache 5 menit
  }

  res.json(result);
});


app.get("/nekopoi/terbaru", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `terbaru_${page}`;
  const cached = getCache(cacheKey);

  if (cached) {
    console.log(`✅ Cache hit: ${cacheKey}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping terbaru page ${page}...`);

  const url = buildTerbaruUrl(page);

  const result = await scrapeNekopoiTerbaru(url);

  if (result.success) {
    setCache(cacheKey, result, 120); // cache 2 menit
  }

  res.json(result);
});


app.get("/nekopoi/episode/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug)
    return res.status(400).json({ success: false, message: "Slug diperlukan" });

  const cacheKey = `nekopoi_episode_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit: ${cacheKey}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping episode: ${slug}`);
  const result = await scrapeNekopoiEpisode(buildNekoUrl(slug));

  if (result.success) setCache(cacheKey, result, 60 * 60 * 24 * 7); // ✅ cache 7 hari (dalam detik)

  res.json(result);
});


app.get("/nekopoi/detail/:slug", async (req, res) => {
  const { slug } = req.params;

  if (!slug) {
    return res.status(400).json({
      success: false,
      message: "Slug diperlukan",
    });
  }

  const cacheKey = `nekopoi_detail_${slug}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit: ${cacheKey}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping detail: ${slug}`);

  const result = await scrapeNekopoiDetail(buildAnimeUrls(slug));

  if (result.success) setCache(cacheKey, result, 60 * 60 * 24); // ✅ cache 1 hari (dalam detik)

  res.json(result);
});


// ================= ROUTE: SEARCH WITH PAGE =================
app.get("/animeid/search", async (req, res) => {
  const { q, page } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({
      success: false,
      message: "Parameter 'q' minimal 2 karakter",
    });
  }

  const pageNum = parseInt(page) || 1;
  const cacheKey = `search_${q.toLowerCase().replace(/\s+/g, "_")}_p${pageNum}`;
  const cached = getCache(cacheKey);

  if (cached) {
    console.log(`✅ Cache hit: ${cacheKey}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping search: "${q}" page ${pageNum}`);
  const result = await scrapeNontonAnimeSearchPaged(q, pageNum);

  if (result.success) {
    setCache(cacheKey, result, 300); // cache 5 menit
  }

  res.json(result);
});

// ================= ROUTES: JADWAL =================
// Tambahkan kedua route ini ke server.js kamu (di bagian ROUTES)

// GET /animeid/jadwal → semua hari sekaligus
app.get("/animeid/jadwal", async (req, res) => {
  const cached = getCache("jadwal");
  if (cached) {
    console.log("✅ Cache hit: jadwal");
    return res.json(cached);
  }

  console.log("🔍 Scraping jadwal...");
  const result = await scrapeNontonAnimeJadwal();
  if (result.success) setCache("jadwal", result, 86400); // cache 1 jam
  res.json(result);
});

// GET /animeid/jadwal/:hari → filter per hari, contoh: /animeid/jadwal/sabtu
app.get("/animeid/jadwal/:hari", async (req, res) => {
  const { hari } = req.params;
  const VALID = [
    "senin",
    "selasa",
    "rabu",
    "kamis",
    "jumat",
    "sabtu",
    "minggu",
  ];

  if (!VALID.includes(hari)) {
    return res.status(400).json({
      success: false,
      message: `Hari tidak valid. Pilih: ${VALID.join(", ")}`,
    });
  }

  // coba ambil dari cache full dulu
  const fullCached = getCache("jadwal");
  if (fullCached) {
    return res.json({
      success: true,
      hari,
      total: fullCached.data[hari]?.length || 0,
      data: fullCached.data[hari] || [],
    });
  }

  // kalau belum ada, scrape lalu cache full
  console.log(`🔍 Scraping jadwal untuk: ${hari}`);
  const full = await scrapeNontonAnimeJadwal();
  if (!full.success) return res.json(full);

  setCache("jadwal", full, 86400);
  res.json({
    success: true,
    hari,
    total: full.data[hari]?.length || 0,
    data: full.data[hari] || [],
  });
});

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
});

// ✅ FIX 5: Cache per slug yang benar
app.get("/animeid/detail/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug)
    return res.status(400).json({ success: false, message: "Slug diperlukan" });

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
  if (!slug)
    return res.status(400).json({ success: false, message: "Slug diperlukan" });

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



app.listen(PORT, () =>
  console.log(`🚀 Server jalan di http://localhost:${PORT}`),
);
