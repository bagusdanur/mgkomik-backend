"use strict";

const axios = require("axios");
const cheerio = require("cheerio");

const BASE = "https://www.mgeko.cc";
const PER_PAGE = 24;

function isAllowedImageHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "mgeko.cc" ||
    host === "www.mgeko.cc" ||
    host.endsWith(".mgeko.cc") ||
    /^imgsrv\d*\.com$/.test(host) ||
    host.endsWith(".imgsrv5.com")
  );
}

function headers(referer = `${BASE}/`) {
  return {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: referer,
    "User-Agent":
      process.env.MGEKO_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  };
}

async function mgekoFetch(path, options = {}) {
  const url = path.startsWith("http")
    ? path
    : `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const response = await axios.get(url, {
    headers: {
      ...headers(options.referer),
      ...(options.headers || {}),
    },
    timeout: options.timeout || 25000,
    responseType: options.responseType || "text",
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Mgeko upstream HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.data;
}

function text(value, fallback = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim() || fallback;
}

function cleanSlug(value = "") {
  try {
    return new URL(value, BASE).pathname
      .replace(/^\/manga\//i, "")
      .replace(/^\/+|\/+$/g, "");
  } catch (_) {
    return text(value)
      .replace(/^https?:\/\/(?:www\.)?mgeko\.cc\/manga\//i, "")
      .replace(/^\/manga\//i, "")
      .replace(/^\/+|\/+$/g, "")
      .split(/[?#]/)[0];
  }
}

function cleanChapterSlug(value = "") {
  try {
    return new URL(value, BASE).pathname
      .replace(/^\/reader\/en\//i, "")
      .replace(/^\/+|\/+$/g, "");
  } catch (_) {
    return text(value)
      .replace(/^https?:\/\/(?:www\.)?mgeko\.cc\/reader\/en\//i, "")
      .replace(/^\/reader\/en\//i, "")
      .replace(/^\/+|\/+$/g, "")
      .split(/[?#]/)[0];
  }
}

function normalizeImage(value = "") {
  const src = text(value).replace(/&amp;/g, "&");
  if (!src || /^data:|^blob:/i.test(src) || src.includes("default-placeholder") || src.includes("loading.gif")) {
    return "";
  }
  if (/^\/\//.test(src)) return `https:${src}`;
  if (/^https?:\/\//i.test(src)) return src.replace(/^http:/i, "https:");
  return `${BASE}/${src.replace(/^\/+/, "")}`;
}

function requestBase(req) {
  const forwarded = req.headers["x-forwarded-proto"];
  const protocol = String(forwarded || req.protocol || "http").split(",")[0].trim();
  return `${protocol}://${req.get("host")}`;
}

function proxyImage(value, req) {
  const url = normalizeImage(value);
  return url
    ? `${requestBase(req)}/mgeko/image?url=${encodeURIComponent(url)}`
    : "";
}

