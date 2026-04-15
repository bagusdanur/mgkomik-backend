const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3001;

async function scrapeMgkomikPustaka({ page = 1 } = {}) {
  try {
    const url =
      page === 1
        ? "https://id.mgkomik.cc/komik/"
        : `https://id.mgkomik.cc/komik/page/${page}/`;

    console.log("🔥 URL:", url);

    const { data } = await axios.get(url, {
     headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://id.mgkomik.cc/",
  },
  timeout: 15000,
    });

    const $ = cheerio.load(data);
    const results = [];

    $(".page-item-detail.manga").each((_, el) => {
      const title = $(el).find(".post-title a").text().trim();
      const link = $(el).find(".post-title a").attr("href");

      const image =
        $(el).find(".item-thumb img").attr("data-src") ||
        $(el).find(".item-thumb img").attr("src") ||
        "";

      const typeGenre =
        $(el)
          .find(".manga-type-badges img")
          .attr("src")
          ?.split("/")
          .pop()
          ?.replace(".png", "") || "";

      // ambil chapter
      const chapters = [];

      $(el)
        .find(".chapter-item")
        .each((i, ch) => {
          const chTitle = $(ch).find("a").text().trim();

          chapters.push(chTitle);
        });

      const chapterAwal = chapters[chapters.length - 1] || "";
      const chapterTerbaru = chapters[0] || "";

      if (!title || !link) return;

      results.push({
        title,
        slug: link
          .replace("https://id.mgkomik.cc/komik/", "")
          .replace(/\/$/, ""),

        image,
        detail_link: link,

        description: "", // MGKomik list ga ada → kosongin biar aman
        type_genre: typeGenre,
        info: "", // biar FE gak error

        chapter_awal: chapterAwal,
        chapter_terbaru: chapterTerbaru,
      });
    });

    // ================= PAGINATION =================
    let totalPages = 1;

    const lastPage = $(".wp-pagenavi a")
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
    console.error("❌ MGKomik error:", err.message);

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

async function scrapeMgkomikDetail(url) {
  try {
    const { data } = await axios.get(url, {
    headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://id.mgkomik.cc/",
  },
  timeout: 15000,
    });

    const $ = cheerio.load(data);

    const title = $("h1").first().text().trim();

    const thumbnail =
      $(".summary_image img").attr("data-src") ||
      $(".summary_image img").attr("src") ||
      "";

    const info = {};

    let type = "";
    let status = "";
    let release = "";
    let alternative = "";
    let rating = "";

    $(".post-content_item").each((_, el) => {
      const key = $(el)
        .find(".summary-heading h5")
        .text()
        .replace(":", "")
        .trim()
        .toLowerCase();

      const value = $(el).find(".summary-content").text().trim();

      if (key && value) {
        info[key] = value;
      }
    });

    type = info["type"] || "";
    status = info["status"] || "";
    release = info["release"] || "";
    alternative = info["alternative"] || "";
    rating = info["rank"] || "";

    // ================= GENRES =================
    const genres = $(".genres-content a")
      .map((i, el) => $(el).text().trim())
      .get();

    // ================= SYNOPSIS =================
    const synopsis =
      $(".description-summary .summary__content").text().trim() ||
      "Tidak ada sinopsis.";

    // ================= CHAPTER =================
    const chapters = [];

    $("li.wp-manga-chapter").each((i, el) => {
      const chapterLink = $(el).find("a").attr("href");
      const chapterTitle = $(el).find("a").text().trim();
      const date = $(el).find(".chapter-release-date").text().trim();

      if (chapterLink && chapterTitle) {
        chapters.push({
          title: chapterTitle,
          link: chapterLink,
          slug: chapterLink
            .replace("https://id.mgkomik.cc/komik/", "")
            .replace(/\/$/, ""), // hapus slash belakang saja
          date,
        });
      }
    });

    // balik biar dari awal → akhir (kayak Komiku)
    chapters.reverse();

    return {
      success: true,
      data: {
        title: title || "Tidak ada judul",
        thumbnail: thumbnail || "",
        type: type || "Tidak diketahui",
        status: status || "Tidak diketahui",

        // ⚠️ mapping biar sama Komiku
        Pengarang: "Tidak diketahui", // MGKomik ga ada
        Umur: rating || "Tidak diketahui",
        Konsep: alternative || "Tidak diketahui",

        genres: genres || [],
        synopsis: synopsis || "Tidak ada sinopsis.",

        total_chapter: chapters.length || 0,
        chapters: chapters || [],
      },
    };
  } catch (err) {
    console.error("Gagal scrape detail MGKomik:", err.message);

    return {
      success: false,
      message: "Gagal mengambil data detail komik.",
    };
  }
}

