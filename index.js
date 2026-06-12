const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const https = require("https");
const cloudscraper = require("cloudscraper");
const app = express();
const PORT = process.env.PORT || 3012;
const cors = require("cors");


app.use(
  cors({
    origin: "*",
  }),
);

const KOMIKU_IMAGE_WORKER = "https://cdnkm.konatanime17.workers.dev/";
const KIRYUU_BASE_URL = "https://v6.kiryuu.to";
const KIRYUU_PROXY_URL =
  process.env.KIRYUU_PROXY_URL || "https://sekte.ezcantik9.workers.dev?url=";

function toKomikuWorkerImageUrl(imageUrl) {
  if (!imageUrl) return "";
  return `${KOMIKU_IMAGE_WORKER}?url=${encodeURIComponent(imageUrl)}`;
}

function kiryuuHeaders(referer = `${KIRYUU_BASE_URL}/`) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    Referer: referer,
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  };
}

function kiryuuUrl(path = "/") {
  if (!path) return "";
  if (path.startsWith("//")) return `https:${path}`;
  return path.startsWith("http") ? path : `${KIRYUU_BASE_URL}${path}`;
}

function kiryuuProxyUrl(url) {
  if (!KIRYUU_PROXY_URL) return "";
  const separator = KIRYUU_PROXY_URL.includes("?") ? "" : "?url=";
  return `${KIRYUU_PROXY_URL}${separator}${encodeURIComponent(url)}`;
}

function isCloudflareChallenge(html = "") {
  return /Just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies/i.test(
    String(html),
  );
}

async function kiryuuFetch(url, options = {}) {
  const targetUrl = kiryuuUrl(url);
  const referer = options.referer || `${KIRYUU_BASE_URL}/`;
  const headers = {
    ...kiryuuHeaders(referer),
    ...(options.headers || {}),
  };
  const attempts = [];

  const proxiedUrl = kiryuuProxyUrl(targetUrl);
  if (proxiedUrl) {
    attempts.push({
      label: "proxy",
      run: async () => {
        const { data } = await axios.get(proxiedUrl, {
          headers,
          timeout: options.timeout || 20000,
        });
        return data;
      },
    });
  }

  attempts.push({
    label: "direct",
    run: async () => {
      const { data } = await axios.get(targetUrl, {
        headers,
        timeout: options.timeout || 20000,
        maxRedirects: 5,
      });
      return data;
    },
  });

  attempts.push({
    label: "cloudscraper",
    run: async () =>
      cloudscraper.get(targetUrl, {
        headers,
        timeout: options.timeout || 20000,
      }),
  });

  const errors = [];
  for (const attempt of attempts) {
    try {
      const html = await attempt.run();
      if (typeof html === "string" && html.trim() && !isCloudflareChallenge(html)) {
        return html;
      }
      errors.push(`${attempt.label}:cloudflare-challenge`);
    } catch (err) {
      errors.push(
        `${attempt.label}:${err.response?.status || err.statusCode || err.code || err.message}`,
      );
    }
  }

  throw new Error(`Kiryuu fetch gagal (${targetUrl}): ${errors.join(" -> ")}`);
}




function convertTimeToID(text) {
  return text
    .replace(/seconds? ago/i, "detik lalu")
    .replace(/minutes? ago/i, "menit lalu")
    .replace(/hours? ago/i, "jam lalu")
    .replace(/days? ago/i, "hari lalu")
    .replace(/weeks? ago/i, "minggu lalu")
    .replace(/months? ago/i, "bulan lalu")
    .replace(/years? ago/i, "tahun lalu");
}