function rewriteImages(payload, req) {
  if (Array.isArray(payload)) return payload.map((item) => rewriteImages(item, req));
  if (!payload || typeof payload !== "object") return payload;
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      output[key] = value.map((image) => proxyImage(image, req)).filter(Boolean);
    } else if (
      ["image", "thumbnail", "cover", "chapter_thumbnail"].includes(key) &&
      typeof value === "string"
    ) {
      output[key] = proxyImage(value, req);
    } else if (value && typeof value === "object") {
      output[key] = rewriteImages(value, req);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function parsePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

function unique(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = item[key];
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function formatChapterTitle(rawTitle, slug = "") {
  const cleaned = text(rawTitle).replace(/\s+(?:\d+\s+(?:hours?|mins?|minutes?|days?|weeks?|months?|years?|ago|[,\d\s]+))+$/i, "").trim();
  const numMatch = cleaned.match(/(?:Chapter|Ch\.)?\s*([\d.]+)(?:-eng-li)?/i) || slug.match(/chapter-([\d.]+)/i);
  if (numMatch) {
    return `Chapter ${numMatch[1]}`;
  }
  return cleaned || "Chapter";
}

function parseBrowseCards(apiPayload, page = 1) {
  let parsedPayload = apiPayload;
  if (typeof apiPayload === "string") {
    try {
      parsedPayload = JSON.parse(apiPayload);
    } catch (_) {
      parsedPayload = {};
    }
  }
  const html = parsedPayload?.results_html || (typeof apiPayload === "string" ? apiPayload : "");
  const $ = cheerio.load(html);
  const data = [];

  $("article.comic-card").each((_, element) => {
    const card = $(element);
    const anchor = card.find(".comic-card__title a, a[href*='/manga/']").first();
    const href = anchor.attr("href") || card.find("a[href*='/manga/']").attr("href");
    const slug = cleanSlug(href);
    const title = text(anchor.text(), text(card.find("img").attr("alt")));
    if (!slug || !title) return;

    const imgTag = card.find("img").first();
    const image = normalizeImage(imgTag.attr("data-src") || imgTag.attr("src"));
    const badge = text(card.find(".comic-card__badge, .badge").first().text(), "comic").toLowerCase();
    const rating = text(card.find(".comic-card__rating, .rating, .score").first().text(), "0");

    data.push({
      source: "mgeko",
      title,
      slug,
      image,
      detail_link: `${BASE}/manga/${slug}/`,
      description: text(card.find("p").first().text()),
      type_genre: badge,
      info: rating && rating !== "0" ? `Rating: ${rating}` : "Updated",
      chapter_awal: "",
      chapter_terbaru: "",
      chapters: [],
    });
  });

  const totalPages = Number(parsedPayload?.num_pages) || page;
  const totalResults = Number(parsedPayload?.total_results) || data.length;

  return {
    success: true,
    meta: {
      currentPage: page,
      totalPages,
      totalItems: totalResults,
      hasNextPage: page < totalPages,
    },
    data: unique(data, "slug"),
  };
}

function parseSearchCards(html, query, page = 1) {
  const $ = cheerio.load(html);
  const data = [];

  $("li.novel-item, .novel-item").each((_, element) => {
    const item = $(element);
    const anchor = item.is("a[href*='/manga/']") ? item : item.find("a[href*='/manga/']").first();
    const href = anchor.attr("href") || item.find("a[href*='/manga/']").attr("href");
    const slug = cleanSlug(href);
    const title = text(
      anchor.attr("title"),
      text(item.find(".novel-title, h4").first().text(), text(item.find("img").attr("alt")))
    );
    if (!slug || !title) return;

    const imgTag = item.find("img").first();
    const image = normalizeImage(imgTag.attr("data-src") || imgTag.attr("src"));
    const rawChapter = text(
      item.find(".novel-stats strong, strong:contains('Chapter'), a[href*='chapter'], .chapter").first().text()
    );
    const chapterMatch = rawChapter.match(/(?:Chapters?|Ch\.)?\s*([\d.]+)/i);
    const update = chapterMatch ? `Chapter ${chapterMatch[1]}` : rawChapter || "";

    data.push({
      title,
      image,
      detail_link: `${BASE}/manga/${slug}/`,
      type_genre: "comic",
      update,
      rating: "0",
      slug,
    });
  });

  const nextExists = $("a[href*='page='], .pagination a").filter((_, el) => {
    const p = $(el).attr("href")?.match(/page=(\d+)/);
    return p && Number(p[1]) > page;
  }).length > 0;

  return {
    success: true,
    query,
    meta: {
      currentPage: page,
      totalPages: nextExists ? page + 1 : page,
      hasNextPage: nextExists || data.length >= PER_PAGE,
    },
    data: unique(data, "slug"),
  };
}

function parseChapterItem($, element, seriesSlug) {
  const node = $(element);
  const href = node.attr("href") || "";
  const slug = cleanChapterSlug(href);
  if (!slug) return null;

  const rawText = text(node.text());
  const title = formatChapterTitle(rawText, slug);
  const timeMatch = rawText.match(/\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)(?:,\s*\d+\s+[a-zA-Z]+)?(?:\s+ago)?/i);
  const date = timeMatch ? (timeMatch[0].toLowerCase().includes("ago") ? timeMatch[0] : `${timeMatch[0]} ago`) : "";

  return {
    title,
    slug,
    link: `chapter/${seriesSlug}/${slug}`,
    date,
    time: date,
    locked: false,
  };
}

function parseDetail(detailHtml, allChaptersHtml, slug) {
  const $ = cheerio.load(detailHtml);
  const rawTitle = text(
    $("h1, .novel-title, meta[property='og:title']").first().text(),
    text($("meta[property='og:title']").attr("content"))
  );
  const title = rawTitle
    .replace(/^\[Manga\]:\s*Manga\s*/i, "")
    .replace(/\s*Read$/i, "")
    .trim();

  if (!title) throw new Error("Struktur detail Mgeko tidak dikenali");

  const imgTag = $(".novel-cover img, .poster img, .cover img, img.lazy").first();
  const thumbnail = normalizeImage(imgTag.attr("data-src") || imgTag.attr("src"));

  let status = "Unknown";
  let author = "-";
  $("body").find("span, div, li, p").each((_, el) => {
    const t = text($(el).text());
    if (/Status/i.test(t) && /Ongoing|Completed|Hiatus/i.test(t)) {
      const match = t.match(/(Ongoing|Completed|Hiatus)/i);
      if (match) status = match[1];
    }
    if (/Author:/i.test(t)) {
      const a = t.replace(/^.*Author:\s*/i, "").trim();
      if (a && a.length < 60) author = a;
    }
  });

  const genres = $(".genres a, .genre a, .categories a, a[href*='/genre/'], a[href*='/genres/']")
    .map((_, e) => text($(e).text()))
    .get()
    .filter((v, i, a) => v && a.indexOf(v) === i);

  const type = genres.find((g) => /manhwa|manhua|manga|comic|webtoon/i.test(g)) || "Manga";

  const synopsis = text(
    $(".description, .novel-desc, .summary, .content, #description").first().text(),
    text($("meta[name='description']").attr("content"), "Tidak ada sinopsis.")
  );

  const viewsMatch = $("body").text().match(/([\d.,]+\s*[KMB]?\s*Views)/i);
  const info = viewsMatch ? viewsMatch[1] : "";

  // Parse chapters from allChaptersHtml or detailHtml
  const $chSource = allChaptersHtml ? cheerio.load(allChaptersHtml) : $;
  const chapterNodes = $chSource("a[href*='/reader/en/']");
  const chapters = unique(
    chapterNodes
      .map((_, el) => parseChapterItem($chSource, el, slug))
      .get()
      .filter(Boolean),
    "slug"
  );

  return {
    success: true,
    data: {
      title,
      thumbnail,
      type,
      status,
      Pengarang: author,
      Umur: "-",
      Konsep: "-",
      artist: "-",
      genres,
      synopsis,
      info,
      total_chapter: chapters.length,
      chapters,
    },
  };
}

function parseChapter(html, seriesSlug, chapterSlug) {
  const $ = cheerio.load(html);

  const images = unique(
    $("img")
      .map((_, el) => {
        const src = normalizeImage($(el).attr("data-src") || $(el).attr("data-original") || $(el).attr("src"));
        return { url: src };
      })
      .get()
      .filter(
        (item) =>
          item.url &&
          !/logo|icon|avatar|placeholder|loading/i.test(item.url) &&
          (/\.(?:jpe?g|webp|png|avif)/i.test(item.url) || item.url.includes("/comic/"))
      ),
    "url"
  ).map((item) => item.url);

  if (!images.length) throw new Error("Gambar chapter Mgeko tidak ditemukan");

  const heading = text($("h1, .chapter-title, title").first().text());
  const numMatch = heading.match(/Chapter\s*[-–—:]*\s*([\d.]+)/i) || chapterSlug.match(/chapter-([\d.]+)/i);
  const currentChapter = numMatch ? `Chapter ${numMatch[1]}` : chapterSlug;

  let prev = null;
  let next = null;

  $("a").each((_, el) => {
    const linkText = text($(el).text());
    const href = $(el).attr("href") || "";
    if (/Prev/i.test(linkText) && href.includes("/reader/en/")) {
      const s = cleanChapterSlug(href);
      if (s && !prev) prev = s;
    }
    if (/Next/i.test(linkText) && href.includes("/reader/en/")) {
      const s = cleanChapterSlug(href);
      if (s && !next) next = s;
    }
  });

  return {
    success: true,
    mangaId: seriesSlug,
    chapterSlug,
    currentChapter,
    prev,
    next,
    back_to_detail: seriesSlug,
    totalImages: images.length,
    images,
  };
}

async function scrapePustaka(page = 1, sort = "latest") {
  const sortMap = {
    latest: "latest",
    update: "latest",
    recently_added: "recently_added",
    popular: "popular_all_time",
    popular_all_time: "popular_all_time",
    popular_weekly: "popular_weekly",
    popular_monthly: "popular_monthly",
    popular_daily: "popular_daily",
    top_rated: "top_rated",
    rating: "top_rated",
    title_az: "title_az",
    title_za: "title_za",
  };

  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("sort", sortMap[sort] || "latest");

  const data = await mgekoFetch(`/browse-comics/data/?${params}`, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
    },
    referer: `${BASE}/browse-comics/`,
  });

  const result = parseBrowseCards(data, page);
  if (!result.data.length) throw new Error("Data komik Mgeko kosong");
  return result;
}

