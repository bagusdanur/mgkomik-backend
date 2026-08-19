"use strict";

const axios = require("axios");
const cheerio = require("cheerio");

const EVA_BASE = "https://evascans.org";
const EVA_IMAGE_HOSTS = new Set([
  "evascans.org",
  "www.evascans.org",
  "i0.wp.com",
  "i1.wp.com",
  "i2.wp.com",
  "i3.wp.com",
]);

function headers(referer = `${EVA_BASE}/`) {
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: referer,
    "User-Agent":
      process.env.EVASCAN_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  };
}

async function evaFetch(path, options = {}) {
  const url = path.startsWith("http")
    ? path
    : `${EVA_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const response = await axios.get(url, {
    headers: headers(options.referer),
    timeout: options.timeout || 25000,
    responseType: options.responseType || "text",
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Eva Scans upstream HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.data;
}

function text(value, fallback = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim() || fallback;
}

function slugFromHref(value = "") {
  try {
    return new URL(value, EVA_BASE).pathname.replace(/^\/series\//, "").replace(/^\/+|\/+$/g, "");
  } catch (_) {
    return text(value).replace(/^\/series\//, "").replace(/^\/+|\/+$/g, "");
  }
}

function chapterSlugFromHref(value = "") {
  try {
    return new URL(value, EVA_BASE).pathname.replace(/^\/+|\/+$/g, "");
  } catch (_) {
    return text(value).split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  }
}

function normalizeImage(value = "") {
  const src = text(value).replace(/&amp;/g, "&");
  if (!src || /^data:|^blob:/i.test(src)) return "";
  if (/^\/\//.test(src)) return `https:${src}`;
  if (/^https?:\/\//i.test(src)) return src.replace(/^http:/i, "https:");
  return `${EVA_BASE}/${src.replace(/^\/+/, "")}`;
}

function requestBase(req) {
  const forwarded = req.headers["x-forwarded-proto"];
  const protocol = String(forwarded || req.protocol || "http").split(",")[0].trim();
  return `${protocol}://${req.get("host")}`;
}

function proxyImage(value, req) {
  const url = normalizeImage(value);
  return url
    ? `${requestBase(req)}/evascan/image?url=${encodeURIComponent(url)}`
    : "";
}

function rewriteImages(payload, req) {
  if (Array.isArray(payload)) return payload.map((item) => rewriteImages(item, req));
  if (!payload || typeof payload !== "object") return payload;
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "images" && Array.isArray(value)) {
      output[key] = value.map((image) => proxyImage(image, req)).filter(Boolean);
    } else if (["image", "thumbnail", "cover", "chapter_thumbnail"].includes(key) && typeof value === "string") {
      output[key] = proxyImage(value, req);
    } else if (value && typeof value === "object") {
      output[key] = rewriteImages(value, req);
    } else output[key] = value;
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

function parseChapterLink($, element, seriesSlug) {
  const node = $(element);
  const href = node.attr("href") || "";
  const slug = chapterSlugFromHref(href);
  const raw = text(node.find(".chapternum,.ch-num,.chapter-title").first().text(), text(node.text()));
  const chapterMatch = raw.match(/(?:Chapter|Ch\.)\s*[\d.]+/i);
  const title = chapterMatch
    ? chapterMatch[0].replace(/^Ch\.\s*/i, "Chapter ")
    : raw;
  const date = text(node.find(".chapterdate,.v-time,time").first().text());
  return {
    title,
    slug,
    link: slug ? `chapter/${seriesSlug}/${slug}` : "",
    date,
    time: date,
    locked: Boolean(node.find(".fa-lock,[class*='lock'],[class*='coin']").length),
  };
}

function parseCards(html, page = 1) {
  const $ = cheerio.load(html);
  const data = [];
  $(".manga-card-v").each((_, element) => {
    const card = $(element);
    let anchor = card.find(".card-v-title a").first();
    if (!anchor.length) anchor = card.find("a[href*='/series/']").first();
    const slug = slugFromHref(anchor.attr("href"));
    const title = text(anchor.text(), text(card.find("img").attr("alt")));
    if (!slug || !title) return;
    const chapters = unique(
      card.find(".v-ch-row a,a[href*='-chapter-']").map((__, link) => parseChapterLink($, link, slug)).get(),
      "slug"
    );
    const latest = chapters[0] || {};
    const oldest = chapters[chapters.length - 1] || {};
    data.push({
      source: "evascan",
      title,
      slug,
      image: normalizeImage(card.find("img").first().attr("data-src") || card.find("img").first().attr("src")),
      detail_link: `${EVA_BASE}/series/${slug}/`,
      description: "",
      type_genre: text(card.find(".v-type,.manga-type").first().text(), "comic").toLowerCase(),
      info: text(card.find(".v-status").first().text(), latest.time || "Updated"),
      chapter_awal: oldest.title || "",
      chapter_terbaru: latest.title || "",
      chapters,
    });
  });
  const pageNumbers = $(".page-numbers").map((_, e) => Number.parseInt($(e).text(), 10)).get().filter(Number.isFinite);
  const totalPages = Math.max(page, ...pageNumbers, page);
  return {
    success: true,
    meta: {
      currentPage: page,
      totalPages,
      totalItems: data.length,
      hasNextPage: Boolean($("a.next.page-numbers,a.page-numbers.next").length),
    },
    data: unique(data, "slug"),
  };
}