async function scrapeKiryuuPustaka({ page = 1 } = {}) {
  try {
    const url = page === 1 ? "/latest/" : `/latest/?the_page=${page}`;

    console.log("Kiryuu terbaru URL:", kiryuuUrl(url));

    const data = await kiryuuFetch(url, { timeout: 20000 });

    const $ = cheerio.load(data);
    const results = [];

    $("#search-results > div").each((_, el) => {
      const title = $(el).find("h1").first().text().trim();

      const link = $(el).find("a[href*='/manga/']").first().attr("href");

      const image = $(el).find("img").first().attr("src") || "";

      // ambil slug
      const slug = link?.split("/manga/")[1]?.split("?")[0]?.replace(/\/$/, "");

      const typeGenre =
        $(el).find("span img").attr("alt") ||
        $(el)
          .find("img[alt='manga'], img[alt='manhwa'], img[alt='manhua']")
          .attr("alt") ||
        "";
      // ================= CHAPTER =================
      const chapters = [];

      $(el)
        .find("a.link-self")
        .each((i, ch) => {
          const chTitle = $(ch).find("p").text().trim();
          const chLink = $(ch).attr("href");

          const rawTime = $(ch).find("time").text().trim();
          const timeText = convertTimeToID(rawTime);
          const timeISO = $(ch).find("time").attr("datetime") || "";

          chapters.push({
            title: chTitle,

            link: chLink,
            time: timeText,
            time_iso: timeISO,
          });
        });

      // ambil terbaru
      const latest = chapters[0] || {};
      const oldest = chapters[chapters.length - 1] || {};

      if (!title || !link) return;

      results.push({
        source: "kiryuu",
        title,
        slug,
        image,
        detail_link: link,

        description: "",
        type_genre: typeGenre,

        info: latest.time || "", // 🔥 INI TIME UPDATE

        chapter_awal: oldest.title || "",
        chapter_terbaru: latest.title || "",

        chapters,
      });
    });

    // ================= PAGINATION =================
    let totalPages = 1;

    const pages = [];
    $(".flex.items-center.gap-2 a").each((_, el) => {
      const text = $(el).text().trim();
      if (/^\d+$/.test(text)) {
        pages.push(parseInt(text));
      }
    });

    if (pages.length) {
      totalPages = Math.max(...pages);
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
    console.error("Kiryuu terbaru error:", err.message);

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

async function scrapeKiryuuDetail(url) {
  try {
    const data = await kiryuuFetch(url, { timeout: 20000 });

    const $ = cheerio.load(data);

    const title = $("h1").first().text().trim();

    const thumbnail = $("img.wp-post-image").attr("src") || "";

    // ================= INFO =================
    const getInfo = (label) => {
      return $(`h4:contains("${label}")`)
        .parent()
        .find("p")
        .first()
        .text()
        .trim();
    };

    const type = getInfo("Type");
    const release = getInfo("Released");
    const lastUpdate = getInfo("Last Updates");

    const rating = $('[itemprop="ratingValue"]').attr("content") || "";

    // ================= GENRES =================
    const genres = $('[itemprop="genre"] span')
      .map((i, el) => $(el).text().trim())
      .get();

    // ================= SYNOPSIS =================
    const synopsis =
      $('[itemprop="description"]').first().text().trim() ||
      "Tidak ada sinopsis.";

    // ================= CHAPTER =================
    // ================= CHAPTER =================
    const chapters = [];

    try {
      const bodyClass = $("body").attr("class") || "";
      const matchId = bodyClass.match(/postid-(\d+)/);

      const manga_id = matchId ? matchId[1] : null;

      if (manga_id) {
        const ajaxUrl = `https://v6.kiryuu.to/wp-admin/admin-ajax.php?manga_id=${manga_id}&page=1&action=chapter_list`;

        const chapterHTML = await kiryuuFetch(ajaxUrl, {
          referer: url,
          timeout: 20000,
          headers: {
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "X-Requested-With": "XMLHttpRequest",
          },
        });

        const $$ = cheerio.load(chapterHTML);

        $$("#chapter-list > div").each((i, el) => {
          const chapter = $$(el);

          const title = chapter.find("span").first().text().trim();
          const link = chapter.find("a").attr("href") || "";
          const rawDate = chapter.find("time").text().trim();
          const date = convertTimeToID(rawDate);
          

          // ambil link download dari button onclick
          const onclick = chapter.find("button").attr("onclick") || "";
          const download = onclick.match(/location\.href='(.*?)'/)?.[1] || "";
          const slug = link?.split("/manga/")[1]?.replace(/\/$/, "");
          chapters.push({
            title,
            slug,
            link,
            date,
          });
        });
      }
    } catch (err) {
      console.log("Gagal ambil daftar chapter Kiryuu:", err.message);
    }

    chapters.reverse();
    return {
      success: true,
      data: {
        title: title || "",
        thumbnail: thumbnail || "",
        type: type || "",
        status: "-", // kiryuu ga ada status

        // ⚠️ tetap samakan field
        Pengarang: "-",
        Umur: rating || "-",
        Konsep: release || "-",

        genres: genres || [],
        synopsis: synopsis || "",

        info: lastUpdate || "", // 🔥 ini TIME UPDATE

        total_chapter: chapters.length, // ✅ isi otomatis
        chapters: chapters,
      },
    };
  } catch (err) {
    console.error("Kiryuu detail error:", err.message);

    return {
      success: false,
      message: "Gagal scrape detail.",
    };
  }
}

async function scrapeKiryuuChapter(url) {
  try {
    const data = await kiryuuFetch(url, { timeout: 20000 });

    const $ = cheerio.load(data);

    // ================= CLEAN IMAGE =================
    const cleanImageUrl = (url) => {
      return url.replace(/\s+/g, "").trim();
    };

    // ================= IMAGES =================
    const images = [];

    $("section[data-image-data='1'] img").each((i, el) => {
      let src = $(el).attr("src") || "";

      src = cleanImageUrl(src);

      if (src.startsWith("//")) {
        src = "https:" + src;
      }

      if (src) images.push(src);
    });

    // ================= TITLE =================
    const title = $("h1").first().text().trim();

    // ================= NAVIGATION =================
    const cleanLink = (link) => {
      if (!link) return null;

      link = link.trim();

      // ❌ buang link palsu
      if (
        link === "#" ||
        link.startsWith("#") ||
        link.startsWith("javascript")
      ) {
        return null;
      }

      return link.replace(/^https?:\/\/[^/]+\/manga\//, "").replace(/\/$/, "");
    };

    const prev = cleanLink($("a[aria-label='Prev']").attr("href"));
    const next = cleanLink($("a[aria-label='Next']").attr("href"));

    // ================= MANGA ID =================
    const parts = url.split("/").filter(Boolean);
    const mangaId = parts[parts.indexOf("manga") + 1];

    // ================= SLUG =================
    const chapterSlug = url
      .replace("https://v6.kiryuu.to/manga/", "")
      .replace(/\/$/, "");

    return {
      success: true,
      mangaId,
      chapterSlug,
      currentChapter: title,
      prev,
      next,
      back_to_detail: `https://v6.kiryuu.to/manga/${mangaId}/`,
      totalImages: images.length,
      images,
    };
  } catch (err) {
    console.error("Kiryuu chapter error:", err.message);
    return {
      success: false,
      message: err.message,
    };
  }
}

// =======================================================
// 📖 SCRAPER: TERBARU KOMIK - KOMIKU
// =======================================================
async function scrapeKomikuTerbaru() {
  try {
    const url = "https://komiku.org/";
    console.log(`🕷️ Mengambil data dari ${url}...`);

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(data);
    const results = [];

    $("#Terbaru .ls2-wrap article.ls2").each((_, el) => {
      const element = $(el);

      // Link & image
      const link = element.find(".ls2v a").attr("href") || "";
      const imgEl = element.find(".ls2v img");
      const image =
        imgEl.attr("data-src") ||
        imgEl.attr("data-lazy-src") ||
        imgEl.attr("src") ||
        "";

      // Title
      const title = element.find(".ls2j h3 a").text().trim();

      // Genre & waktu — dari .ls2t, contoh: "Romantis · 49 detik lalu"
      const ls2tRaw = element.find(".ls2t").text().trim();
      const ls2tParts = ls2tRaw.split("·").map((s) => s.trim());
      const genre = ls2tParts[0] || "";
      const waktu = ls2tParts[1] || "";

      // Chapter
      const chapterEl = element.find(".ls2j a.ls2l");
      const chapterTitle = chapterEl.text().trim();
      const chapterLink = chapterEl.attr("href") || "";

      // Up badge
      const up = element.find(".ls2v .up").text().trim() || "";

      // Flag / origin (jp, kr, cn)
      const flagSrc = element.find(".ls2v img.flag").attr("src") || "";
      const flagMatch = flagSrc.match(/\/([a-z]{2})\.png$/);
      const origin = flagMatch ? flagMatch[1].toUpperCase() : "";

      const fullLink = link.startsWith("http")
        ? link
        : `https://komiku.org${link}`;

      const slug = fullLink
        .replace("https://komiku.org/manga/", "")
        .replace(/\//g, "");

      const fullChapterLink = chapterLink.startsWith("http")
        ? chapterLink
        : `https://komiku.org${chapterLink}`;

      results.push({
        title,
        slug,
        link: fullLink,
        image: image.startsWith("http") ? image : `https://komiku.org${image}`,
        genre,
        waktu,
        origin,
        chapter_terbaru: chapterTitle,
        chapter_link: fullChapterLink,
        up,
      });
    });

    console.log(`✅ Berhasil ambil ${results.length} komik terbaru`);
    return results;
  } catch (error) {
    console.error("❌ Gagal scraping Komiku:", error.message);
    return [];
  }
}

async function scrapeKomikuPopuler(tipe = "semua") {
  try {
    const url = "https://komiku.org/";
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(data);
    const results = [];

    // Semua artikel ada di satu container, difilter lewat data-tipe
    const selector =
      tipe === "semua"
        ? "#Komik_Populer article.ls2"
        : `#Komik_Populer article.ls2[data-tipe="${tipe}"]`;

    $(selector).each((_, el) => {
      const element = $(el);
      const link = element.find(".ls2v a").attr("href") || "";
      const imgEl = element.find(".ls2v img");
      const image =
        imgEl.attr("data-src") ||
        imgEl.attr("data-lazy-src") ||
        imgEl.attr("src") ||
        "";

      const title = element.find(".ls2j h3 a").text().trim();

      // Format: "Fantasi · 1.3jt views"
      const ls2tRaw = element.find(".ls2t").text().trim();
      const ls2tParts = ls2tRaw.split("·").map((s) => s.trim());
      const genre = ls2tParts[0] || "";
      const views = ls2tParts[1] || "";

      const chapterEl = element.find(".ls2j a.ls2l");
      const chapterTitle = chapterEl.text().trim();
      const chapterLink = chapterEl.attr("href") || "";

      const dataTipe = element.attr("data-tipe") || "";

      const flagSrc = element.find(".ls2v img.flag").attr("src") || "";
      const flagMatch = flagSrc.match(/\/([a-z]{2})\.png$/);
      const origin = flagMatch ? flagMatch[1].toUpperCase() : "";

      results.push({
        title,
        link: link.startsWith("http") ? link : `https://komiku.org${link}`,
        image: image.startsWith("http") ? image : `https://komiku.org${image}`,
        genre,
        views,
        tipe: dataTipe,
        origin,
        chapter_terbaru: chapterTitle,
        chapter_link: chapterLink.startsWith("http")
          ? chapterLink
          : `https://komiku.org${chapterLink}`,
      });
    });

    return results;
  } catch (err) {
    console.error("Gagal scrape populer:", err.message);
    return [];
  }
}

// =======================================================
// 📖 SCRAPER: DETAIL KOMIK
// =======================================================
async function scrapeKomikuDetail(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(data);

    const title = $("h1").first().text().trim();
    const thumbnail = $(".ims img").attr("src") || "";
    const info = {};

    $(".inftable tr").each((_, el) => {
      const key = $(el).find("td").first().text().replace(":", "").trim();
      const value = $(el).find("td").last().text().trim();

      if (key && value) {
        info[key.toLowerCase()] = value;
      }
    });
    const status =
      $(".inftable td:contains('Status')").next().text().trim() || "";
    const synopsis =
      $("#Sinopsis").next("p").text().trim() ||
      $(".desc").text().trim() ||
      "Tidak ada sinopsis.";

    const genres = $("ul.genre li.genre a span")
      .map((i, el) => $(el).text().trim())
      .get();

    const type = info["tipe"] || "";

    const Pengarang = info["author"] || "";
    const Umur = info["rating"] || "";
    const Konsep = info["tema"] || "";

    const chapters = [];
    $("#daftarChapter tr").each((i, el) => {
      const chapterLink = $(el).find("a").attr("href");
      const chapterTitle = $(el).find("span").text().trim();
      const date = $(el).find(".tanggalseries").text().trim();

      if (chapterLink && chapterTitle) {
        chapters.push({
          title: chapterTitle,
          link: chapterLink.startsWith("http")
            ? chapterLink
            : "https://komiku.org" + chapterLink,
          slug: chapterLink
            .replace("https://komiku.org/", "")
            .replace(/\//g, ""),
          date,
        });
      }
    });

    chapters.reverse();

    return {
      success: true,
      data: {
        title: title || "Tidak ada judul",
        thumbnail: thumbnail || "",
        type: type || "Tidak diketahui",
        status: status || "Tidak diketahui",
        Pengarang: Pengarang || "Tidak diketahui",
        Umur: Umur || "Tidak diketahui",
        Konsep: Konsep || "Tidak diketahui",
        genres: genres || [],
        synopsis: synopsis || "Tidak ada sinopsis.",
        total_chapter: chapters.length || 0,
        chapters: chapters || [],
      },
    };
  } catch (err) {
    console.error("Gagal scrape detail komik:", err.message);
    return {
      success: false,
      message: "Gagal mengambil data detail komik.",
    };
  }
}

// =======================================================
// 📜 SCRAPER: CHAPTER KOMIK (placeholder)
// =======================================================
async function scrapeKomikuChapter(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      },
    });

    const $ = cheerio.load(data);
    const normalizeKomikuSlug = (value = "") =>
      value
        .replace(/\\\//g, "/")
        .replace(/^https?:\/\/(?:www\.)?komiku\.org\/?/i, "")
        .replace(/^\/+|\/+$/g, "");

    // Ambil images
    const images = [];
    $("#Baca_Komik img").each((i, el) => {
      let src = $(el).attr("data-src") || $(el).attr("src");
      if (src && !src.startsWith("http")) src = "https:" + src;
      images.push(src);
    });

    // Ambil slug chapter dari URL
    const chapterSlug = url
      .replace("https://komiku.org/", "")
      .replace(/\//g, "");

    // Ambil mangaId dari halaman chapter. Beberapa komik punya slug detail
    // yang beda dari prefix chapter, contoh: solo-leveling -> solo-leveling-id.
    const chapterDataMatch = data.match(/link_series\s*:\s*["']([^"']+)["']/);
    const detailLink =
      chapterDataMatch?.[1] ||
      $("a[rel='tag'][href*='/manga/']").first().attr("href") ||
      $("a[href*='/manga/']").first().attr("href") ||
      "";
    const mangaId =
      normalizeKomikuSlug(detailLink).replace(/^manga\//, "") ||
      chapterSlug.split("-chapter")[0];

    // Ambil daftar chapter
    const detail = await scrapeKomikuDetail(
      `https://komiku.org/manga/${mangaId}/`,
    );
    const chapters = detail.success ? detail.data?.chapters || [] : [];

    const pagePrev = normalizeKomikuSlug(
      $(".toolbar a[aria-label='Prev']").first().attr("href") ||
        $(".nxpr a").first().attr("href") ||
        "",
    );
    const pageNext = normalizeKomikuSlug(
      $(".toolbar a[aria-label='Next']").first().attr("href") ||
        $(".pagination a.next").first().attr("href") ||
        $(".nextch").attr("data") ||
        "",
    );

    // Cari index chapter saat ini
    const index = chapters.findIndex((c) => c.slug === chapterSlug);

    return {
      success: true,
      mangaId,
      chapterSlug,
      currentChapter: chapters[index]?.title || "",
      prev: index > 0 ? chapters[index - 1].slug : pagePrev || null,
      next:
        index >= 0 && index < chapters.length - 1
          ? chapters[index + 1].slug
          : pageNext || null,
      back_to_detail: mangaId,
      images,
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// =======================================================
// 📚 SCRAPER: DAFTAR KOMIK (https://komiku.org/daftar-komik/)
// =======================================================
async function scrapeKomikuList({ page = 1, huruf = null, tipe = null } = {}) {
  const params = new URLSearchParams();
  if (page > 1) params.set("halaman", page);
  if (huruf) params.set("huruf", huruf);
  if (tipe) params.set("tipe", tipe);

  const url =
    "https://komiku.org/daftar-komik/" +
    (params.toString() ? "?" + params.toString() : "");

  const { data } = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  const $ = cheerio.load(data);

  /* ================= META ================= */
  const totalKomik =
    $("#manga-list .page-info").first().text().match(/\d+/g)?.join("") || "0";

  const pageInfo = $("#manga-list .page-info")
    .last()
    .text()
    .match(/Halaman\s+(\d+)\s+dari\s+(\d+)/i);

  const currentPage = pageInfo ? Number(pageInfo[1]) : page;
  const totalPages = pageInfo ? Number(pageInfo[2]) : 1;

  /* ================= FILTER TIPE ================= */
  const types = [];
  $("section.filter-tabs a").each((_, el) => {
    types.push({
      label: $(el).text().trim(),
      active: $(el).hasClass("active"),
      url: $(el).attr("href"),
    });
  });

  /* ================= FILTER HURUF ================= */
  const alphabet = [];
  $("nav.alphabet-nav a").each((_, el) => {
    const letter = $(el).clone().children().remove().end().text().trim();

    alphabet.push({
      letter,
      count: $(el).find(".count").text() || null,
      active: $(el).hasClass("active"),
      url: $(el).attr("href"),
    });
  });

  /* ================= LIST KOMIK ================= */
  const list = [];

  $("#manga-list .manga-grid article.manga-card").each((_, el) => {
    const a = $(el).find("a").first();
    const img = a.find("img");

    const title = $(el).find("h4 a").text().trim();
    const link = "https://komiku.org" + a.attr("href");

    const image = img.attr("data-src") || img.attr("src") || "";

    const metaText = $(el).find("p.meta").text().replace(/\s+/g, " ").trim();

    let type = "";
    let genre = "";
    let status = "";

    if (metaText.includes("Status:")) {
      const [meta, st] = metaText.split("Status:");
      status = st.trim();

      const parts = meta.split("•").map((v) => v.trim());
      type = parts[0] || "";
      genre = parts[1] || "";
    }

    list.push({
      title,
      type,
      genre,
      status,
      image,
      link,
    });
  });

  return {
    meta: {
      totalKomik: Number(totalKomik),
      currentPage,
      totalPages,
    },
    filters: {
      types,
      alphabet,
    },
    data: list,
  };
}

// ==========================================
// 📚 SCRAPER GENRE KOMIKU
// ==========================================
async function scrapeGenreKomiku(genre, page = 1) {
  try {
    const url =
      page == 1
        ? `https://api.komiku.org/genre/${genre}/`
        : `https://api.komiku.org/genre/${genre}/page/${page}/`;

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
    });

    const $ = cheerio.load(data);
    const results = [];

    $(".bge").each((_, el) => {
      const link = $(el).find(".bgei a").attr("href") || "";
      const title = $(el).find(".kan h3").text().trim();
      const desc = $(el).find(".kan p").text().trim();

      let image =
        $(el).find(".bgei img").attr("data-src") ||
        $(el).find(".bgei img").attr("src") ||
        "";
      if (image && !image.startsWith("http")) {
        image = "https://komiku.org" + image;
      }

      const chapterStart = $(el).find(".new1").first().text().trim();
      const chapterLast = $(el).find(".new1").last().text().trim();

      const typeGenre = $(el).find(".tpe1_inf").text().trim(); // Manga Fantasi, dll

      results.push({
        title,
        description: desc,
        link: link.startsWith("http") ? link : "https://komiku.org" + link,
        image,
        typeGenre,
        chapterStart,
        chapterLast,
      });
    });

    return results;
  } catch (err) {
    console.error("❌ Error scrape genre:", err.message);
    return [];
  }
}

async function scrapeKomikuPustaka(page = 1) {
  try {
    const url =
      page === 1
        ? "https://api.komiku.org/manga/"
        : `https://api.komiku.org/manga/page/${page}/`;

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(data);
    const results = [];

    $(".bge").each((_, el) => {
      const title = $(el).find(".kan h3").text().trim();
      const link = $(el).find(".bgei a").attr("href");
      const img = $(el).find(".bgei img").attr("src");

      const description = $(el).find(".kan p").text().trim();
      const typeGenre = $(el).find(".tpe1_inf").text().trim();
      const readerInfo = $(el).find(".judul2").text().trim();

      const chapterAwal = $(el)
        .find(".new1")
        .first()
        .find("span")
        .last()
        .text()
        .trim();

      const chapterTerbaru = $(el)
        .find(".new1")
        .last()
        .find("span")
        .last()
        .text()
        .trim();

      if (!title || !link) return;

      results.push({
        title,
        slug: link.replace("https://komiku.org/manga/", "").replace(/\//g, ""),
        image: img,
        detail_link: link,
        description,
        type_genre: typeGenre,
        info: readerInfo,
        chapter_awal: chapterAwal,
        chapter_terbaru: chapterTerbaru,
      });
    });

    return results;
  } catch (err) {
    console.error("❌ Gagal scrape pustaka:", err.message);
    return [];
  }
}

async function scrapeKomikuFilters() {
  try {
    const url = "https://komiku.org/pustaka/";

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $ = cheerio.load(data);

    const filters = {
      orderby: [],
      tipe: [],
      genre: [],
      genre2: [],
      status: [],
    };

    // helper ambil option
    function getOptions(name) {
      return $(`select[name="${name}"] option`)
        .map((_, el) => ({
          value: $(el).attr("value") || "",
          label: $(el).text().trim(),
        }))
        .get();
    }

    filters.orderby = getOptions("orderby");
    filters.tipe = getOptions("tipe");
    filters.genre = getOptions("genre");
    filters.genre2 = getOptions("genre2");
    filters.status = getOptions("status");

    return filters;
  } catch (err) {
    console.error("❌ Gagal scrape filter:", err.message);
    return {};
  }
}
const pustakaFilterCache = {};

async function scrapeKomikuPustakaFilter({
  orderby = "modified",
  tipe = "",
  genre = "",
  genre2 = "",
  status = "",
  page = 1,
} = {}) {
  try {
    const params = new URLSearchParams();

    params.set("orderby", orderby || "");
    params.set("tipe", tipe || "");
    params.set("genre", genre || "");
    params.set("genre2", genre2 || "");
    params.set("status", status || "");

    const base =
      page === 1
        ? "https://api.komiku.org/manga/"
        : `https://api.komiku.org/manga/page/${page}/`;

    const url = `${base}?${params.toString()}`;

    console.log("🔥 URL:", url);

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    const $ = cheerio.load(data);
    const results = [];

    // ================= LIST =================
    $(".bge").each((_, el) => {
      const title = $(el).find(".kan h3").text().trim();
      const link = $(el).find(".bgei a").attr("href");

      const image =
        $(el).find(".bgei img").attr("data-src") ||
        $(el).find(".bgei img").attr("src") ||
        "";

      const description = $(el).find(".kan p").text().trim();
      const typeGenre = $(el).find(".tpe1_inf").text().trim();
      const info = $(el).find(".judul2").text().trim().split("|")[1]?.trim();

      const chapterAwal = $(el)
        .find(".new1")
        .first()
        .find("span")
        .last()
        .text()
        .trim();

      const chapterTerbaru = $(el)
        .find(".new1")
        .last()
        .find("span")
        .last()
        .text()
        .trim();

      if (!title || !link) return;

      results.push({
        source: "komiku",
        title,
        slug: link.replace("https://komiku.org/manga/", "").replace(/\//g, ""),
        image,
        detail_link: link,
        description,
        type_genre: typeGenre,
        info, // ✅ penting (biar frontend ga error)
        chapter_awal: chapterAwal,
        chapter_terbaru: chapterTerbaru,
      });
    });

    // ================= PAGINATION =================
    let totalPages = 1;

    const lastPage = $(".pagination a")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => /^\d+$/.test(t))
      .map(Number);

    if (lastPage.length) {
      totalPages = Math.max(...lastPage);
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
    console.error("❌ Gagal filter pustaka:", err.message);
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

async function scrapeMangakuPustaka({ page = 1 } = {}) {
  try {
    const url =
      page === 1
        ? "https://mangaku.onl/komik/?order=update"
        : `https://mangaku.onl/komik/?page=${page}&order=update`;

    console.log("🔥 Mangaku URL:", url);

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://mangaku.onl/",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const results = [];

    $(".listupd .bs").each((_, el) => {
      const link = $(el).find("a").attr("href");
      const title = $(el).find(".tt").text().trim();

      const image =
        $(el).find("img").attr("src") ||
        $(el).find("img").attr("data-src") ||
        "";

      const chapterTerbaru = $(el).find(".epxs").text().trim();

      const rating = $(el).find(".numscore").text().trim();

      const typeClass = $(el).find(".type").attr("class") || "";

// hasil: "type Manga 18+"
const typeGenre = typeClass
  .replace("type", "")
  .trim();


      if (!title || !link) return;

      results.push({
        source: "mangaku",
        title,
        slug: link.split("/").filter(Boolean).pop(),
        image,
        detail_link: link,
        description: "",
        type_genre: typeGenre || "", // Mangaku gak ada label jelas
        info: "",
        chapter_awal: "",
        chapter_terbaru: chapterTerbaru,
      });
    });

    // ================= PAGINATION =================
    let totalPages = page;

    const pagination = $(".hpage a")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => /^\d+$/.test(t))
      .map(Number);

    if (pagination.length) {
      totalPages = Math.max(...pagination);
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
    console.error("❌ Mangaku error:", err.message);
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

const DOUJINDESU_BASE_URL = "https://doujindesu.tv";
const DOUJINDESU_PROXY_URL = "https://sekte.ezcantik9.workers.dev?url=";
const DOUJINDESU_CF_IP = "104.26.8.62";
const DOUJINDESU_IMAGE_PROBE_BATCH_SIZE = 16;
const DOUJINDESU_IMAGE_CACHE_TTL = 1000 * 60 * 30;
const doujindesuImageCache = new Map();
const doujindesuCloudflareAgent = new https.Agent({
  lookup: (hostname, options, callback) => {
    if (hostname === "doujindesu.tv") {
      if (options?.all) {
        return callback(null, [{ address: DOUJINDESU_CF_IP, family: 4 }]);
      }

      return callback(null, DOUJINDESU_CF_IP, 4);
    }

    return require("dns").lookup(hostname, options, callback);
  },
});

function doujindesuUrl(path = "/") {
  if (!path) return "";
  return path.startsWith("http") ? path : `${DOUJINDESU_BASE_URL}${path}`;
}

function doujindesuSlug(url, marker = "/manga/") {
  const fullUrl = doujindesuUrl(url);
  return fullUrl.split(marker)[1]?.split("?")[0]?.replace(/\/$/, "") || "";
}

function doujindesuPathSlug(url) {
  try {
    return new URL(doujindesuUrl(url)).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function doujindesuNormalizeImageUrl(url = "") {
  const value = String(url).trim();
  if (!value || value.startsWith("data:")) return "";

  try {
    const imageUrl = new URL(value, DOUJINDESU_BASE_URL);
    imageUrl.pathname = imageUrl.pathname
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join("/");

    return imageUrl.href;
  } catch {
    return doujindesuUrl(value);
  }
}

function doujindesuChapterRange(number, size = 10) {
  const chapterNumber = parseInt(number, 10);
  if (!chapterNumber) return "";

  const start = Math.floor((chapterNumber - 1) / size) * size + 1;
  return `${start}-${start + size - 1}`;
}

async function doujindesuFetch(url) {
  const targetUrl = doujindesuUrl(url);
  const proxyUrl = `${DOUJINDESU_PROXY_URL}${encodeURIComponent(targetUrl)}`;

  const { data } = await axios.get(proxyUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      Referer: DOUJINDESU_BASE_URL,
    },
    timeout: 20000,
  });

  return data;
}

async function doujindesuPost(url, payload = {}, referer = DOUJINDESU_BASE_URL) {
  const targetUrl = doujindesuUrl(url);
  const params = new URLSearchParams();

  Object.entries(payload).forEach(([key, value]) => {
    params.append(key, value);
  });

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Origin: DOUJINDESU_BASE_URL,
    Referer: referer || DOUJINDESU_BASE_URL,
  };

  try {
    const pageRes = await axios.get(referer, {
      headers: {
        "User-Agent": headers["User-Agent"],
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": headers["Accept-Language"],
        Referer: DOUJINDESU_BASE_URL,
      },
      httpsAgent: doujindesuCloudflareAgent,
      timeout: 20000,
    });
    const cookies = pageRes.headers["set-cookie"] || [];
    const { data } = await axios.post(targetUrl, params, {
      headers: {
        ...headers,
        Cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
      },
      httpsAgent: doujindesuCloudflareAgent,
      timeout: 20000,
    });

    return data;
  } catch (err) {
    const proxyUrl =
      `${DOUJINDESU_PROXY_URL}${encodeURIComponent(targetUrl)}` +
      `&referer=${encodeURIComponent(referer || DOUJINDESU_BASE_URL)}`;
    const { data } = await axios.post(proxyUrl, params, {
      headers,
      timeout: 20000,
    });

    return data;
  }
}

async function doujindesuImageExists(image) {
  try {
    const response = await axios.get(image, {
      headers: {
        Range: "bytes=0-0",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Referer: DOUJINDESU_BASE_URL,
      },
      responseType: "arraybuffer",
      timeout: 8000,
      validateStatus: () => true,
    });

    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

function doujindesuTitleCandidates(...titles) {
  const candidates = [];
  const pushCandidate = (value) => {
    const title = value
      .replace(/\s+/g, " ")
      .replace(/[.\u3002]+$/g, "")
      .trim();

    if (title && !candidates.includes(title)) candidates.push(title);
  };

  titles.filter(Boolean).forEach((title) => {
    pushCandidate(title);
    pushCandidate(title.split(" - ")[0]);
    pushCandidate(title.split("...")[0]);
    pushCandidate(title.split("\u2026")[0]);
  });

  return candidates.slice(0, 8);
}

async function collectDoujindesuImages(basePath, filePrefix) {
  const images = [];
  const maxProbe = 300;

  const buildImage = (page) =>
    `https://desu.photos/storage/uploads/${basePath}/` +
    encodeURIComponent(`${filePrefix} (${page}).webp`);

  for (let start = 1; start <= maxProbe; start += DOUJINDESU_IMAGE_PROBE_BATCH_SIZE) {
    const pages = Array.from(
      { length: Math.min(DOUJINDESU_IMAGE_PROBE_BATCH_SIZE, maxProbe - start + 1) },
      (_, index) => start + index,
    );
    const results = await Promise.all(
      pages.map(async (page) => {
        const image = buildImage(page);
        return {
          page,
          image,
          exists: await doujindesuImageExists(image),
        };
      }),
    );
    const hits = results
      .filter((result) => result.exists)
      .sort((a, b) => a.page - b.page);

    if (!hits.length) break;

    images.push(...hits.map((result) => result.image));

    if (hits[hits.length - 1].page < pages[pages.length - 1]) break;
  }

  return images;
}

async function probeDoujindesuDoujinshiImages(seriesTitle, chapterTitle) {
  const titleCandidates = doujindesuTitleCandidates(seriesTitle, chapterTitle);

  for (const title of titleCandidates) {
    const encodedTitle = encodeURIComponent(title);
    const numbers = Array.from({ length: 30 }, (_, index) => index + 1);
    const firstImageResults = await Promise.all(
      numbers.map(async (number) => {
        const firstImage =
          `https://desu.photos/storage/uploads/DOUJINSHI/${encodedTitle}/` +
          encodeURIComponent(`${number} (1).webp`);

        return {
          number,
          exists: await doujindesuImageExists(firstImage),
        };
      }),
    );
    const match = firstImageResults.find((result) => result.exists);

    if (match) {
      return collectDoujindesuImages(`DOUJINSHI/${encodedTitle}`, match.number);
    }
  }

  return [];
}

async function probeDoujindesuChapterImages(seriesTitle, chapterTitle) {
  const cacheKey = `${seriesTitle}::${chapterTitle}`;
  const cached = doujindesuImageCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < DOUJINDESU_IMAGE_CACHE_TTL) {
    return [...cached.images];
  }

  const chapterNumber = chapterTitle.match(/chapter\s*0*(\d+)/i)?.[1];
  let images;

  if (seriesTitle && chapterNumber) {
    const encodedTitle = encodeURIComponent(seriesTitle);
    const range = doujindesuChapterRange(chapterNumber);
    const basePaths = [
      `MANHWA/${encodedTitle}/${chapterNumber}`,
      range ? `MANHWA/${encodedTitle}/${range}/${chapterNumber}` : "",
    ].filter(Boolean);

    for (const basePath of basePaths) {
      images = await collectDoujindesuImages(basePath, chapterNumber);
      if (images.length) break;
    }
  } else {
    images = await probeDoujindesuDoujinshiImages(seriesTitle, chapterTitle);
  }

  doujindesuImageCache.set(cacheKey, {
    createdAt: Date.now(),
    images,
  });

  if (doujindesuImageCache.size > 200) {
    const oldestKey = doujindesuImageCache.keys().next().value;
    doujindesuImageCache.delete(oldestKey);
  }

  return [...images];
}

const SEKTE_BASE_URL = "https://sektedoujin.cc";
const SEKTE_PROXY_URL = "https://sekte.ezcantik9.workers.dev?url=";

function sekteUrl(path = "/") {
  if (!path) return "";
  if (path.startsWith("//")) return `https:${path}`;
  return path.startsWith("http") ? path : `${SEKTE_BASE_URL}${path}`;
}

function sektePathSlug(url) {
  try {
    return new URL(sekteUrl(url)).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function sekteDetailSlug(url) {
  try {
    return new URL(sekteUrl(url)).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function sekteMangaSlug(url) {
  try {
    return new URL(sekteUrl(url)).pathname.split("/manga/")[1]?.split("/")[0] || "";
  } catch {
    return "";
  }
}

function sekteSlugify(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sekteChapterSlugFromTitle(mangaSlug, chapterTitle) {
  const chapterSlug = sekteSlugify(chapterTitle);
  if (!mangaSlug || !chapterSlug) return "";

  return chapterSlug.startsWith(mangaSlug)
    ? chapterSlug
    : `${mangaSlug}-${chapterSlug}`;
}

function sekteNormalizeImageUrl(url = "") {
  const value = String(url).trim();
  if (!value || value.startsWith("data:")) return "";

  try {
    const imageUrl = new URL(value, SEKTE_BASE_URL);
    if (imageUrl.pathname.includes("/assets/img/readerarea.svg")) return "";

    imageUrl.pathname = imageUrl.pathname
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join("/");

    return imageUrl.href;
  } catch {
    return sekteUrl(value);
  }
}

function parseSekteReaderData(html = "") {
  const match = String(html).match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
  if (!match) return {};

  try {
    return JSON.parse(match[1]);
  } catch {
    return {};
  }
}

async function sekteFetch(url) {
  const targetUrl = sekteUrl(url);
  const proxyUrl = `${SEKTE_PROXY_URL}${encodeURIComponent(targetUrl)}`;
  const { data } = await axios.get(proxyUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      Referer: SEKTE_BASE_URL,
    },
    timeout: 20000,
  });

  return data;
}

function parseSekteListItems($) {
  const results = [];

  $(".listupd .bs").each((_, el) => {
    const item = $(el);
    const anchor = item.find(".bsx > a[href*='/manga/']").first();
    const detailPath = anchor.attr("href") || "";
    const detailLink = sekteUrl(detailPath);
    const title =
      item.find(".tt").first().text().replace(/\s+/g, " ").trim() ||
      anchor.attr("title")?.trim() ||
      item.find("img").first().attr("title")?.trim() ||
      "";
    const image = sekteNormalizeImageUrl(
      item.find(".limit img").first().attr("data-src") ||
        item.find(".limit img").first().attr("src") ||
        "",
    );
    const mangaSlug = sekteMangaSlug(detailPath);
    const typeGenre =
      (item.find(".limit .type").first().attr("class") || "")
        .split(/\s+/)
        .find((className) => className && className !== "type") ||
      item.find(".limit .type").first().text().trim();
    const chapterTitle = item.find(".epxs").first().text().replace(/\s+/g, " ").trim();
    const chapterSlug = sekteChapterSlugFromTitle(mangaSlug, chapterTitle);
    const status = item.find(".limit .status").first().text().replace(/\s+/g, " ").trim();
    const score = item.find(".numscore").first().text().replace(/\s+/g, " ").trim();
    const ratingStyle = item.find(".rtb span").first().attr("style") || "";
    const ratingPercent = ratingStyle.match(/width\s*:\s*([^;]+)/i)?.[1] || "";

    if (!title || !detailPath) return;

    results.push({
      source: "sektedoujin",
      title,
      slug: mangaSlug,
      image,
      detail_link: detailLink,
      description: "",
      type_genre: typeGenre || "",
      genres: [],
      info: status || typeGenre || chapterTitle || "",
      update: chapterTitle,
      chapter_terbaru: chapterTitle,
      chapter_slug: chapterSlug,
      chapter_link: chapterSlug ? sekteUrl(`/${chapterSlug}/`) : "",
      status,
      score,
      rating: score,
      rating_percent: ratingPercent,
      is_colored: item.find(".colored").length > 0,
      is_hot: item.find(".hotx").length > 0,
    });
  });

  return results;
}

async function scrapeSekteTerbaru({ page = 1 } = {}) {
  try {
    const latestPath = page === 1 ? "/manga/?order=update" : `/manga/?page=${page}&order=update`;
    const html = await sekteFetch(latestPath);
    const $ = cheerio.load(html);
    const results = parseSekteListItems($);

    const pages = [];
    $(".pagination a, .hpage a, .pagenav a").each((_, el) => {
      const pageNumber = parseInt($(el).text().trim(), 10);
      if (!Number.isNaN(pageNumber)) pages.push(pageNumber);
    });
    const hasNextPage = $(".hpage a.r, .pagination a.next").length > 0;

    return {
      success: true,
      source: "sektedoujin.cc",
      page,
      totalPages: pages.length ? Math.max(...pages) : hasNextPage ? page + 1 : page,
      total: results.length,
      data: results,
    };
  } catch (err) {
    console.error("Sekte terbaru error:", err.message);
    return {
      success: false,
      source: "sektedoujin.cc",
      page,
      total: 0,
      data: [],
      message: "Gagal scrape halaman",
      error: err.message,
    };
  }
}

async function scrapeSekteSearch(query, page = 1) {
  try {
    const searchPath =
      page === 1
        ? `/?s=${encodeURIComponent(query)}`
        : `/?s=${encodeURIComponent(query)}&page=${page}`;
    const html = await sekteFetch(searchPath);
    const $ = cheerio.load(html);
    const results = parseSekteListItems($).map((item) => ({
      source: item.source,
      title: item.title,
      image: item.image,
      detail_link: item.detail_link,
      update: item.update,
      slug: item.slug,
      type_genre: item.type_genre,
      status: item.status,
      score: item.score,
      genres: item.genres,
    }));

    const pages = [];
    $(".pagination a, .hpage a, .pagenav a").each((_, el) => {
      const pageNumber = parseInt($(el).text().trim(), 10);
      if (!Number.isNaN(pageNumber)) pages.push(pageNumber);
    });
    const hasNextPage = $(".hpage a.r, .pagination a.next").length > 0;

    return {
      success: true,
      total: results.length,
      query,
      page,
      totalPages: pages.length ? Math.max(...pages) : hasNextPage ? page + 1 : page,
      data: results,
    };
  } catch (err) {
    console.error("Sekte search error:", err.message);
    return {
      success: false,
      total: 0,
      query,
      page,
      data: [],
      message: "Gagal mengambil data pencarian",
      error: err.message,
    };
  }
}

async function scrapeSekteDetail(slug) {
  try {
    const detailPath = slug.startsWith("http") ? slug : `/manga/${slug.replace(/^\/+/, "")}/`;
    const detailLink = sekteUrl(detailPath);
    const html = await sekteFetch(detailPath);
    const $ = cheerio.load(html);
    const article = $("article.hentry").first();
    const title =
      article.find("#titlemove h1.entry-title").first().text().replace(/\s+/g, " ").trim() ||
      article.find("h1.entry-title").first().text().replace(/\s+/g, " ").trim();
    const image = sekteNormalizeImageUrl(
      article.find(".thumb img").first().attr("data-src") ||
        article.find(".thumb img").first().attr("src") ||
        "",
    );
    const alternativeTitle = article
      .find("#titlemove .alternative")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const info = {};

    article.find(".tsinfo .imptdt").each((_, el) => {
      const row = $(el).clone();
      row.find("i, a, span, time").remove();
      const key = row.text().replace(/\s+/g, " ").trim();
      const values = [
        $(el).children("a").map((__, node) => $(node).text().replace(/\s+/g, " ").trim()).get(),
        $(el).children("i").map((__, node) => $(node).text().replace(/\s+/g, " ").trim()).get(),
        $(el).find(".author i").first().text().replace(/\s+/g, " ").trim(),
        $(el).find(".ts-views-count").first().text().replace(/\s+/g, " ").trim(),
      ]
        .flat()
        .filter(Boolean);
      const value = [...new Set(values)].join(", ") ||
        $(el).text().replace(/\s+/g, " ").replace(key, "").trim();

      if (key) info[key.toLowerCase().replace(/\s+/g, "_")] = value;
    });

    const genres = article
      .find(".mgen a")
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
    const synopsis = article
      .find(".info-desc .entry-content")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const score = article.find(".rating .num").first().text().replace(/\s+/g, " ").trim();
    const ratingCount = article.find(".rating-prc meta[itemprop='ratingCount']").attr("content") || "";
    const ratingStyle = article.find(".rating .rtb span").first().attr("style") || "";
    const ratingPercent = ratingStyle.match(/width\s*:\s*([^;]+)/i)?.[1] || "";

    const chapters = [];
    article.find("#chapterlist li").each((_, el) => {
      const chapter = $(el);
      const chapterPath = chapter.find(".eph-num a").first().attr("href") || "";
      const chapterTitle = chapter.find(".chapternum").first().text().replace(/\s+/g, " ").trim();
      const date = chapter.find(".chapterdate").first().text().replace(/\s+/g, " ").trim();
      const chapterNumber = String(chapter.attr("data-num") || "")
        .replace(/\s+/g, " ")
        .trim();
      const downloadPath = chapter.find(".dt a.dload").first().attr("href") || "";

      if (!chapterTitle && !chapterPath) return;

      chapters.push({
        title: chapterTitle,
        chapter: chapterNumber,
        slug: sektePathSlug(chapterPath),
        link: sekteUrl(chapterPath),
        date,
        is_new: false,
        download_link: downloadPath,
      });
    });

    const latestChapter = chapters[0] || null;
    const firstChapter = chapters[chapters.length - 1] || null;
    chapters.reverse();

    return {
      success: true,
      data: {
        source: "sektedoujin",
        title,
        slug: sekteMangaSlug(detailLink) || sekteDetailSlug(detailLink),
        thumbnail: image,
        image,
        detail_link: detailLink,
        alternative_title: alternativeTitle,
        type: info.type || "",
        type_genre: info.type || "",
        status: info.status || "",
        Pengarang: info.author || "",
        Umur: "",
        Konsep: "",
        series: title,
        author: info.author || "",
        artist: info.artist || "",
        posted_by: info.posted_by || "",
        posted_on: info.posted_on || "",
        updated_on: info.updated_on || "",
        views: info.views || "",
        rating: score,
        rating_count: ratingCount,
        rating_percent: ratingPercent,
        is_colored: article.find(".thumb .colored").length > 0,
        genres,
        synopsis,
        warning: article.find(".alr").first().text().replace(/\s+/g, " ").trim(),
        info: latestChapter?.date || info.updated_on || info.posted_on || "",
        chapter_awal: firstChapter?.title || "",
        chapter_terbaru: latestChapter?.title || "",
        total_chapter: chapters.length,
        total_chapters: chapters.length,
        chapters,
      },
    };
  } catch (err) {
    console.error("Sekte detail error:", err.message);
    return {
      success: false,
      source: "sektedoujin",
      message: "Gagal scrape detail",
      error: err.message,
    };
  }
}

async function scrapeSekteChapter(slug) {
  try {
    const chapterPath = slug.startsWith("http") ? slug : `/${slug.replace(/^\/+/, "")}/`;
    const chapterLink = sekteUrl(chapterPath);
    const html = await sekteFetch(chapterPath);
    const $ = cheerio.load(html);
    const article = $("article.hentry").first();
    const readerData = parseSekteReaderData(html);

    const title = article
      .find("h1.entry-title")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const seriesEl = article.find(".allc a[href*='/manga/']").first();
    const seriesTitle = seriesEl.text().replace(/\s+/g, " ").trim();
    const seriesLink = sekteUrl(seriesEl.attr("href") || "");
    const mangaId = sekteDetailSlug(seriesLink);
    const chapterSlug = sektePathSlug(chapterPath);
    const date =
      article.find("time.entry-date").first().text().replace(/\s+/g, " ").trim() ||
      article.find("time.entry-date").first().attr("datetime") ||
      "";
    const description = article
      .find(".chdesc")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const navTop = article.find(".chnav.ctop").first();
    const prevAnchor = navTop.find(".ch-prev-btn").first();
    const nextAnchor = navTop.find(".ch-next-btn").first();
    const domPrevPath = prevAnchor.hasClass("disabled") ? "" : prevAnchor.attr("href") || "";
    const domNextPath = nextAnchor.hasClass("disabled") ? "" : nextAnchor.attr("href") || "";
    const prevPath = readerData.prevUrl || (domPrevPath.startsWith("#") ? "" : domPrevPath);
    const nextPath = readerData.nextUrl || (domNextPath.startsWith("#") ? "" : domNextPath);
    const downloadLink = sekteUrl(navTop.find(".dlx a").first().attr("href") || "");

    const imageSet = new Set();
    article.find("#readerarea img").each((_, el) => {
      const img = $(el);
      [
        img.attr("data-src"),
        img.attr("data-lazy-src"),
        img.attr("data-original"),
        img.attr("src"),
      ]
        .map(sekteNormalizeImageUrl)
        .filter(Boolean)
        .forEach((image) => imageSet.add(image));
    });

    (readerData.sources || []).forEach((source) => {
      (source.images || [])
        .map(sekteNormalizeImageUrl)
        .filter(Boolean)
        .forEach((image) => imageSet.add(image));
    });

    const images = [...imageSet];
    const totalPages =
      (readerData.sources || []).reduce(
        (max, source) => Math.max(max, Array.isArray(source.images) ? source.images.length : 0),
        0,
      ) ||
      parseInt(
        article
          .find(".ts-select-paged option")
          .last()
          .text()
          .split("/")
          .pop(),
        10,
      ) ||
      images.length;

    return {
      success: true,
      source: "sektedoujin",
      mangaId,
      chapterSlug,
      currentChapter: title,
      title,
      slug: chapterSlug,
      chapter_id: (article.attr("id") || "").replace(/^post-/, ""),
      total_pages: totalPages,
      image_count: images.length,
      totalImages: images.length,
      chapter_link: chapterLink,
      series: {
        title: seriesTitle,
        slug: mangaId,
        link: seriesLink,
      },
      date,
      description,
      prev: prevPath ? sektePathSlug(prevPath) : "",
      prev_link: prevPath ? sekteUrl(prevPath) : "",
      next: nextPath ? sektePathSlug(nextPath) : "",
      next_link: nextPath ? sekteUrl(nextPath) : "",
      back_to_detail: mangaId,
      detail_link: seriesLink,
      download_link: downloadLink,
      images,
    };
  } catch (err) {
    console.error("Sekte chapter error:", err.message);
    return {
      success: false,
      source: "sektedoujin",
      message: "Gagal scrape chapter",
      error: err.message,
    };
  }
}

async function scrapeDoujindesuTerbaru({ page = 1 } = {}) {
  try {
    const url = page === 1 ? "/manhwa/" : `/manhwa/page/${page}/`;
    const html = await doujindesuFetch(url);
    const $ = cheerio.load(html);
    const results = [];

    $("section.feed#archives .entries article.entry").each((_, el) => {
      const item = $(el);
      const detailPath = item.find("a[href*='/manga/']").first().attr("href") || "";
      const detailLink = doujindesuUrl(detailPath);
      const title =
        item.find(".metadata h3.title span").first().text().trim() ||
        item.find("figure img").first().attr("title")?.trim() ||
        item.find("a[href*='/manga/']").first().attr("title")?.trim() ||
        "";

      const image = doujindesuUrl(item.find("figure.thumbnail img").first().attr("src") || "");
      const typeGenre = item.find("figure.thumbnail .type").first().text().trim() || "Manhwa";
      const chapterEl = item.find(".metadata .artists a").first();
      const chapterPath = chapterEl.attr("href") || "";
      const chapterTitle =
        chapterEl.find("span").first().text().trim() || chapterEl.text().trim();
      const info = item.find(".metadata .artists .dtch").first().text().trim();
      const genres = (item.attr("data-tags") || "")
        .split("|")
        .map((genre) => genre.trim())
        .filter(Boolean);

      if (!title || !detailPath) return;

      results.push({
        source: "doujindesu",
        title,
        slug: doujindesuSlug(detailPath),
        image,
        detail_link: detailLink,
        description: "",
        type_genre: typeGenre,
        genres,
        info,
        update: chapterTitle,
        chapter_terbaru: chapterTitle,
        chapter_slug: doujindesuPathSlug(chapterPath),
        chapter_link: doujindesuUrl(chapterPath),
      });
    });

    const pages = [];
    $("section.feed#archives nav.pagination a").each((_, el) => {
      const pageNumber = parseInt($(el).text().trim(), 10);
      if (!Number.isNaN(pageNumber)) pages.push(pageNumber);
    });

    return {
      success: true,
      source: "doujindesu.tv",
      page,
      totalPages: pages.length ? Math.max(...pages) : page,
      total: results.length,
      data: results,
    };
  } catch (err) {
    console.error("Doujindesu terbaru error:", err.message);
    return {
      success: false,
      source: "doujindesu.tv",
      page,
      total: 0,
      data: [],
      message: "Gagal scrape halaman",
      error: err.message,
    };
  }
}

async function scrapeDoujindesuSearch(query, page = 1) {
  try {
    const searchPath =
      page === 1
        ? `/?s=${encodeURIComponent(query)}`
        : `/page/${page}/?s=${encodeURIComponent(query)}`;
    const html = await doujindesuFetch(searchPath);
    const $ = cheerio.load(html);
    const results = [];

    $("section.feed#archives .entries article.entry").each((_, el) => {
      const item = $(el);
      const detailPath = item.find("a[href*='/manga/']").first().attr("href") || "";
      const detailLink = doujindesuUrl(detailPath);
      const title =
        item.find(".metadata h3.title span").first().text().trim() ||
        item.find("figure img").first().attr("title")?.trim() ||
        item.find("a[href*='/manga/']").first().attr("title")?.trim() ||
        "";
      const image = doujindesuUrl(item.find("figure.thumbnail img").first().attr("src") || "");
      const typeGenre = item.find("figure.thumbnail .type").first().text().trim();
      const score = item.find(".metadata .score").first().text().replace(/\s+/g, " ").trim();
      const status = item.find(".metadata .status").first().text().trim();
      const genres = (item.attr("data-tags") || "")
        .split("|")
        .map((genre) => genre.trim())
        .filter(Boolean);

      if (!title || !detailPath) return;

      results.push({
        source: "doujindesu",
        title,
        image,
        detail_link: detailLink,
        update: status,
        slug: doujindesuSlug(detailPath),
        type_genre: typeGenre,
        status,
        score,
        genres,
      });
    });

    const pages = [];
    $("section.feed#archives nav.pagination a").each((_, el) => {
      const pageNumber = parseInt($(el).text().trim(), 10);
      if (!Number.isNaN(pageNumber)) pages.push(pageNumber);
    });

    return {
      success: true,
      total: results.length,
      query,
      page,
      totalPages: pages.length ? Math.max(...pages) : page,
      data: results,
    };
  } catch (err) {
    console.error("Doujindesu search error:", err.message);
    return {
      success: false,
      total: 0,
      query,
      page,
      data: [],
      message: "Gagal mengambil data pencarian",
      error: err.message,
    };
  }
}

async function scrapeDoujindesuDetail(slug) {
  try {
    const detailPath = slug.startsWith("http") ? slug : `/manga/${slug}/`;
    const detailLink = doujindesuUrl(detailPath);
    const html = await doujindesuFetch(detailPath);
    const $ = cheerio.load(html);
    const metadata = $("main#archive .wrapper > section.metadata").first();
    const titleNode = metadata.find("h1.title").first().clone();
    const alternativeTitle = titleNode.find(".alter").text().trim();

    titleNode.find(".alter").remove();

    const title = titleNode.text().replace(/\s+/g, " ").trim();
    const image = doujindesuUrl(
      $("main#archive .wrapper aside figure.thumbnail img").first().attr("src") || "",
    );
    const info = {};

    metadata.find("table tr").each((_, el) => {
      const key = $(el).find("td").first().text().replace(/\s+/g, " ").trim();
      const valueCell = $(el).find("td").eq(1);
      const values = valueCell
        .find("a")
        .map((__, a) => $(a).text().replace(/\s+/g, " ").trim())
        .get()
        .filter(Boolean);
      const value = values.length
        ? values.join(", ")
        : valueCell.text().replace(/\s+/g, " ").trim();

      if (key) info[key.toLowerCase().replace(/\s+/g, "_")] = value;
    });

    const genres = metadata
      .find(".tags a")
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);

    const synopsis = metadata
      .find(".pb-2 p")
      .first()
      .text()
      .replace(/^Sinopsis:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    const chapters = [];
    $("#chapter_list li").each((_, el) => {
      const chapter = $(el);
      const chapterPath = chapter.find(".epsleft .lchx a").first().attr("href") ||
        chapter.find(".eps a").first().attr("href") ||
        "";
      const chapterTitle = chapter.find(".epsleft .lchx a").first().text().trim();
      const chapterNumber = chapter.find(".eps chapter").first().text().trim();
      const date = chapter.find(".epsleft .date").first().text().trim();
      const downloadPath = chapter.find(".chright .linkdl a").first().attr("href") || "";

      if (!chapterTitle && !chapterPath) return;

      chapters.push({
        title: chapterTitle,
        chapter: chapterNumber,
        slug: doujindesuPathSlug(chapterPath),
        link: doujindesuUrl(chapterPath),
        date,
        is_new: chapter.find(".newchlabel").length > 0,
        download_link: downloadPath,
      });
    });

    const latestChapter = chapters[0] || null;
    const firstChapter = chapters[chapters.length - 1] || null;
    chapters.reverse();

    return {
      success: true,
      data: {
        source: "doujindesu",
        title,
        slug: doujindesuSlug(detailLink),
        thumbnail: image,
        image,
        detail_link: detailLink,
        alternative_title: alternativeTitle,
        type: info.type || "",
        type_genre: info.type || "",
        status: info.status || "",
        Pengarang: info.author || "",
        Umur: info.rating || "",
        Konsep: info.serialization || info.series || "",
        series: info.series || "",
        author: info.author || "",
        serialization: info.serialization || "",
        rating: info.rating || "",
        created_date: info.created_date || "",
        genres,
        synopsis,
        info: latestChapter?.date || info.created_date || "",
        chapter_awal: firstChapter?.title || "",
        chapter_terbaru: latestChapter?.title || "",
        total_chapter: chapters.length,
        total_chapters: chapters.length,
        chapters,
      },
    };
  } catch (err) {
    console.error("Doujindesu detail error:", err.message);
    return {
      success: false,
      source: "doujindesu",
      message: "Gagal scrape detail",
      error: err.message,
    };
  }
}

async function scrapeDoujindesuChapter(slug) {
  try {
    const chapterPath = slug.startsWith("http") ? slug : `/${slug.replace(/^\/+/, "")}/`;
    const chapterLink = doujindesuUrl(chapterPath);
    const html = await doujindesuFetch(chapterPath);
    const $ = cheerio.load(html);
    const reader = $("main#reader").first();
    const header = reader.find("section.metadata header").first();
    const title = header.find("h1").first().text().replace(/\s+/g, " ").trim();
    const seriesEl = header.find(".epx a[href*='/manga/']").first();
    const seriesTitle = seriesEl.text().replace(/\s+/g, " ").trim();
    const seriesLink = doujindesuUrl(seriesEl.attr("href") || "");
    const date = header
      .find(".epx")
      .first()
      .clone()
      .children()
      .remove()
      .end()
      .text()
      .replace(/\s*,?\s*in\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    const description = reader
      .find(".desch")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const navTop = reader.find("> header .naveps").first();
    const prevPath = navTop.find("a[title='Previous Chapter']").first().attr("href") || "";
    const allChapterPath = navTop.find("a[title='All Chapter']").first().attr("href") || "";
    const nextAnchor = navTop.find(".nvs.rght a").first();
    const nextPath = nextAnchor.hasClass("nonex") ? "" : nextAnchor.attr("href") || "";
    const downloadLink = navTop.find(".linkdl a").first().attr("href") || "";
    const mangaId = doujindesuSlug(seriesLink);
    const chapterSlug = reader.attr("data-slug") || doujindesuPathSlug(chapterPath);

    const imageSet = new Set();
    const pushImage = (url) => {
      const image = doujindesuNormalizeImageUrl(url);
      if (image) imageSet.add(image);
    };

    reader.find("#anu img, #anu noscript img").each((_, el) => {
      const img = $(el);
      [
        img.attr("data-src"),
        img.attr("data-lazy-src"),
        img.attr("data-original"),
        img.attr("src"),
      ].forEach(pushImage);

      [img.attr("data-srcset"), img.attr("srcset")]
        .filter(Boolean)
        .flatMap((srcset) => srcset.split(","))
        .map((entry) => entry.trim().split(/\s+/)[0])
        .forEach(pushImage);
    });

    const imageUrlMatches = html.match(/https?:\\?\/\\?\/desu\.photos\/storage\/uploads\/[^"'<>\s]+(?:%20|\\? |[^"'<>\s])*?\.webp/gi) || [];
    imageUrlMatches.forEach((image) => {
      pushImage(image.replace(/\\\//g, "/"));
    });

    const images = [...imageSet];

    if (!images.length) {
      const probedImages = await probeDoujindesuChapterImages(seriesTitle, title);
      images.push(...probedImages);
    }

    return {
      success: true,
      source: "doujindesu",
      mangaId,
      chapterSlug,
      currentChapter: title,
      title,
      slug: chapterSlug,
      chapter_id: reader.attr("data-id") || "",
      total_pages: parseInt(reader.attr("data-total-pages"), 10) || images.length,
      image_count: images.length,
      totalImages: images.length,
      chapter_link: chapterLink,
      series: {
        title: seriesTitle,
        slug: mangaId,
        link: seriesLink,
      },
      date,
      description,
      prev: prevPath ? doujindesuPathSlug(prevPath) : "",
      prev_link: prevPath ? doujindesuUrl(prevPath) : "",
      next: nextPath ? doujindesuPathSlug(nextPath) : "",
      next_link: nextPath ? doujindesuUrl(nextPath) : "",
      back_to_detail: mangaId,
      detail_link: allChapterPath ? doujindesuUrl(allChapterPath) : seriesLink,
      download_link: downloadLink,
      images,
    };
  } catch (err) {
    console.error("Doujindesu chapter error:", err.message);
    return {
      success: false,
      source: "doujindesu",
      message: "Gagal scrape chapter",
      error: err.message,
    };
  }
}


async function scrapeMangakuDetail(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://mangaku.onl/",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    // ================= BASIC =================
    const title = $("h1.entry-title").first().text().trim();

    const thumbnail =
      $(".thumb img").attr("src") ||
      $(".thumb img").attr("data-src") ||
      "";

    const rating = $(".rating .num").text().trim();

    // ================= INFO =================
    let status = "-";
    let type = "-";
    let author = "-";
    let views = "-";
    let updated = "-";

    $(".tsinfo .imptdt").each((_, el) => {
      const text = $(el).text();

      if (text.includes("Status"))
        status = $(el).find("i").text().trim();

      if (text.includes("Type"))
        type = $(el).find("a").text().trim();

      if (text.includes("Author"))
        author = $(el).find("i").text().trim();

      if (text.includes("Views"))
        views = $(el).find("span").text().trim();

      if (text.includes("Updated On"))
        updated = $(el).find("time").text().trim();
    });

    // ================= GENRES =================
    // Mangaku kadang gak punya genre jelas → fallback kosong
    const genres = [];

    // ================= SYNOPSIS =================
    const synopsis =
      $(".entry-content[itemprop='description']").text().trim() ||
      "Tidak ada sinopsis.";

    // ================= CHAPTER =================
    const chapters = [];

    $("#chapterlist li").each((_, el) => {
      const link = $(el).find("a").attr("href");
      const name = $(el).find(".chapternum").text().trim();
      const date = $(el).find(".chapterdate").text().trim();

      if (!link) return;

      const slug = link.split("/").filter(Boolean).pop();

      chapters.push({
        title: name,
        slug,
        link,
        date,
      });
    });
chapters.reverse();

    return {
      success: true,
      data: {
        title: title || "",
        thumbnail: thumbnail || "",
        type: type || "-",
        status: status || "-",

        // ✅ SAMAKAN FIELD
        Pengarang: author || "-",
        Umur: rating || "-", // rating jadi "umur" biar FE sama
        Konsep: views || "-", // bisa lu ganti nanti kalau mau

        genres: genres,
        synopsis: synopsis || "",

        info: updated || "-", // 🔥 last update

        total_chapter: chapters.length,
        chapters: chapters,
      },
    };
  } catch (err) {
    console.error("Error Mangaku:", err.message);

    return {
      success: false,
      message: "Gagal scrape detail.",
    };
  }
}


function getSlug(url) {
  return url.split("/").filter(Boolean).pop();
}

async function scrapeMangakuChapter(fullUrl) {
  try {
    const { data } = await axios.get(fullUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: "https://mangaku.onl/",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    const title = $("h1.entry-title").text().trim();

    const mangaLink = $(".allc a").attr("href") || "";
    const mangaId = mangaLink
      .split("/komik/")
      .pop()
      ?.replace(/\/$/, "") || "";

    const currentSlug = new URL(fullUrl).pathname
      .split("/")
      .filter(Boolean)
      .pop();

    // ================= AMBIL CHAPTER LIST =================
    const detailRes = await axios.get(
      `https://mangaku.onl/komik/${mangaId}/`
    );

    const $$ = cheerio.load(detailRes.data);

    const chapterList = [];

    $$("#chapterlist li").each((_, el) => {
      const link = $$(el).find("a").attr("href");
      if (!link) return;

      chapterList.push({
        slug: getSlug(link),
        link,
      });
    });

    // biasanya urutan dari terbaru → lama
    const reversed = chapterList.reverse();

    // ================= CARI INDEX =================
    const index = reversed.findIndex(c => c.slug === currentSlug);

    let prev = null;
    let next = null;

    if (index !== -1) {
      prev = reversed[index - 1]?.slug || null;
      next = reversed[index + 1]?.slug || null;
    }

    // ================= IMAGES =================
    const images = [];

    $("#readerarea img").each((_, el) => {
      let src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-lazy-src") ||
        "";

      if (src.startsWith("//")) {
        src = "https:" + src;
      }

      if (src) images.push(src.trim());
    });

    return {
      success: true,
      mangaId,
      currentChapter: title,

      // 🔥 ini fix
      prev,
      next,

      back_to_detail: `https://mangaku.onl/komik/${mangaId}/`,
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


async function scrapeMeionovelsList(page = 1) {
  const url =
    page === 1
      ? "https://meionovels.com/"
      : `https://meionovels.com/page/${page}/`;

  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  const results = [];

  // helper slug
  const getSlug = (link) => {
    if (!link) return "";
    const parts = link.split("/novel/");
    return parts[1]?.replace(/\/$/, "") || "";
  };

  const getChapterSlug = (link) => {
    if (!link) return "";
    const parts = link.split("/novel/");
    return parts[1]?.replace(/\/$/, "") || "";
  };

  $("#loop-content .page-item-detail").each((_, el) => {
    const item = $(el);

    const title = item.find(".post-title a").text().trim();
    const link = item.find(".post-title a").attr("href");

    const image =
      item.find(".item-thumb img").attr("src") ||
      item.find(".item-thumb img").attr("data-src");

    // 🔥 ambil chapter TERBARU saja
    const latestEl = item.find(".list-chapter .chapter-item").first();

    const latestChapter = latestEl.find(".chapter a").text().trim();
    const latestChapterLink = latestEl.find(".chapter a").attr("href");
    const latestTime = latestEl.find(".post-on").text().trim();

    if (title) {
      results.push({
        source: "meionovels",

        title,
        slug: getSlug(link), // slug novel
        detail_link: link,

        image,

        info: latestTime || "", // 🔥 waktu update

        chapter_terbaru: latestChapter || "",
        chapter_slug: getChapterSlug(latestChapterLink),

        chapter_link: latestChapterLink || "",
      });
    }
  });

  return results;
}


async function scrapeMeionovelsDetail(url) {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const title = $(".post-title h1").text().trim();
    const image = $(".summary_image img").attr("src");

    const synopsis = $("#editdescription").text().trim() 
                     || $(".summary__content").text().trim();

    const alternative = $(".post-content_item")
      .filter((i, el) => $(el).find("h5").text().includes("Alternative"))
      .find(".summary-content")
      .text()
      .trim();

    const author = $(".author-content a")
      .map((i, el) => $(el).text().trim())
      .get();

    const artist = $(".artist-content a")
      .map((i, el) => $(el).text().trim())
      .get();

    const genres = $(".genres-content a")
      .map((i, el) => $(el).text().trim())
      .get();

    const type = $(".post-content_item")
      .filter((i, el) => $(el).find("h5").text().includes("Type"))
      .find(".summary-content")
      .text()
      .trim();

    const status = $(".post-status .summary-content").last().text().trim();

    // 🔥 AMBIL SLUG DARI URL
    const slug = url.split("/novel/")[1].replace("/", "");

    // 🔥 AJAX CHAPTER REQUEST
    let chapters = [];

    try {
      const ajaxUrl = `https://meionovels.com/novel/${slug}/ajax/chapters/?t=1`;

      const res = await axios.post(
        ajaxUrl,
        {}, // body kosong
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            Referer: url,
            "X-Requested-With": "XMLHttpRequest",
            Accept: "*/*",
          },
        },
      );

      const $chap = cheerio.load(res.data);

      $chap("li.wp-manga-chapter").each((i, el) => {
        const a = $chap(el).find("a");

        chapters.push({
          title: a.text().trim(),
          url: a.attr("href"),
          date: $chap(el).find(".chapter-release-date i").text().trim(),
        });
      });
    } catch (err) {
      console.log("AJAX chapter error:", err.message);
    }

    return {
      success: true,
      data: {
        source: "meionovels",
        title,
        image,
        synopsis,
        alternative,
        author,
        artist,
        genres,
        type,
        status,
        chapters,
      },
    };
  } catch (err) {
    return {
      success: false,
      message: err.message,
    };
  }
}

async function scrapeMeioChapter(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $ = cheerio.load(data);

    // TITLE
    const chapterTitle = $("#chapter-heading").text().trim();

    // CLEAN CONTENT
    $(".reading-content .chapter-warning").remove();
    $(".reading-content script").remove();

    const contentHtml = $(".reading-content").prop("innerHTML");
    function getSlug(url) {
      if (!url) return null;

      return url
        .replace("https://meionovels.com/novel/", "")
        .replace(/^\/|\/$/g, ""); // hapus slash depan & belakang
    }
    // NAVIGATION
    const prevUrl = $(".nav-previous a").attr("href");
    const nextUrl = $(".nav-next a").attr("href");

    const prevChapter = getSlug(prevUrl);
    const nextChapter = getSlug(nextUrl);

    return {
      success: true,
      source: "meionovels",
      title: chapterTitle,
      prev: prevChapter,
      next: nextChapter,
      contentHtml,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}




app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "API Komatoon aktif!",
    endpoints: [
      "/komiku/terbaru",
      "/komiku/detail/:slug",
      "/komiku/chapter/:slug",
      "/doujindesu/terbaru",
      "/doujindesu/manhwa/terbaru",
      "/doujindesu/detail/:slug",
      "/doujindesu/chapter/:slug",
      "/doujindesu/search?q=",
    ],
  });
});

// === Route: Komiku Terbaru ===
app.get("/komiku/terbaru", async (req, res) => {
  const data = await scrapeKomikuTerbaru();
  if (data.length === 0)
    return res
      .status(500)
      .json({ success: false, message: "Gagal mengambil data terbaru." });

  res.json({ success: true, total: data.length, data });
});

// === Home (Gabungan semua data: Terbaru + Populer Manga/Manhwa/Manhua) ===
app.get("/komiku/home", async (_, res) => {
  try {
    const [terbaru, populerManga, populerManhwa, populerManhua] =
      await Promise.all([
        scrapeKomikuTerbaru(),
        scrapeKomikuPopuler("Manga"),
        scrapeKomikuPopuler("Manhwa"),
        scrapeKomikuPopuler("Manhua"),
      ]);

    res.json({
      success: true,
      message: "Gabungan semua data komik",
      data: {
        terbaru,
        populer_manga: populerManga,
        populer_manhwa: populerManhwa,
        populer_manhua: populerManhua,
      },
    });
  } catch (err) {
    console.error("Gagal ambil data home:", err.message);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data home",
      error: err.message,
    });
  }
});

// === Route: Detail Komik ===
app.get("/komiku/detail/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug)
    return res
      .status(400)
      .json({ success: false, message: "Slug tidak diberikan!" });

  const fullUrl = `https://komiku.org/manga/${slug}/`;
  const result = await scrapeKomikuDetail(fullUrl);
  res.json(result);
});



// === Route: Chapter ===
app.get("/komiku/chapter/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!slug)
    return res
      .status(400)
      .json({ success: false, message: "Slug tidak diberikan!" });

  const fullUrl = `https://komiku.org/${slug}/`;
  const result = await scrapeKomikuChapter(fullUrl);

  if (result?.success && Array.isArray(result.images)) {
    result.images = result.images
      .filter(Boolean)
      .map((imageUrl) => toKomikuWorkerImageUrl(imageUrl));
  }

  res.json(result);
});

app.get("/komiku/search", async (req, res) => {
  const { q } = req.query;
  if (!q)
    return res
      .status(400)
      .json({ success: false, message: "Masukkan parameter ?q=" });

  try {
    const url = `https://api.komiku.org/?post_type=manga&s=${encodeURIComponent(
      q,
    )}`;
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      timeout: 9000, // 9 detik
    });

    const $ = cheerio.load(data);
    const results = [];

    $(".bge").each((_, el) => {
      const title = $(el).find(".kan h3").text().trim();
      const img =
        $(el).find(".bgei img").attr("src") ||
        $(el).find(".bgei img").attr("data-src");
      const link = $(el).find(".bgei a").attr("href");
      const update = $(el).find(".kan p").text().trim();

      results.push({
        title,
        image: img?.startsWith("http") ? img : `https://komiku.org${img}`,
        detail_link: link?.startsWith("http")
          ? link
          : `https://komiku.org${link}`,
        update,
      });
    });

    res.json({
      success: true,
      total: results.length,
      query: q,
      data: results,
    });
  } catch (err) {
    console.error(err.message);
    res
      .status(500)
      .json({ success: false, message: "Gagal mengambil data pencarian" });
  }
});

const komikuCache = {};
const CACHE_DURATION = 2000 * 60 * 30; // 30 menit

app.get("/komiku/list", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const huruf = req.query.huruf || null;
    const tipe = req.query.tipe || null;

    const cacheKey = `p:${page}|h:${huruf}|t:${tipe}`;

    // ================= CACHE =================
    if (
      !komikuCache[cacheKey] ||
      Date.now() - komikuCache[cacheKey].time > CACHE_DURATION
    ) {
      console.log("🔄 Scrape Komiku:", cacheKey);

      const data = await scrapeKomikuList({
        page,
        huruf,
        tipe,
      });

      komikuCache[cacheKey] = {
        time: Date.now(),
        data,
      };
    } else {
      console.log("⚡ Cache Komiku:", cacheKey);
    }

    res.json({
      success: true,
      source: "komiku",
      ...komikuCache[cacheKey].data,
    });
  } catch (err) {
    console.error("❌ API /komiku/list error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get("/genre/:genre", async (req, res) => {
  const { genre } = req.params;
  const { page } = req.query;

  const data = await scrapeGenreKomiku(genre, page || 1);
  res.json({
    genre,
    page: page || 1,
    total: data.length,
    results: data,
  });
});

// =======================================================
// 📚 ROUTE: PUSTAKA KOMIKU (API)
// =======================================================
app.get("/komiku/pustaka", async (req, res) => {
  const page = parseInt(req.query.page) || 1;

  const data = await scrapeKomikuPustaka(page);

  if (!data.length) {
    return res.json({
      success: true,
      page,
      total: 0,
      data: [],
      warning: "Data kosong / API Komiku sedang limit",
    });
  }

  res.json({
    success: true,
    source: "api.komiku.org",
    page,
    total: data.length,
    data,
  });
});

app.get("/komiku/filters", async (req, res) => {
  const data = await scrapeKomikuFilters();

  res.json({
    success: true,
    data,
  });
});

app.get("/komiku/pustaka-filter", async (req, res) => {
  try {
    const { orderby, tipe, genre, genre2, status } = req.query;

    const page = Math.max(1, parseInt(req.query.page) || 1);

    console.log("🔄 Scrape Filter:", {
      page,
      orderby,
      tipe,
      genre,
      genre2,
      status,
    });

    const data = await scrapeKomikuPustakaFilter({
      orderby,
      tipe,
      genre,
      genre2,
      status,
      page,
    });

    res.json({
      success: true,
      query: {
        page,
        orderby,
        tipe,
        genre,
        genre2,
        status,
      },
      ...data,
    });
  } catch (err) {
    console.error("❌ API filter error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get("/kiryuu/pustaka", async (req, res) => {
  const page = parseInt(req.query.page) || 1;

  const result = await scrapeKiryuuPustaka({ page });

  if (!result.data.length) {
    return res.json({
      success: true,
      page,
      total: 0,
      data: [],
      warning: "Data kosong / Kiryuu limit",
    });
  }

  res.json({
    success: true,
    source: "v6.kiryuu.to",
    page,
    total: result.data.length,
    data: result.data,
  });
});

app.get("/kiryuu/detail/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Slug tidak diberikan!",
      });
    }

    const fullUrl = `https://v6.kiryuu.to/manga/${slug}/`;

    const result = await scrapeKiryuuDetail(fullUrl);

    res.json(result);
  } catch (err) {
    console.error("Route error:", err.message);

    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
    });
  }
});

app.get(/^\/kiryuu\/chapter\/(.+)/, async (req, res) => {
  try {
    const slug = req.params[0];

    const fullUrl = `https://v6.kiryuu.to/manga/${slug}/`;

    const result = await scrapeKiryuuChapter(fullUrl);

    res.json(result);
  } catch (err) {
    res.json({
      success: false,
      message: err.message,
    });
  }
});

app.get("/kiryuu/search", async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({
      success: false,
      message: "Masukkan parameter ?q=",
    });
  }

  try {
    // =============================
    // 1. AXIOS INSTANCE (biar lolos bot)
    // =============================
    const client = axios.create({
      withCredentials: true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Connection: "keep-alive",
      },
      timeout: 15000,
    });

    // =============================
    // 2. AMBIL NONCE + COOKIE
    // =============================
    const nonceRes = await client.get(
      "https://v6.kiryuu.to/wp-admin/admin-ajax.php?type=search_form&action=get_nonce",
    );

    const cookies = nonceRes.headers["set-cookie"] || [];

    const nonceMatch = nonceRes.data.match(/value='(.*?)'/);
    if (!nonceMatch) throw new Error("Nonce tidak ditemukan");

    const nonce = nonceMatch[1];

    // =============================
    // 3. PARAMS SEARCH
    // =============================
    const params = new URLSearchParams();

    params.append("action", "advanced_search");
    params.append("nonce", nonce);
    params.append("query", q);
    params.append("page", "1");
    params.append("order", "desc");
    params.append("orderby", "updated");
    params.append("inclusion", "OR");
    params.append("exclusion", "OR");

    // array wajib []
    params.append("genre[]", "");
    params.append("genre_exclude[]", "");
    params.append("author[]", "");
    params.append("artist[]", "");
    params.append("type[]", "");
    params.append("status[]", "");
    params.append("project", "0");

    // =============================
    // 4. REQUEST SEARCH
    // =============================
    const { data } = await client.post(
      "https://v6.kiryuu.to/wp-admin/admin-ajax.php",
      params,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://v6.kiryuu.to/advanced-search/",
          Origin: "https://v6.kiryuu.to",
          Cookie: cookies.join("; "), // 🔥 penting
        },
      },
    );

    // =============================
    // 5. PARSING
    // =============================
    const $ = cheerio.load(data);
    const results = [];

    $(".flex.rounded-lg.overflow-hidden").each((_, el) => {
      const container = $(el);

      const link = container.find("a").first().attr("href") || "";
      const image = container.find("img").first().attr("src") || "";

      const title = container.find("a.text-base").first().text().trim();

      const latestChapter = container
        .find("span.text-sm")
        .first()
        .text()
        .trim();

      const status = container.find("span.bg-accent").first().text().trim();

      const update = latestChapter
        ? `${latestChapter}${status ? ` • ${status}` : ""}`
        : "";

      if (title && link) {
        results.push({
          title,
          image,
          detail_link: link,
          update,
        });
      }
    });

    // =============================
    // 6. RESPONSE
    // =============================
    res.json({
      success: true,
      total: results.length,
      query: q,
      data: results,
    });
  } catch (err) {
    console.error("❌ Kiryuu search error:", err.message);

    // fallback biar gak crash frontend
    res.status(200).json({
      success: true,
      total: 0,
      query: q,
      data: [],
      warning: "Kiryuu kemungkinan block request (403)",
    });
  }
});