async function scrapeMgkomikChapter(url) {
  try {
    const { data } = await axios.get(url, {
    headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://id.mgkomik.cc/",
  },
  timeout: 15000,
    });

    const $ = cheerio.load(data);

    // ================= CLEAN IMAGE =================
    function cleanImageUrl(url) {
      return url
        .replace(/\s+/g, "")
        .replace("https://https://", "https://")
        .trim();
    }

    // ================= IMAGES =================
    const images = [];

    $(".reading-content img").each((i, el) => {
      let src = $(el).attr("data-src") || $(el).attr("src") || "";

      src = cleanImageUrl(src);

      if (src.startsWith("//")) {
        src = "https:" + src;
      }

      if (src) images.push(src);
    });

    // ================= SLUG =================
    const chapterSlug = url
      .replace("https://id.mgkomik.cc/komik/", "")
      .replace(/\/$/, "");

    // ================= MANGA ID =================
    const parts = url.split("/").filter(Boolean);
    const mangaId = parts[parts.indexOf("komik") + 1];

    // ================= AMBIL DETAIL =================
    const detail = await scrapeMgkomikDetail(
      `https://id.mgkomik.cc/komik/${mangaId}/`,
    );

    if (!detail.success || !detail.data) {
      return {
        success: false,
        message: "Gagal ambil detail komik",
      };
    }

    const chapters = detail.data.chapters || [];

    // ================= 🔥 FIX MATCH =================
    const normalize = (str) =>
      str.toLowerCase().replace(/\/$/, "").replace("komik/", "").trim();

    const currentSlug = normalize(chapterSlug);

    const index = chapters.findIndex((c) => {
      const slug = normalize(c.slug);
      return currentSlug.includes(slug) || slug.includes(currentSlug);
    });

    let safeIndex = index;

    if (safeIndex === -1) {
      console.log("⚠️ Chapter tidak ketemu, fallback ke 0");
      safeIndex = 0;
    }

    // ================= RESULT =================
    return {
      success: true,
      mangaId,
      chapterSlug,
      currentChapter: chapters[safeIndex]?.title || "",
      prev: safeIndex > 0 ? chapters[safeIndex - 1].slug : null,
      next:
        safeIndex < chapters.length - 1 ? chapters[safeIndex + 1].slug : null,
      back_to_detail: mangaId,
      images,
    };
  } catch (err) {
    console.error("Gagal scrape chapter:", err.message);
    return {
      success: false,
      message: err.message,
    };
  }
}

app.get("/mgkomik/pustaka", async (req, res) => {
  const page = parseInt(req.query.page) || 1;

  const result = await scrapeMgkomikPustaka({ page });

  if (!result.data.length) {
    return res.json({
      success: true,
      page,
      total: 0,
      data: [],
      warning: "Data kosong / MGKomik limit",
    });
  }

  res.json({
    success: true,
    source: "id.mgkomik.cc",
    page,
    total: result.data.length,
    data: result.data,
  });
});

app.get("/mgkomik/detail/:slug", async (req, res) => {
  const { slug } = req.params;

  if (!slug) {
    return res.status(400).json({
      success: false,
      message: "Slug tidak diberikan!",
    });
  }

  const fullUrl = `https://id.mgkomik.cc/komik/${slug}/`;

  const result = await scrapeMgkomikDetail(fullUrl);

  res.json(result);
});

app.get(/^\/mgkomik\/chapter\/(.+)/, async (req, res) => {
  const slug = req.params[0]; // ambil hasil regex

  const fullUrl = `https://id.mgkomik.cc/komik/${slug}/`;
  const result = await scrapeMgkomikChapter(fullUrl);

  res.json(result);
});

app.get("/proxy", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send("URL kosong");
  }

  try {
    const response = await axios.get(url, {
      responseType: "stream",
      headers: {
        
        Referer: "https://id.mgkomik.cc/",
        "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Connection": "keep-alive",
      },
    });

    res.setHeader("Content-Type", response.headers["content-type"]);
    response.data.pipe(res);
  } catch (err) {
    res.status(500).send("Gagal ambil gambar");
  }
});

app.listen(PORT, () =>
  console.log(`🚀 Server jalan di http://localhost:${PORT}`),
);
