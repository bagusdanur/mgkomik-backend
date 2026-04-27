const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3012;
const cors = require("cors");

app.use(
  cors({
    origin: "*",
  }),
);

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
    const url =
      page === 1
        ? "https://v4.kiryuu.to/latest/"
        : `https://v4.kiryuu.to/latest/?the_page=${page}`;

    console.log("🔥 URL:", url);

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
        Referer: "https://v4.kiryuu.to/",
        Connection: "keep-alive",
      },
      timeout: 15000,
    });

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
    console.error("❌ Kiryuu Latest error:", err.message);

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
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
        Referer: "https://v4.kiryuu.to/",
        Connection: "keep-alive",
      },
      timeout: 15000,
    });

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
        const ajaxUrl = `https://v4.kiryuu.to/wp-admin/admin-ajax.php?manga_id=${manga_id}&page=1&action=chapter_list`;

        const { data: chapterHTML } = await axios.get(ajaxUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
            Referer: "https://v4.kiryuu.to/",
            Connection: "keep-alive",
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
      console.log("Error ambil chapter:", err.message);
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
    console.error("Error Kiryuu:", err.message);

    return {
      success: false,
      message: "Gagal scrape detail.",
    };
  }
}

async function scrapeKiryuuChapter(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36",
        Referer: "https://v4.kiryuu.to/",
      },
      timeout: 15000,
    });

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
      .replace("https://v4.kiryuu.to/manga/", "")
      .replace(/\/$/, "");

    return {
      success: true,
      mangaId,
      chapterSlug,
      currentChapter: title,
      prev,
      next,
      back_to_detail: `https://v4.kiryuu.to/manga/${mangaId}/`,
      totalImages: images.length,
      images,
    };
  } catch (err) {
    console.error("Error scrape:", err.message);
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

    $("#Terbaru .ls4w article.ls4").each((_, el) => {
      const element = $(el);
      const link = element.find(".ls4v a").attr("href");
      const imgEl = element.find(".ls4v img");

      // 🔧 Ambil atribut gambar asli (lazy load fix)
      const image =
        imgEl.attr("data-src") ||
        imgEl.attr("data-lazy-src") ||
        imgEl.attr("src") ||
        "";

      const title = element.find(".ls4j h3 a").text().trim();
      const typeGenreTime = element.find(".ls4s").text().trim(); // contoh: "Manhwa Fantasi 4 menit lalu"
      const chapterTitle = element.find(".ls24").text().trim();
      const chapterLink = element.find(".ls24").attr("href");
      const up = element.find(".ls4v .up").text().trim() || "";

      // 🧠 Pisahkan type, genre, dan waktu
      const parts = typeGenreTime.split(" ");
      const type = parts.shift() || "";
      let waktu = "";
      let genre = "";

      // cari pola waktu (misal: "4 menit lalu", "2 jam lalu")
      const matchWaktu = typeGenreTime.match(/(\d+ [a-zA-Z]+ lalu)/);
      if (matchWaktu) {
        waktu = matchWaktu[1];
        genre = typeGenreTime.replace(type, "").replace(waktu, "").trim();
      } else {
        genre = typeGenreTime.replace(type, "").trim();
      }

      const fullLink = link ? `https://komiku.org${link}` : "";

      const slug = fullLink
        ? fullLink.replace("https://komiku.org/manga/", "").replace(/\//g, "")
        : "";

      results.push({
        title,
        slug,
        link: fullLink,
        image: image.startsWith("http") ? image : `https://komiku.org${image}`,
        type,
        genre,
        waktu,
        chapter_terbaru: chapterTitle,
        chapter_link: chapterLink ? `https://komiku.org${chapterLink}` : "",
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

// === Scraper: Komik Populer (Manga/Manhwa/Manhua) ===
async function scrapeKomikuPopuler(selectorId) {
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

    $(`${selectorId} article.ls2`).each((_, el) => {
      const link = $(el).find(".ls2v a").attr("href");
      const imgEl = $(el).find(".ls2v img");
      const image = imgEl.attr("data-src") || imgEl.attr("src") || "";
      const title = $(el).find(".ls2j h3 a").text().trim();
      const genreViews = $(el).find(".ls2t").text().trim(); // contoh: "Fantasi 1.1jtx"
      const chapterTitle = $(el).find(".ls2l").text().trim();
      const chapterLink = $(el).find(".ls2l").attr("href");

      const [genre, views] = genreViews.split(" ");

      results.push({
        title,
        link: `https://komiku.org${link}`,
        image: image.startsWith("http") ? image : `https://komiku.org${image}`,
        genre,
        views,
        chapter_terbaru: chapterTitle,
        chapter_link: chapterLink ? `https://komiku.org${chapterLink}` : "",
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

    // Ambil mangaId
    const mangaId = chapterSlug.split("-chapter")[0];

    // Ambil daftar chapter
    const detail = await scrapeKomikuDetail(
      `https://komiku.org/manga/${mangaId}/`,
    );
    const chapters = detail.data.chapters;

    // Cari index chapter saat ini
    const index = chapters.findIndex((c) => c.slug === chapterSlug);

    return {
      success: true,
      mangaId,
      chapterSlug,
      currentChapter: chapters[index]?.title || "",
      prev: index > 0 ? chapters[index - 1].slug : null,
      next: index < chapters.length - 1 ? chapters[index + 1].slug : null,
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
        scrapeKomikuPopuler("#Komik_Hot_Manga"),
        scrapeKomikuPopuler("#Komik_Hot_Manhwa"),
        scrapeKomikuPopuler("#Komik_Hot_Manhua"),
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
app.get("/pustaka", async (req, res) => {
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
    source: "v4.kiryuu.to",
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

    const fullUrl = `https://v4.kiryuu.to/manga/${slug}/`;

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

    const fullUrl = `https://v4.kiryuu.to/manga/${slug}/`;

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
      "https://v5.kiryuu.to/wp-admin/admin-ajax.php?type=search_form&action=get_nonce",
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
      "https://v5.kiryuu.to/wp-admin/admin-ajax.php",
      params,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://v5.kiryuu.to/advanced-search/",
          Origin: "https://v5.kiryuu.to",
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