app.get(
  ["/doujindesu/terbaru", "/doujindesu/pustaka", "/doujindesu/manhwa/terbaru"],
  async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = await scrapeDoujindesuTerbaru({ page });

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
  },
);

app.get(
  ["/sekte/terbaru", "/sekte/pustaka", "/sektedoujin/terbaru", "/sektedoujin/pustaka"],
  async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const result = await scrapeSekteTerbaru({ page });

    if (!result.success) {
      return res.status(500).json(result);
    }

    res.json(result);
  },
);

app.get(["/sekte/detail/:slug", "/sektedoujin/detail/:slug"], async (req, res) => {
  const { slug } = req.params;

  if (!slug) {
    return res.status(400).json({
      success: false,
      message: "Slug tidak diberikan!",
    });
  }

  const result = await scrapeSekteDetail(slug);

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
});

app.get(["/sekte/search", "/sektedoujin/search"], async (req, res) => {
  const { q, page = 1 } = req.query;

  if (!q) {
    return res.status(400).json({
      success: false,
      message: "Masukkan parameter ?q=",
    });
  }

  const result = await scrapeSekteSearch(q, Math.max(1, parseInt(page, 10) || 1));

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
});

app.get([/^\/sekte\/chapter\/(.+)/, /^\/sektedoujin\/chapter\/(.+)/], async (req, res) => {
  const slug = req.params[0];

  if (!slug) {
    return res.status(400).json({
      success: false,
      message: "Slug tidak diberikan!",
    });
  }

  const result = await scrapeSekteChapter(slug);

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
});