async function scrapeSearch(query, page = 1) {
  const params = new URLSearchParams({ search: query });
  if (page > 1) params.set("page", String(page));

  const html = await mgekoFetch(`/search/?${params}`, {
    referer: `${BASE}/`,
  });
  return parseSearchCards(html, query, page);
}

async function scrapeDetail(slug) {
  const detailHtml = await mgekoFetch(`/manga/${encodeURIComponent(slug)}/`);
  let allChaptersHtml = null;

  if (detailHtml.includes("/all-chapters/")) {
    try {
      allChaptersHtml = await mgekoFetch(
        `/manga/${encodeURIComponent(slug)}/all-chapters/`,
        { referer: `${BASE}/manga/${encodeURIComponent(slug)}/` }
      );
    } catch (_) {
      allChaptersHtml = null;
    }
  }

  return parseDetail(detailHtml, allChaptersHtml, slug);
}

async function scrapeChapter(seriesSlug, chapterSlug) {
  const html = await mgekoFetch(`/reader/en/${encodeURIComponent(chapterSlug)}/`, {
    referer: `${BASE}/manga/${encodeURIComponent(seriesSlug)}/`,
  });
  return parseChapter(html, seriesSlug, chapterSlug);
}

module.exports = function registerMgeko(app, { getCache, setCache, coalescedScrape, getImageCache, setImageCache }) {
  app.get("/mgeko/image", async (req, res) => {
    if (!req.query.url) return res.status(400).send("No URL provided");
    try {
      const imageUrl = normalizeImage(req.query.url);
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" || !isAllowedImageHost(parsed.hostname)) {
        return res.status(400).send("URL gambar Mgeko tidak valid");
      }
      const cached = getImageCache(imageUrl || url);
      if (cached) {
        return res.set('Content-Type', cached.contentType).set('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800').send(cached.buffer);
      }
      const response = await axios.get(imageUrl, {
        headers: headers(BASE),
        responseType: "stream",
        timeout: 25000,
      });
      res.set({
        "Content-Type": response.headers["content-type"] || "image/jpeg",
        ...(response.headers["content-length"]
          ? { "Content-Length": response.headers["content-length"] }
          : {}),
        "Cache-Control": "public, max-age=31536000",
      });
      const chunks = [];
      response.data.on('data', c => chunks.push(c));
      response.data.on('end', () => {
        const buf = Buffer.concat(chunks);
        setImageCache(imageUrl || url, buf, response.headers['content-type'] || 'image/jpeg');
        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800');
        res.send(buf);
      });
    } catch (error) {
      console.error(`[Mgeko Proxy Error] ${error.message}`);
      res.status(error.response?.status || 502).send("Gagal mengambil gambar Mgeko");
    }
  });

  app.get("/mgeko/pustaka", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const sort = text(req.query.sort, "latest").toLowerCase();
    const key = `mgeko:pustaka:${sort}:${page}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapePustaka(page, sort));
      const response = {
        success: true,
        source: "mgeko.cc",
        page,
        total: result.data.length,
        meta: result.meta,
        data: rewriteImages(result.data, req),
      };
      setCache(key, response, 120);
      res.json(response);
    } catch (error) {
      console.error(`[Mgeko Pustaka Error] ${error.message}`);
      res.status(502).json({ success: false, page, total: 0, data: [], message: error.message });
    }
  });

  app.get("/mgeko/search", async (req, res) => {
    const query = text(req.query.q);
    const page = parsePage(req.query.page || "1");
    if (!query) return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const key = `mgeko:search:${query.toLowerCase()}:${page}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapeSearch(query, page));
      result.data = rewriteImages(result.data, req);
      setCache(key, result, 300);
      res.json(result);
    } catch (error) {
      console.error(`[Mgeko Search Error] ${error.message}`);
      res.status(502).json({ success: false, query, data: [], message: error.message });
    }
  });

  app.get("/mgeko/detail/:slug", async (req, res) => {
    const slug = cleanSlug(req.params.slug);
    if (!slug) return res.status(400).json({ success: false, message: "Slug tidak diberikan" });
    const key = `mgeko:detail:${slug}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapeDetail(slug));
      const response = rewriteImages(result, req);
      setCache(key, response, 900);
      res.json(response);
    } catch (error) {
      console.error(`[Mgeko Detail Error] ${slug}: ${error.message}`);
      res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message });
    }
  });

  app.get("/mgeko/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const seriesSlug = cleanSlug(req.params.seriesSlug);
    const chapterSlug = cleanChapterSlug(req.params.chapterSlug);
    if (!seriesSlug || !chapterSlug) {
      return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap" });
    }
    const key = `mgeko:chapter:${seriesSlug}:${chapterSlug}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = rewriteImages(
        await coalescedScrape(key, () => scrapeChapter(seriesSlug, chapterSlug)),
        req
      );
      setCache(key, result, 7200);
      res.json(result);
    } catch (error) {
      console.error(`[Mgeko Chapter Error] ${seriesSlug}/${chapterSlug}: ${error.message}`);
      res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message });
    }
  });

  console.log(
    "Mgeko routes registered: /mgeko/pustaka, /mgeko/search, /mgeko/detail/:slug, /mgeko/chapter/:seriesSlug/:chapterSlug, /mgeko/image"
  );
};

module.exports._test = {
  parseBrowseCards,
  parseSearchCards,
  parseDetail,
  parseChapter,
  normalizeImage,
  parsePage,
  scrapePustaka,
  scrapeSearch,
  scrapeDetail,
  scrapeChapter,
  cleanSlug,
  cleanChapterSlug,
  formatChapterTitle,
  isAllowedImageHost,
};
