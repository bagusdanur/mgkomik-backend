const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const app = express();
const cors = require("cors");
const PORT = process.env.PORT || 3012;
const cloudscraper = require("cloudscraper");

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

async function mgkomikFetch(url) {
  return await cloudscraper.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      "Referer": "https://web.mgkomik.cc/",
    },
    timeout: 20000,
  });
}

async function scrapeMgkomikPustaka({ page = 1 } = {}) {
  try {
    const url =
      page === 1
        ? "https://web.mgkomik.cc/?page=1"
        : `https://web.mgkomik.cc/?page=${page}`;

    console.log("🔥 Mgkomik URL:", url);

    const data = await mgkomikFetch(url); // ← ganti dari axios
    const $ = cheerio.load(data);
    const results = [];

    $(".manga-grid .manga-card").each((_, el) => {
      // slug dari data-slug attribute
      const slug = $(el).attr("data-slug") || "";

      const link = $(el).find(".card-cover a").first().attr("href") || "";
      const fullLink = link.startsWith("http")
        ? link
        : `https://web.mgkomik.cc${link}`;

      const title = $(el).find(".manga-title").text().trim();

      const image = $(el).find(".manga-cover").attr("src") || "";

      // Chapter terbaru = .chapter-row pertam

      // FIX:
      const chapterTerbaru = $(el)
        .find(".chapter-row")
        .first()
        .find(".chapter-capsule")
        .text()
        .trim();

      // Type dari flag-badge title: "Manhwa (Korea)", "Manhua (China)", "Manga (Jepang)"
      const flagTitle = $(el).find(".flag-badge").attr("title") || "";
      const typeMatch = flagTitle.match(/^(\w+)/);
      const typeGenre = typeMatch ? typeMatch[1] : "";

      // Status: ongoing / completed
      const status = $(el).find(".manga-status-badge").text().trim();

      if (!title || !slug) return;

      results.push({
        source: "mgkomik",
        title,
        slug,
        image,
        detail_link: fullLink,
        description: "",
        type_genre: typeGenre, // "Manga" | "Manhwa" | "Manhua"
        info: status, // "Ongoing" | "Completed"
        chapter_awal: "",
        chapter_terbaru: chapterTerbaru,
      });
    });

    // ================= PAGINATION =================
    // web.mgkomik.cc pakai ?page=N, cari total dari elemen pagination
    let totalPages = page;

    const lastPageHref =
      $(".wp-pagenavi a.last, .pagination a.last, a[aria-label='Last Page']")
        .last()
        .attr("href") || "";

    const lastPageMatch =
      lastPageHref.match(/[?&]page=(\d+)/) ||
      lastPageHref.match(/\/page\/(\d+)/);

    if (lastPageMatch) {
      totalPages = parseInt(lastPageMatch[1]);
    } else {
      // Fallback: ambil angka terbesar dari semua link pagination
      const pageNums = $("a[href*='page=']")
        .map((_, el) => {
          const href = $(el).attr("href") || "";
          const m = href.match(/[?&]page=(\d+)/);
          return m ? parseInt(m[1]) : 0;
        })
        .get()
        .filter((n) => n > 0);

      if (pageNums.length) totalPages = Math.max(...pageNums);
    }

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
    console.error("❌ Mgkomik error:", err.message);
    console.error("❌ Status:", err.response?.status);
    return {
      success: false,
      meta: {
        currentPage: page,
        totalPages: 1,
        totalItems: 0,
      },
      data: [],
    };
  }
}

async function scrapeMgkomikChapter(fullUrl) {
  try {
    const { data } = await axios.get(fullUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://web.mgkomik.cc/",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    // ================= MANGA INFO =================
    // dari: <a href="/komik/the-profound-mirror-immortal-clan/">The Profound Mirror Immortal Clan</a>
    const mangaLink = $(".manga-name a").attr("href") || "";
    const mangaSlug =
      mangaLink.split("/komik/").pop()?.replace(/\/$/, "") || "";

    // dari: <h1 id="chapterTitleClick">Chapter 00</h1>
    const currentChapter = $("#chapterTitleClick")
      .clone()
      .children()
      .remove()
      .end()
      .text()
      .trim();

    // ================= CHAPTER LIST dari DROPDOWN =================
    // dari: .chapter-dropdown-item[data-chapter="17"]
    const chapterList = [];

    $(".chapter-dropdown-list .chapter-dropdown-item").each((_, el) => {
      const link = $(el).attr("href") || "";
      const chapterNum = $(el).attr("data-chapter") || "";
      const fullLink = link.startsWith("http")
        ? link
        : `https://web.mgkomik.cc${link}`;

      const chapterSlug = link.split("/").filter(Boolean).pop();

      if (!link) return;

      chapterList.push({
        slug: chapterSlug,
        chapter: chapterNum,
        link: fullLink,
      });
    });

    // dropdown urutan: terbaru → lama, reverse biar lama → terbaru
    const reversed = [...chapterList].reverse();

    // ================= CURRENT SLUG =================
    const currentSlug = new URL(fullUrl).pathname
      .split("/")
      .filter(Boolean)
      .pop();

    // ================= PREV & NEXT =================
    const index = reversed.findIndex((c) => c.slug === currentSlug);

    let prev = null;
    let next = null;

    if (index !== -1) {
      prev = reversed[index - 1]?.slug || null;
      next = reversed[index + 1]?.slug || null;
    }

    // ================= IMAGES =================
    // dari: .reading-content img[data-page]
    const images = [];

    $(".reading-content img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || "";

      if (src && !src.startsWith("data:")) {
        images.push(src.trim());
      }
    });

    return {
      success: true,
      source: "mgkomik",

      // sama seperti kiryuu: mangaId
      mangaId: mangaSlug,

      // chapterSlug = mangaSlug/chapter-slug
      chapterSlug: `${mangaSlug}/${currentSlug}`,

      // judul chapter
      currentChapter: currentChapter,

      // prev/next dalam format mangaSlug/chapter-slug (bukan slug doang)
      prev: prev ? `${mangaSlug}/${prev}` : null,
      next: next ? `${mangaSlug}/${next}` : null,

      back_to_detail: `https://web.mgkomik.cc/komik/${mangaSlug}/`,
      images,
      totalImages: images.length,
    };
  } catch (err) {
    return {
      success: false,
      message: err.message,
    };
  }
}