app.get("/doujindesu/detail/:slug", async (req, res) => {
  const { slug } = req.params;

  if (!slug) {
    return res.status(400).json({
      success: false,
      message: "Slug tidak diberikan!",
    });
  }

  const result = await scrapeDoujindesuDetail(slug);

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
});

app.get("/doujindesu/search", async (req, res) => {
  const { q, page = 1 } = req.query;

  if (!q) {
    return res.status(400).json({
      success: false,
      message: "Masukkan parameter ?q=",
    });
  }

  const result = await scrapeDoujindesuSearch(q, Math.max(1, parseInt(page, 10) || 1));

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
});

app.get(/^\/doujindesu\/chapter\/(.+)/, async (req, res) => {
  const slug = req.params[0];

  if (!slug) {
    return res.status(400).json({
      success: false,
      message: "Slug tidak diberikan!",
    });
  }

  const result = await scrapeDoujindesuChapter(slug);

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
});


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


// ================= ROUTE =================
app.get(/^\/mangaku\/chapter\/(.+)/, async (req, res) => {
  try {
    const slug = req.params[0];
    const fullUrl = `https://mangaku.onl/${slug}/`;

    const result = await scrapeMangakuChapter(fullUrl);

    res.json(result);
  } catch (err) {
    res.json({
      success: false,
      message: err.message,
    });
  }
});







