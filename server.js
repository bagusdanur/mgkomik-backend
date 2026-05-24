const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3013;
const SEKTE_BASE_URL = "https://sektedoujin.cc";
const SEKTE_PROXY_URL = "https://sekte.ezcantik9.workers.dev?url=";

app.use(cors({ origin: "*" }));

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
    return (
      new URL(sekteUrl(url)).pathname.split("/").filter(Boolean).pop() || ""
    );
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
    return "";
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
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    Referer: SEKTE_BASE_URL,
  };

  const { data } = await axios.get(proxyUrl, {
    headers,
    timeout: 20000,
  });

  return data;
}

async function scrapeSekteTerbaru({ page = 1 } = {}) {
  try {
    const latestPath = page === 1 ? "/manga/?order=update" : `/manga/?page=${page}&order=update`;
    const html = await sekteFetch(latestPath);
    const $ = cheerio.load(html);
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
      const isColored = item.find(".colored").length > 0;
      const isHot = item.find(".hotx").length > 0;

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
        info: status || score || "",
        update: chapterTitle,
        chapter_terbaru: chapterTitle,
        chapter_slug: chapterSlug,
        chapter_link: chapterSlug ? sekteUrl(`/${chapterSlug}/`) : "",
        status,
        score,
        rating: score,
        rating_percent: ratingPercent,
        is_colored: isColored,
        is_hot: isHot,
      });
    });

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
      ) || images.length;

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

app.get("/", (_, res) => {
  res.json({
    success: true,
    endpoints: [
      "/sekte/terbaru",
      "/sektedoujin/terbaru",
      "/sekte/chapter/:slug",
      "/sektedoujin/chapter/:slug",
    ],
  });
});

app.get(["/sekte/terbaru", "/sekte/pustaka", "/sektedoujin/terbaru", "/sektedoujin/pustaka"], async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = await scrapeSekteTerbaru({ page });

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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Sekte scraper jalan di http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  scrapeSekteTerbaru,
  scrapeSekteChapter,
};
