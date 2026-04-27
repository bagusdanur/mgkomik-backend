const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3012;

const BASE_URL = "https://s13.nontonanimeid.boats";

// Helper: build full URL from slug
// Helper: build full URL from slug
function buildUrl(slug) {
  return `${BASE_URL}/${slug}/`;
}

const extractSlug = (href) => {
  if (!href) return "";
  return href.replace(/\/$/, "").split("/").pop();
};
 
// Helper: build anime detail URL from slug
function buildAnimeUrl(slug) {
  return `${BASE_URL}/anime/${slug}/`;
}

// ================= SCRAPER: ONGOING LIST =================
async function scrapeNontonAnimeOngoing() {
  try {
    const url = `${BASE_URL}/ongoing-list/`;
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: BASE_URL + "/",
      },
    });
 
    const $ = cheerio.load(res.data);
 
    const seasonName = $(".as-season-name").text().trim();
    const seasonPercent = $(".as-season-percentage").text().trim();
 
    const items = [];
    $(".gacha-grid .gacha-card").each((i, el) => {
      const href = $(el).attr("href") || "";
      const rarity = ($(el).attr("class") || "").match(/rarity-(\d+)/)?.[1] || null;
      const isHot = $(el).find(".hot-tag").length > 0;
      const title = $(el).find(".info-panel .title").text().trim();
      const thumbnail = $(el).find(".image-area img").attr("src") || "";
      const currentEp = $(el).find(".current-ep").text().trim();
      const totalEp = $(el).find(".total-ep").text().trim();
 
      items.push({
        title,
        thumbnail,
        slug: extractSlug(href),
        rarity: rarity ? parseInt(rarity) : null,
        isHot,
        currentEpisode: currentEp ? parseInt(currentEp) : null,
        totalEpisode: totalEp === "?" ? null : parseInt(totalEp),
      });
    });
 
    return {
      success: true,
      season: {
        name: seasonName,
        progress: seasonPercent,
      },
      total: items.length,
      data: items,
    };
  } catch (err) {
    console.error("❌ Error:", err.message);
    return {
      success: false,
      message: "Gagal scrape: " + err.message,
    };
  }
}