function parseDetail(html, slug) {
  const $ = cheerio.load(html);
  const title = text($("h1,.series-title-main").first().text());
  if (!title) throw new Error("Struktur detail Eva Scans tidak dikenali");
  const stats = {};
  $(".stat-v-box").each((_, element) => {
    const box = $(element);
    stats[text(box.find(".stat-v-label").text()).toLowerCase()] = text(box.find(".stat-v-value").text());
  });
  const chapters = unique(
    $(".chbox a.chlink,.chbox > a,a[href*='-chapter-']")
      .map((_, element) => parseChapterLink($, element, slug))
      .get(),
    "slug"
  ).filter((chapter) => chapter.slug.includes("-chapter-"));
  const synopsis = text(
    $(".series-synopsis-content,.synopsis-content,.series-synopsis,.entry-content").first().text(),
    text($("meta[name='description']").attr("content"))
  );
  const genres = $(".gen-tag,a[href*='genre']").map((_, e) => text($(e).text())).get().filter((v, i, a) => v && a.indexOf(v) === i);
  return {
    success: true,
    data: {
      title,
      thumbnail: normalizeImage($(".series-poster-premium img,.poster-box img,.wp-post-image").first().attr("src")),
      type: stats.type || "comic",
      status: stats.status || "Unknown",
      Pengarang: text($(".author-content,.series-author").first().text(), "-"),
      Umur: "-",
      Konsep: "-",
      artist: text($(".artist-content,.series-artist").first().text(), "-"),
      genres,
      synopsis: synopsis || "Tidak ada sinopsis.",
      info: stats.views || "",
      total_chapter: chapters.length,
      chapters,
    },
  };
}

function parseChapter(html, seriesSlug, chapterSlug) {
  const $ = cheerio.load(html);
  const images = unique(
    $(".legendary-page img,.page-wrapper img,.reader-content img")
      .map((_, element) => ({
        url: normalizeImage($(element).attr("data-src") || $(element).attr("data-lazy-src") || $(element).attr("src")),
      }))
      .get()
      .filter((item) => item.url && !/logo|avatar|placeholder/i.test(item.url)),
    "url"
  ).map((item) => item.url);
  if (!images.length) throw new Error("Gambar chapter Eva Scans tidak ditemukan");
  // The visible next button on EvaScan may point to a site-wide release.
  // Derive navigation only from the chapter menu of the current series.
  const seriesPrefix = `${seriesSlug}-chapter-`.toLowerCase();
  const chapterLinks = [...new Set(
    $(".dropdown-list a.dropdown-item,.chapter-grid a.ch-grid-item")
      .map((_, element) => chapterSlugFromHref($(element).attr("href")))
      .get()
      .filter((slug) => slug.toLowerCase().startsWith(seriesPrefix))
  )];
  const chapterNumber = (slug) => {
    const match = slug.match(/-chapter-([0-9]+(?:\.[0-9]+)?)(?:-|$)/i);
    return match ? Number(match[1]) : Number.NaN;
  };
  const currentNumber = chapterNumber(chapterSlug);
  const numbered = chapterLinks
    .map((slug) => ({ slug, number: chapterNumber(slug) }))
    .filter((item) => Number.isFinite(item.number));
  const prev = Number.isFinite(currentNumber)
    ? numbered.filter((item) => item.number < currentNumber).sort((a, b) => b.number - a.number)[0]?.slug || null
    : null;
  const next = Number.isFinite(currentNumber)
    ? numbered.filter((item) => item.number > currentNumber).sort((a, b) => a.number - b.number)[0]?.slug || null
    : null;
  const heading = text($("h1,.reader-title").first().text(), text($("title").text()));
  const match = heading.match(/Chapter\s+[\d.]+/i);
  return {
    success: true,
    mangaId: seriesSlug,
    chapterSlug,
    currentChapter: match ? match[0] : chapterSlug,
    prev,
    next,
    back_to_detail: seriesSlug,
    totalImages: images.length,
    images,
  };
}

async function scrapePustaka(page = 1, sort = "latest") {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (sort) params.set("order", sort === "latest" ? "update" : sort);
  const html = await evaFetch(`/series/${params.size ? `?${params}` : ""}`);
  const result = parseCards(html, page);
  if (!result.data.length) throw new Error("Data komik Eva Scans kosong");
  return result;
}

async function scrapeSearch(query, page = 1) {
  const params = new URLSearchParams({ s: query });
  if (page > 1) params.set("paged", String(page));
  const parsed = parseCards(await evaFetch(`/?${params}`), page);
  return { success: true, query, meta: parsed.meta, data: parsed.data.map((item) => ({
    title: item.title,
    image: item.image,
    detail_link: item.detail_link,
    type_genre: item.type_genre,
    update: item.chapter_terbaru,
    rating: "0",
    slug: item.slug,
  })) };
}