// ================= ENDPOINT =================

app.get("/mangaku/pustaka", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const result = await scrapeMangakuPustaka({ page });

  if (!result.data.length) {
    return res.json({
      success: true,
      page,
      total: 0,
      data: [],
      warning: "Data kosong / Site limit",
    });
  }

  res.json(result);
});


app.get("/mangaku/detail/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Slug tidak diberikan!",
      });
    }

    const fullUrl = `https://mangaku.onl/komik/${slug}/`;

    const result = await scrapeMangakuDetail(fullUrl);

    res.json(result);
  } catch (err) {
    console.error("Route error:", err.message);

    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
    });
  }
});

app.get("/mangaku/search", async (req, res) => {
  const { q, page = 1 } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({ success: false, message: "Masukkan parameter ?q=" });
  }

  try {
    const url =
      page == 1
        ? `https://mangaku.onl/?s=${encodeURIComponent(q)}`
        : `https://mangaku.onl/page/${page}/?s=${encodeURIComponent(q)}`;

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(data);
    const results = [];

    $(".listupd .bs").each((_, el) => {
      const anchor = $(el).find("a");

      const title = anchor.attr("title")?.trim() || "";
      const link = anchor.attr("href") || "";

      let image = $(el).find("img").attr("src") || "";
      if (image.startsWith("//")) image = "https:" + image;

      // 🔥 bersihin CDN wp.com kalau mau
      image = image.replace(/^https:\/\/i\d\.wp\.com\//, "https://");

      const chapter = $(el).find(".epxs").text().trim() || "";

      const slug = link
        .replace("https://mangaku.onl/komik/", "")
        .replace(/\/$/, "");

      results.push({
        title,
        image,
        detail_link: link,
        update: chapter, // 🔥 samain nama dengan komiku
        slug: `mangaku-${slug}`, // 🔥 penting buat sistem kamu
        source: "mangaku",
      });
    });

    res.json({
      success: true,
      total: results.length,
      query: q,
      page: Number(page),
      data: results,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data pencarian",
    });
  }
});


app.get(/^\/meionovels\/chapter\/(.*)/, async (req, res) => {
  try {
    const slug = req.params[0];

    const fullUrl = `https://meionovels.com/novel/${slug}`;

    const result = await scrapeMeioChapter(fullUrl);
    const series = slug.split("/")[0];

    res.json({
      ...result,
      series, // ← ini yang kamu mau
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// ================= ENDPOINT =================

app.get("/meionovels/pustaka", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;

    const data = await scrapeMeionovelsList(page);

    res.json({
      success: true,
      page,
      total: data.length,
      data,
    });
  } catch (err) {
    res.json({
      success: false,
      message: err.message,
    });
  }
});

app.get("/meionovels/detail/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Slug tidak diberikan!",
      });
    }

    const fullUrl = `https://meionovels.com/novel/${slug}/`;

    const result = await scrapeMeionovelsDetail(fullUrl);

    res.json(result);
  } catch (err) {
    console.error("Route error:", err.message);

    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
    });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 Server jalan di http://localhost:${PORT}`),
);