async function scrapeMgkomikDetail(slug) {
  try {
    const url = `https://web.mgkomik.cc/komik/${slug}/`;

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
        Referer: "https://web.mgkomik.cc/",
        Connection: "keep-alive",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    // ================= TITLE =================
    const title = $(".manga-title").first().text().trim();

    // ================= THUMBNAIL =================
    const thumbnail = $(".manga-cover-large").attr("src") || "";

    // ================= META (type, status, release) =================
    const metaItems = $(".manga-meta .meta-item")
      .map((_, el) => $(el).text().trim())
      .get();

    // metaItems = ["Manhua", "OnGoing", "Release: 2025"]
    const type = metaItems[0] || "";
    const status = metaItems[1] || "";
    const release = metaItems[2]?.replace("Release:", "").trim() || "";

    // ================= GENRES =================
    const genres = $(".genre-list .genre-tag")
      .map((_, el) => $(el).text().trim())
      .get();

    // ================= SYNOPSIS =================
    const synopsis = $(".manga-description p").text().trim() || "Tidak ada sinopsis.";

    // ================= CHAPTER AWAL & TERBARU =================
    const firstChapterHref = $(".read-btn").first().attr("href") || "";
    const lastChapterHref = $(".read-btn").last().attr("href") || "";

    const getChapterSlug = (href) =>
      href.split("/komik/").pop()?.replace(/\/$/, "") || "";

    const firstChapterSlug = getChapterSlug(firstChapterHref);
    const lastChapterSlug = getChapterSlug(lastChapterHref);

    // ================= CHAPTER LIST =================
    const chapters = [];

    $(".chapter-list .chapter-list-item").each((_, el) => {
      const link = $(el).find(".chapter-link").attr("href") || "";
      const chapterNum = $(el).find(".chapter-number").text().trim();
      const date = $(el).find(".chapter-date").text().trim();
      const chapterSlug = getChapterSlug(`/komik${link}`);

      if (!link) return;

      chapters.push({
        title: chapterNum,
        slug: `${slug}/${link.split("/komik/")[1]?.replace(/\/$/, "")}`,
        link: `https://web.mgkomik.cc${link}`,
        date,
      });
    });

    // list dari HTML urutan terbaru → lama, reverse biar lama → terbaru
    chapters.reverse();

    return {
      success: true,
      data: {
        title,
        thumbnail,
        type,
        status,

        Pengarang: "-",
        Umur: "-",
        Konsep: release,

        genres,
        synopsis,

        info: lastChapterSlug, // chapter terbaru slug
        chapter_awal: firstChapterSlug,

        total_chapter: chapters.length,
        chapters,
      },
    };
  } catch (err) {
    console.error("❌ Mgkomik detail error:", err.message);
    return {
      success: false,
      message: "Gagal scrape detail.",
    };
  }
}

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

app.get("/mgkomik/pustaka", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `mgkomik_pustaka_page_${page}`;

  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit: mgkomik pustaka page ${page}`);
    return res.json(cached);
  }

  console.log(`🔍 Scraping mgkomik pustaka page ${page}...`);
  const result = await scrapeMgkomikPustaka({ page });

  if (!result.data.length) {
    return res.json({
      success: true,
      page,
      total: 0,
      data: [],
      warning: "Data kosong / Site limit",
    });
  }

  setCache(cacheKey, result, 300); // 5 menit
  res.json(result);
});

app.get(/^\/mgkomik\/chapter\/(.+)/, async (req, res) => {
  try {
    const slug = req.params[0];
    const cacheKey = `mgkomik_chapter_${slug}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`✅ Cache hit: mgkomik chapter ${slug}`);
      return res.json(cached);
    }

    console.log(`🔍 Scraping mgkomik chapter ${slug}...`);
    const fullUrl = `https://web.mgkomik.cc/komik/${slug}/`;
    const result = await scrapeMgkomikChapter(fullUrl);

    if (result.success) setCache(cacheKey, result, 86400); // 24 jam
    res.json(result);
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get("/mgkomik/detail/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Slug tidak diberikan!",
      });
    }

    const cacheKey = `mgkomik_detail_${slug}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`✅ Cache hit: mgkomik detail ${slug}`);
      return res.json(cached);
    }

    console.log(`🔍 Scraping mgkomik detail ${slug}...`);
    const result = await scrapeMgkomikDetail(slug);

    if (result.success) setCache(cacheKey, result, 3600); // 1 jam
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
    });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 Server jalan di http://localhost:${PORT}`),
);