async function scrapeDetail(slug) {
  return parseDetail(await evaFetch(`/series/${encodeURIComponent(slug)}/`), slug);
}

async function scrapeChapter(seriesSlug, chapterSlug) {
  return parseChapter(
    await evaFetch(`/${encodeURIComponent(chapterSlug)}/`, { referer: `${EVA_BASE}/series/${seriesSlug}/` }),
    seriesSlug,
    chapterSlug
  );
}

module.exports = function registerEvaScan(app, { getCache, setCache, coalescedScrape, getImageCache, setImageCache }) {
  app.get("/evascan/image", async (req, res) => {
    if (!req.query.url) return res.status(400).send("No URL provided");
    try {
      const imageUrl = normalizeImage(req.query.url);
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" || !EVA_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
        return res.status(400).send("URL gambar Eva Scans tidak valid");
      }
      const cached = getImageCache(imageUrl);
      if (cached) {
        return res.set("Content-Type", cached.contentType).set("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800").send(cached.buffer);
      }
      const response = await axios.get(imageUrl, { headers: headers(EVA_BASE), responseType: "stream", timeout: 25000 });
      const chunks = [];
      response.data.on("data", (c) => chunks.push(c));
      response.data.on("end", () => {
        const buf = Buffer.concat(chunks);
        setImageCache(imageUrl, buf, response.headers["content-type"] || "image/jpeg");
        res.set("Content-Type", response.headers["content-type"] || "image/jpeg");
        res.set("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800");
        res.send(buf);
      });
    } catch (error) {
      console.error(`[EvaScan Proxy Error] ${error.message}`);
      res.status(error.response?.status || 502).send("Gagal mengambil gambar Eva Scans");
    }
  });

  app.get("/evascan/pustaka", async (req, res) => {
    const page = parsePage(req.query.page || "1");
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const sort = text(req.query.sort, "latest").toLowerCase();
    const key = `evascan:pustaka:${sort}:${page}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapePustaka(page, sort));
      const response = { success: true, source: "evascans.org", page, total: result.data.length, meta: result.meta, data: rewriteImages(result.data, req) };
      setCache(key, response, 120);
      res.json(response);
    } catch (error) {
      console.error(`[EvaScan Pustaka Error] ${error.message}`);
      res.status(502).json({ success: false, page, total: 0, data: [], message: error.message });
    }
  });

  app.get("/evascan/search", async (req, res) => {
    const query = text(req.query.q);
    const page = parsePage(req.query.page || "1");
    if (!query) return res.status(400).json({ success: false, message: "Masukkan parameter ?q=" });
    if (!page) return res.status(400).json({ success: false, message: "Page tidak valid" });
    const key = `evascan:search:${query.toLowerCase()}:${page}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapeSearch(query, page));
      result.data = rewriteImages(result.data, req);
      setCache(key, result, 300);
      res.json(result);
    } catch (error) {
      console.error(`[EvaScan Search Error] ${error.message}`);
      res.status(502).json({ success: false, query, data: [], message: error.message });
    }
  });

  app.get("/evascan/detail/:slug", async (req, res) => {
    const slug = slugFromHref(req.params.slug);
    if (!slug) return res.status(400).json({ success: false, message: "Slug tidak diberikan" });
    const key = `evascan:detail:${slug}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = await coalescedScrape(key, () => scrapeDetail(slug));
      const response = rewriteImages(result, req);
      setCache(key, response, 900);
      res.json(response);
    } catch (error) {
      console.error(`[EvaScan Detail Error] ${slug}: ${error.message}`);
      res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message });
    }
  });

  app.get("/evascan/chapter/:seriesSlug/:chapterSlug", async (req, res) => {
    const seriesSlug = slugFromHref(req.params.seriesSlug);
    const chapterSlug = chapterSlugFromHref(req.params.chapterSlug);
    if (!seriesSlug || !chapterSlug) return res.status(400).json({ success: false, message: "Slug chapter tidak lengkap" });
    const key = `evascan:chapter:${seriesSlug}:${chapterSlug}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);
    try {
      const result = rewriteImages(await coalescedScrape(key, () => scrapeChapter(seriesSlug, chapterSlug)), req);
      setCache(key, result, 7200);
      res.json(result);
    } catch (error) {
      console.error(`[EvaScan Chapter Error] ${seriesSlug}/${chapterSlug}: ${error.message}`);
      res.status(error.status === 404 ? 404 : 502).json({ success: false, message: error.message });
    }
  });

  console.log("EvaScan routes registered: /evascan/pustaka, /evascan/search, /evascan/detail/:slug, /evascan/chapter/:seriesSlug/:chapterSlug, /evascan/image");
};

module.exports._test = { parseCards, parseDetail, parseChapter, normalizeImage, parsePage, scrapePustaka, scrapeSearch, scrapeDetail, scrapeChapter };