async function scrapeNontonAnimeDetail(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: BASE_URL + "/",
      },
    });
 
    const $ = cheerio.load(res.data);
    const article = $("article");
 
    // ================= JUDUL =================
    const title = article.find(".entry-title").text().trim();
 
    // ================= THUMBNAIL =================
    const thumbnail = article.find(".anime-card__sidebar img").attr("src") || "";
 
    // ================= SCORE & TYPE =================
    const score = article.find(".anime-card__score .value").text().trim();
    const type = article.find(".anime-card__score .type").text().trim();
 
    // ================= TRAILER =================
    const trailerUrl = article.find("a.trailerbutton").attr("href") || "";
 
    // ================= DETAILS =================
    const details = {};
    article.find(".details-list li").each((i, el) => {
      const label = $(el).find(".detail-label").text().replace(":", "").trim();
      if (!label || $(el).hasClass("detail-separator")) return;
      const value = $(el).clone().children(".detail-label").remove().end().text().trim();
      if (label && value) details[label] = value;
    });
 
    // ================= GENRES =================
    const genres = [];
    article.find(".anime-card__genres .genre-tag").each((i, el) => {
      genres.push({
        name: $(el).text().trim(),
        slug: extractSlug($(el).attr("href")),
      });
    });
 
    // ================= SYNOPSIS =================
    const synopsis = article.find(".synopsis-prose").text().trim();
 
    // ================= QUICK INFO =================
    const status = article.find(".anime-card__quick-info .info-item.status-airing, .anime-card__quick-info .info-item.status-finished")
      .text().trim();
    const episodes = article.find(".anime-card__quick-info .info-item").eq(1).text().trim();
    const duration = article.find(".anime-card__quick-info .info-item").eq(2).text().trim();
    const seasonText = article.find(".anime-card__quick-info .info-item.season a").text().trim();
    const seasonSlug = extractSlug(article.find(".anime-card__quick-info .info-item.season a").attr("href") || "");
 
    // ================= FIRST & LAST EPISODE =================
    const firstEpEl = article.find(".meta-episode-item.first a");
    const lastEpEl = article.find(".meta-episode-item.last a");
 
    const firstEpisode = {
      label: firstEpEl.find(".ep-label").text().trim(),
      title: firstEpEl.clone().children(".ep-label, .watched-status").remove().end().text().trim(),
      slug: extractSlug(firstEpEl.attr("href") || ""),
    };
 
    const lastEpisode = {
      label: lastEpEl.find(".ep-label").text().trim(),
      title: lastEpEl.clone().children(".ep-label, .watched-status").remove().end().text().trim(),
      slug: extractSlug(lastEpEl.attr("href") || ""),
    };
 
    // ================= EPISODE LIST =================
    const episodeList = [];
    article.find(".episode-list-items .episode-item").each((i, el) => {
      episodeList.push({
        title: $(el).find(".ep-title").text().trim(),
        date: $(el).find(".ep-date").text().trim(),
        slug: extractSlug($(el).attr("href") || ""),
      });
    });
 
    return {
      success: true,
      data: {
        title,
        thumbnail,
        score,
        type,
        trailerUrl,
        details,
        genres,
        synopsis,
        status,
        episodes,
        duration,
        season: {
          name: seasonText,
          slug: seasonSlug,
        },
        firstEpisode,
        lastEpisode,
        episodeList,
      },
    };
  } catch (err) {
    console.error("❌ Error:", err.message);
    return {
      success: false,
      message: "Gagal scrape: " + err.message,
    };
  }
}


 
async function scrapeNontonAnimeEpisode(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: BASE_URL + "/",
      },
    });
 
    const data = res.data;
 
    // 🔥 AMBIL COOKIE
    const cookies =
      res.headers["set-cookie"]?.map((c) => c.split(";")[0]).join("; ") || "";
 
    const $ = cheerio.load(data);
 
    // ================= HEADER INFO =================
    const entryTitle = $(".entry-title").text().trim();
    const author = $(".entry-author b").text().trim();
    const dateRaw = $("time.updated").attr("datetime") || "";
    const dateFormatted = $("time.updated").text().trim();
 
    // ================= BASIC =================
    const title = $(".name").text().trim() || entryTitle;
    const thumbnail = $(".featuredimgs img").attr("src") || "";
 
    // ================= DECODE SCRIPT =================
    let nonce = "";
    let ajaxUrl = "";
 
    const scriptSrc = $("#ajax_video-js-extra").attr("src") || "";
 
    if (scriptSrc.includes("base64,")) {
      const base64 = scriptSrc.split("base64,")[1];
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
 
      nonce = decoded.match(/"nonce":"(.*?)"/)?.[1] || "";
      ajaxUrl = decoded.match(/"url":"(.*?)"/)?.[1] || "";
    }
 
    // ================= SERVERS =================
    const servers = [];
 
    $(".serverplayer").each((i, el) => {
      servers.push({
        name: $(el).text().trim(),
        post: $(el).attr("data-post"),
        nume: $(el).attr("data-nume"),
        type: $(el).attr("data-type"),
      });
    });
 
    // ================= DEFAULT IFRAME =================
    const defaultIframe = $("#videoku iframe").attr("src") || "";
    const activeIndex = $(".serverplayer.current1").index();
 
    // ================= PLAYER AJAX =================
    async function getPlayer({ post, nume, type }) {
      try {
        const params = new URLSearchParams();
        params.append("action", "player_ajax");
        params.append("nonce", nonce);
        params.append("serverName", type.toLowerCase());
        params.append("nume", nume);
        params.append("post", post);
 
        const { data } = await axios.post(ajaxUrl, params, {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "Mozilla/5.0",
            Origin: BASE_URL,
            Referer: url,
            "X-Requested-With": "XMLHttpRequest",
            Cookie: cookies,
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
          },
        });
 
        const $$ = cheerio.load(data);
        const iframe = $$("iframe").attr("src") || "";
 
        if (!iframe) {
          console.log("❌ EMPTY:", type, nume);
          console.log(data.slice(0, 200));
        }
 
        return iframe;
      } catch (err) {
        console.log("ERR:", err.message);
        return "";
      }
    }
 
    // ================= AMBIL SEMUA PLAYER =================
    const players = [];
 
    for (let i = 0; i < servers.length; i++) {
      let iframe = "";
 
      if (i === activeIndex && defaultIframe) {
        iframe = defaultIframe;
      } else {
        iframe = await getPlayer(servers[i]);
      }
 
      players.push({
        name: servers[i].name,
        iframe,
      });
    }
 
    // ================= DOWNLOAD =================
    const downloads = [];
 
    $("#download_area .listlink a").each((i, el) => {
      downloads.push({
        name: $(el).text().trim(),
        url: $(el).attr("href"),
      });
    });
 
    const extractSlug = (href) =>
      href ? href.replace(BASE_URL, "").replace(/\//g, "") : "";
 
    // Prev: ada link-nya hanya kalau tidak ada .dashicons-dismiss di dalam .nvs pertama
    const prevEl = $("#navigation-episode .nvs").eq(0);
    const prevHref = prevEl.find(".dashicons-dismiss").length
      ? ""
      : prevEl.find("a").attr("href") || "";
    const prev = extractSlug(prevHref);
 
   const allEpisodeHref = $("#navigation-episode .nvsc a").attr("href") || "";
    const allEpisode = allEpisodeHref
      ? allEpisodeHref.replace(/\/$/, "").split("/").filter(Boolean).pop()
      : "";
 
    // Next: link di .nvs terakhir
    const nextEl = $("#navigation-episode .nvs").eq(2);
    const nextHref = nextEl.find(".dashicons-dismiss").length
      ? ""
      : nextEl.find("a").attr("href") || "";
    const next = extractSlug(nextHref);
 
    return {
      success: true,
      data: {
        // Header info
        entryTitle,
        author,
        date: {
          raw: dateRaw,
          formatted: dateFormatted,
        },
 
        // Main content
        title,
        thumbnail,
        players,
        downloads,
 
        // Navigation
        prev,
        allEpisode,
        next,
      },
    };
  } catch (err) {
    console.error("❌ Error:", err.message);
 
    return {
      success: false,
      message: "Gagal scrape: " + err.message,
    };
  }
}

app.get("/animeid/detail/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
 
    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Slug diperlukan",
      });
    }
 
    const url = buildAnimeUrl(slug);
    console.log(`🔍 Scraping detail: ${url}`);
 
    const result = await scrapeNontonAnimeDetail(url);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});
 
// ================= ROUTE: /episode/:slug =================
app.get("/animeid/episode/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
 
    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Slug diperlukan",
      });
    }
 
    const url = buildUrl(slug);
    console.log(`🔍 Scraping: ${url}`);
 
    const result = await scrapeNontonAnimeEpisode(url);
 
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// ================= ROUTE: /animeid/ongoing =================
app.get("/animeid/ongoing", async (req, res) => {
  try {
    console.log("🔍 Scraping ongoing list...");
    const result = await scrapeNontonAnimeOngoing();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

 


app.listen(PORT, () =>
  console.log(`🚀 Server jalan di http://localhost:${PORT}`),
);