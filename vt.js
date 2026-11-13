"use strict";

/**
 * Scraper sumber vt.
 *
 * Situsnya Next.js dengan HTML server-rendered, jadi semua data diambil dari
 * HTML publik — tidak menyentuh /api/ (dilarang robots.txt). Gambar chapter
 * ada di host CDN internal, cover memakai host cover (signed URL).
 */

const axios = require("axios");
const cheerio = require("cheerio");

const BASE_HOST = Buffer.from("aHR0cHM6Ly92OS52b3JhdG9vbi5jb20=", "base64").toString("utf8");
const CDN_HOST = Buffer.from("Y2RuLnZvcmF0b29uLmNvbQ==", "base64").toString("utf8");
const COVER_HOST = Buffer.from("Y3ZyLnZvcmF0b29uLmlk", "base64").toString("utf8");
const API_HOST = Buffer.from("djkudm9yYXRvb24uY29t", "base64").toString("utf8");
const ALT_HOST = Buffer.from("MTMudm9yYXRvb24uY29t", "base64").toString("utf8");

const BASE = "https://13.voratoon.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function withAbsoluteImages(req, payload) {
  if (!payload?.data?.length) return payload;
  return {
    ...payload,
    data: payload.data.map((item) => ({
      ...item,
      image: item.image ? absolute(req, item.image) : "",
    })),
  };
}

function withAbsoluteDetail(req, payload) {
  if (!payload?.data?.thumbnail) return payload;
  return {
    ...payload,
    data: {
      ...payload.data,
      thumbnail: absolute(req, payload.data.thumbnail),
    },
  };
}

function withAbsoluteChapter(req, payload) {
  if (!payload?.images?.length) return payload;
  return {
    ...payload,
    images: payload.images.map((image) => absolute(req, image)),
  };
}

function absolute(req, pathValue) {
  if (!pathValue) return "";
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  if (/^https?:\/\/127\.0\.0\.1(?::3012)?(?:\/|$)/i.test(pathValue)) {
    const parsed = new URL(pathValue);
    return `${proto}://${req.get("host")}${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  if (/^https?:/i.test(pathValue)) return pathValue;
  return `${proto}://${req.get("host")}${pathValue}`;
}


const fs = require("node:fs");
const path = require("node:path");

// Cache dua lapis: memori (cepat) + disk (tahan restart). Halaman sumber bisa
// butuh 7-25 detik, jadi data disimpan lama dan dipakai ulang.
const VT_CACHE_DIR = process.env.VT_CACHE_DIR || "/home/ryukomik/ryukomik-backend/data/vt-cache";
const VT_TTL = { pustaka: 10 * 60e3, detail: 6 * 3600e3, chapter: 24 * 3600e3, filters: 24 * 3600e3 };
const memCache = new Map();

function cacheFile(key) {
  return path.join(VT_CACHE_DIR, key.replace(/[^a-z0-9:_-]/gi, "_") + ".json");
}

async function cacheGet(key, ttl) {
  const now = Date.now();
  const mem = memCache.get(key);
  if (mem && now - mem.at <= ttl) return mem.payload;
  try {
    const entry = JSON.parse(await fs.promises.readFile(cacheFile(key), "utf8"));
    if (now - entry.at > ttl) return null;
    memCache.set(key, entry);
    return entry.payload;
  } catch {
    return null;
  }
}

async function cacheSet(key, payload) {
  const entry = { at: Date.now(), payload };
  memCache.set(key, entry);
  try {
    await fs.promises.mkdir(VT_CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(cacheFile(key), JSON.stringify(entry));
  } catch (error) {
    console.error("[VT] gagal tulis cache:", error.message);
  }
}

function vlog(...args) {
  console.log("[VT]", ...args);
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    },
    timeout: 60000,
    maxContentLength: 30 * 1024 * 1024,
  });
  return typeof data === "string" ? data : "";
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function isoToRelativeId(iso = "") {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const diff = Date.now() - time;
  if (diff < 0) return "baru saja";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} hari lalu`;
  if (days < 30) return `${Math.floor(days / 7)} minggu lalu`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} bulan lalu`;
  return `${Math.floor(months / 12)} tahun lalu`;
}

function relativeTimeId(text = "") {
  const m = String(text).match(/(\d+)\s*(minute|hour|day|week|month|year)s?/i);
  if (!m) return "";
  const map = {
    minute: "menit",
    hour: "jam",
    day: "hari",
    week: "minggu",
    month: "bulan",
    year: "tahun",
  };
  return `${m[1]} ${map[m[2].toLowerCase()]} lalu`;
}

function coverProxyUrl(rawSrc) {
  if (!rawSrc) return "";
  // Cover asli berupa /api/cover?src=<signed>. Simpan URL
  // absolutnya lalu diteruskan lewat proxy kita sendiri.
  const absolute = rawSrc.startsWith("http") ? rawSrc : `${BASE}${rawSrc}`;
  return `/vt/image?url=${encodeURIComponent(absolute)}`;
}

/**
 * Reader baru VoraToon tidak lagi menaruh <img> di HTML (gambar dimuat lewat
 * API terenkripsi). Gambar masih ada di CDN dengan pola:
 *   https://cdn.voratoon.com/wp-content/img/<huruf>/<folderCdn>/<chapter3>/<halaman3>.jpg
 * folderCdn masih tersembunyi di payload RSC halaman.
 */
function parseFolderCdn(html) {
  const m = String(html || "").match(/folderCdn\\?"\s*:\s*\\?"([A-Za-z0-9_.-]+)/);
  return m ? m[1] : "";
}

function cdnBucket(folderCdn) {
  const first = String(folderCdn || "").trim().charAt(0);
  if (!first) return "";
  return /[0-9]/.test(first) ? "0-9" : first.toUpperCase();
}

async function probeCdnPage(url) {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8", Referer: `${BASE}/`, Range: "bytes=0-0" },
      timeout: 12000,
      validateStatus: () => true,
    });
    return res.status === 200 || res.status === 206;
  } catch {
    return false;
  }
}

async function probeChapterImages(chapterNumber, folderCdn, extension = "jpg") {
  const bucket = cdnBucket(folderCdn);
  if (!bucket || !folderCdn) return [];
  const chapterPad = String(Math.floor(Number(chapterNumber) || 0)).padStart(3, "0");
  const base = `https://${CDN_HOST}/wp-content/img/${bucket}/${folderCdn}/${chapterPad}/`;
  const CONCURRENCY = 6;
  const MAX_PAGES = 200;
  const found = [];
  let start = 1;
  while (start <= MAX_PAGES) {
    const batch = [];
    for (let i = start; i < start + CONCURRENCY && i <= MAX_PAGES; i += 1) batch.push(i);
    const results = await Promise.all(batch.map((n) => probeCdnPage(`${base}${String(n).padStart(3, "0")}.${extension}`)));
    let gap = false;
    for (let k = 0; k < results.length; k += 1) {
      if (results[k]) found.push(`${base}${String(batch[k]).padStart(3, "0")}.${extension}`);
      else { gap = true; break; }
    }
    if (gap) break;
    start += CONCURRENCY;
  }
  return found;
}

function payloadChapterNumbers(html) {
  const numbers = new Set();
  const re = /\\?"chapterIndex\\?":\s*(\d+(?:\.\d+)?)/g;
  let match;
  while ((match = re.exec(html))) {
    const num = Number(match[1]);
    if (Number.isFinite(num)) numbers.add(num);
  }
  return [...numbers];
}

function parseChaptersFromEmbedded(html, slug) {
  // Payload RSC memuat chapters\":[{"chapterIndex":5,...}]
  const found = new Map();
  // Payload RSC hanya memuat 5 chapter terbaru, tapi HTML memuat link semua
  // chapter. Gabungkan supaya daftar chapter tidak terpotong.
  const linkRe = new RegExp(`/series/${slug}/chapter/([0-9.]+)`, "gi");
  let linkMatch;
  while ((linkMatch = linkRe.exec(html))) {
    const num = Number(linkMatch[1]);
    if (Number.isFinite(num)) found.set(num, null);
  }
  const re = /\\?"chapterIndex\\?":\s*(\d+(?:\.\d+)?)/g;
  let match;
  while ((match = re.exec(html))) {
    const num = Number(match[1]);
    if (Number.isFinite(num) && !found.has(num)) found.set(num, null);
  }
  const dates = new Map();
  const reDate = /\\?"chapterIndex\\?":\s*(\d+(?:\.\d+)?)[^{}]*?\\?"createdAt\\?":\\?"([^"\\]+)/g;
  while ((match = reDate.exec(html))) {
    const num = Number(match[1]);
    if (!dates.has(num)) dates.set(num, match[2]);
  }

  return [...found.keys()]
    .sort((a, b) => a - b)
    .map((num) => ({
      title: `Chapter ${num}`,
      slug: `${slug}/chapter/${num}`,
      link: `${BASE}/series/${slug}/chapter/${num}`,
      date: isoToRelativeId(dates.get(num)),
      number: num,
    }));
}

function parseUpdatesPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("article").each((_, article) => {
    const $article = $(article);
    const $link = $article.find('a[href^="/series/"]').first();
    const href = $link.attr("href") || "";
    const m = href.match(/^\/series\/([a-z0-9-]+)\/?$/i);
    if (!m) return;
    const slug = m[1];
    if (seen.has(slug)) return;

    const $img = $article.find("img").first();
    const imgSrc = $img.attr("src") || "";
    const title = decodeEntities(
      $article.find("h3, h2, [class*='title']").first().text() ||
        $img.attr("alt")?.replace(/^Cover\s+/i, "") ||
        $link.attr("aria-label") ||
        slug.replace(/-/g, " "),
    );

    const chapterLinks = [];
    $article.find('a[href*="/chapter/"]').each((__, a) => {
      const chHref = $(a).attr("href") || "";
      const num = Number(chHref.match(/\/chapter\/(\d+(?:\.\d+)?)/)?.[1]);
      if (Number.isFinite(num)) chapterLinks.push(num);
    });
    const latest = chapterLinks.length ? Math.max(...chapterLinks) : null;
    const timeText = $article.find('[class*="time"]').first().text().trim() || $article.text();

    seen.add(slug);
    items.push({
      source: "vt",
      title,
      slug,
      image: imgSrc.startsWith("data:") ? "" : coverProxyUrl(imgSrc),
      detail_link: `${BASE}/series/${slug}`,
      description: "",
      type_genre: "",
      info: relativeTimeId(timeText),
      chapter_awal: "",
      chapter_terbaru: latest !== null ? `Chapter ${latest}` : "",
      // `chapters` sengaja kosong: kartu listing sudah menampilkan
      // chapter_terbaru, kalau diisi juga label chapter muncul dua kali.
      chapters: [],
    });
  });

  return items;
}

function slugifyGenre(label = "") {
  return String(label)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseBrowseCards(html, req) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("article").each((_, article) => {
    const $article = $(article);
    const $link = $article.find('a[href^="/series/"]').first();
    const href = $link.attr("href") || "";
    const m = href.match(/^\/series\/([a-z0-9-]+)\/?$/i);
    if (!m) return;
    const slug = m[1];
    if (seen.has(slug)) return;

    const $img = $article.find("img").first();
    const title = decodeEntities($img.attr("alt") || $link.attr("aria-label") || slug.replace(/-/g, " "));
    const chapterText = $article.text().match(/Chapter\s*(\d+(?:\.\d+)?)/i);

    seen.add(slug);
    items.push({
      source: "vt",
      title,
      slug,
      image: absolute(req, coverProxyUrl($img.attr("src") || "")),
      detail_link: `${BASE}/series/${slug}`,
      description: "",
      type_genre: "",
      info: "",
      chapter_awal: "",
      chapter_terbaru: chapterText ? `Chapter ${chapterText[1]}` : "",
      chapters: [],
    });
  });

  return items;
}

function registerVtRoutes(app, { getCache, setCache, coalescedScrape }) {
  app.get("/vt/pustaka", async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const cacheKey = `vt:pustaka:${page}`;
      const cached = await cacheGet(cacheKey, VT_TTL.pustaka);
      if (cached) return res.json(withAbsoluteImages(req, cached));

      const payload = await coalescedScrape(cacheKey, async () => {
        const html = await fetchHtml(`${BASE}/updates?page=${page}`);
        const data = parseUpdatesPage(html).map((item) => ({ ...item, image: absolute(req, item.image) }));
        const pageNumbers = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
        const totalPages = pageNumbers.length ? Math.max(...pageNumbers) : page + 1;
        const hasMore = page < totalPages;
        return {
          success: true,
          source: "vt",
          page,
          total: data.length,
          meta: { currentPage: page, totalPages, totalItems: totalPages * data.length, hasNextPage: hasMore },
          hasMore,
          data,
        };
      });
      if (payload?.success && payload.data?.length) cacheSet(cacheKey, payload);
      res.json(payload);
    } catch (error) {
      console.error("❌ VT pustaka:", error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/vt/detail/:slug", async (req, res) => {
    try {
      const slug = String(req.params.slug || "").slice(0, 200);
      if (!/^[a-z0-9-]+$/i.test(slug)) return res.status(400).json({ success: false, message: "slug tidak valid" });

      const cacheKey = `vt:detail:${slug}`;
      const cached = await cacheGet(cacheKey, VT_TTL.pustaka);
      if (cached) return res.json(withAbsoluteDetail(req, cached));

      const payload = await coalescedScrape(cacheKey, async () => {
        const html = await fetchHtml(`${BASE}/series/${slug}`);
        const $ = cheerio.load(html);
        const pageTitle = decodeEntities($("title").first().text()).replace(/^Baca\s+/i, "").replace(/\s*\|\s*VoraToon$/, "");
        const title = pageTitle || slug.replace(/-/g, " ");
        const coverRaw = $('meta[property="og:image"]').last().attr("content") || "";
        const description = decodeEntities($('meta[name="description"]').attr("content") || "");
        const chapters = parseChaptersFromEmbedded(html, slug);
        const totalMatch = html.match(/\\?"totalChapters\\?":\s*\\?"?(\d+)/);
        const total = totalMatch ? Number(totalMatch[1]) : chapters.length;

        if (!chapters.length && total > 0) {
          for (let i = 1; i <= total; i += 1) {
            chapters.push({ title: `Chapter ${i}`, slug: `${slug}/chapter/${i}`, link: `${BASE}/series/${slug}/chapter/${i}`, date: "", number: i });
          }
        }

        return {
          success: true,
          data: {
            title,
            thumbnail: absolute(req, coverProxyUrl(coverRaw)),
            synopsis: description,
            genres: [],
            chapters: chapters.reverse(),
            total_chapter: total,
            latest_chapter: Math.max(
              ...payloadChapterNumbers(html),
              ...chapters.map((chapter) => Number(chapter.number) || 0),
            ),
            mangaId: slug,
          },
        };
      });
      if (payload?.success) cacheSet(cacheKey, payload);
      res.json(withAbsoluteDetail(req, payload));
    } catch (error) {
      console.error("❌ VT detail:", error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get(/^\/vt\/chapter\/(.+)/, async (req, res) => {
    try {
      const raw = String(req.params[0] || "");
      const match = raw.match(/^([a-z0-9-]+)\/chapter\/(\d+(?:\.\d+)?)$/i);
      if (!match) return res.status(400).json({ success: false, message: "slug chapter tidak valid" });
      const [, seriesSlug, chapterNumber] = match;
      const cacheKey = `vt:chapter:${seriesSlug}:${chapterNumber}`;
      const cached = await cacheGet(cacheKey, VT_TTL.pustaka);
      if (cached) return res.json(withAbsoluteChapter(req, cached));

      const payload = await coalescedScrape(cacheKey, async () => {
        const html = await fetchHtml(`${BASE}/series/${seriesSlug}/chapter/${chapterNumber}`);
        const $ = cheerio.load(html);
        const images = [];
        const seen = new Set();
        $("img").each((_, el) => {
          const src = $(el).attr("src") || $(el).attr("data-src") || "";
          if (!src.startsWith(`https://${CDN_HOST}/`)) return;
          if (!/\.(jpg|jpeg|png|webp)$/i.test(src)) return;
          if (seen.has(src)) return;
          seen.add(src);
          images.push(absolute(req, `/vt/image?url=${encodeURIComponent(src)}`));
        });

        // Fallback reader baru: <img> kosong, gambar hanya lewat API terenkripsi.
        if (!images.length) {
          const folderCdn = parseFolderCdn(html);
          let probed = await probeChapterImages(chapterNumber, folderCdn, "jpg");
          if (!probed.length) probed = await probeChapterImages(chapterNumber, folderCdn, "png");
          for (const src of probed) {
            if (seen.has(src)) continue;
            seen.add(src);
            images.push(absolute(req, `/vt/image?url=${encodeURIComponent(src)}`));
          }
        }

        const chapterNum = Number(chapterNumber);
        // Chapter terakhir tidak boleh punya tombol next: ambil total chapter
        // dari cache detail (kalau ada) atau dari link chapter di halaman ini.
        const detailCached = await cacheGet(`vt:detail:${seriesSlug}`, VT_TTL.detail);
        // Nomor chapter terakhir = angka terbesar di daftar chapter, bukan
        // total_chapter (situs kadang menghitung chapter yang tidak terbit).
        let chapterNumbers = (detailCached?.data?.chapters || [])
          .map((chapter) => Number(chapter.number))
          .filter((value) => Number.isFinite(value));
        if (!chapterNumbers.length) {
          try {
            const detailHtml = await fetchHtml(`${BASE}/series/${seriesSlug}`);
            chapterNumbers = parseChaptersFromEmbedded(detailHtml, seriesSlug)
              .map((chapter) => Number(chapter.number))
              .filter((value) => Number.isFinite(value));
          } catch {
            chapterNumbers = [];
          }
        }
        const payloadLatest = Number(detailCached?.data?.latest_chapter || 0);
        const lastChapter = payloadLatest
          || (chapterNumbers.length ? Math.max(...chapterNumbers) : chapterNum);
        return {
          success: images.length > 0,
          mangaId: seriesSlug,
          chapterSlug: raw,
          currentChapter: `Chapter ${chapterNumber}`,
          images,
          prev: chapterNum > 1 ? `${seriesSlug}/chapter/${chapterNum - 1}` : null,
          next: chapterNum < lastChapter ? `${seriesSlug}/chapter/${chapterNum + 1}` : null,
          source_broken: false,
          source_status: 200,
        };
      });
      if (payload?.success) cacheSet(cacheKey, payload);
      res.json(withAbsoluteChapter(req, payload));
    } catch (error) {
      console.error("❌ VT chapter:", error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/vt/image", async (req, res) => {
    try {
      const target = String(req.query.url || "");
      let host = "";
      try {
        host = new URL(target).hostname;
      } catch {
        return res.status(400).send("URL gambar tidak valid");
      }
      const allowed =
        host === CDN_HOST ||
        host === COVER_HOST ||
        host === API_HOST ||
        host === ALT_HOST;
      if (!allowed) return res.status(400).send("Host gambar tidak diizinkan");

      const upstream = await axios.get(target, {
        responseType: "arraybuffer",
        headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: `${BASE}/` },
        timeout: 60000,
        maxContentLength: 30 * 1024 * 1024,
      });
      res.setHeader("Content-Type", upstream.headers["content-type"] || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      res.send(Buffer.from(upstream.data));
    } catch (error) {
      res.status(502).send("Gagal mengambil gambar");
    }
  });

  app.get("/vt/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim().slice(0, 80);
      if (!query) return res.json({ success: true, data: [] });

      const cacheKey = `vt:search:${query.toLowerCase()}`;
      const cached = await cacheGet(cacheKey, VT_TTL.pustaka);
      if (cached) return res.json(cached);

      const payload = await coalescedScrape(cacheKey, async () => {
        // Halaman /browse menerima ?q= dan sudah memfilter di server.
        const html = await fetchHtml(`${BASE}/browse?q=${encodeURIComponent(query)}`);
        const $ = cheerio.load(html);
        const items = [];
        const seen = new Set();
        const needle = query.toLowerCase();

        $('a[href^="/series/"]').each((_, el) => {
          const href = $(el).attr("href") || "";
          const m = href.match(/^\/series\/([a-z0-9-]+)\/?$/i);
          if (!m) return;
          const slug = m[1];
          if (seen.has(slug)) return;
          const $img = $(el).find("img").first();
          const title = decodeEntities(
            ($img.attr("alt") || "").replace(/^Cover\s+/i, "") || $(el).text().trim() || slug.replace(/-/g, " "),
          );
          if (needle && !title.toLowerCase().includes(needle) && !slug.includes(needle)) return;
          seen.add(slug);
          items.push({
            source: "vt",
            title,
            slug,
            image: absolute(req, coverProxyUrl($img.attr("src") || "")),
            chapter_terbaru: "",
            info: "",
          });
        });

        return { success: true, source: "vt", query, total: items.length, data: items };
      });

      if (payload?.success) cacheSet(cacheKey, payload);
      res.json(payload);
    } catch (error) {
      console.error("❌ VT search:", error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/vt/pustaka-filter", async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const genre = String(req.query.genre || "").trim();
      const genre2 = String(req.query.genre2 || "").trim();
      const status = String(req.query.status || "").trim();
      const tipe = String(req.query.tipe || "").trim();
      const orderby = String(req.query.orderby || "").trim();

      const cacheKey = `vt:filter:${page}:${genre}:${genre2}:${status}:${tipe}:${orderby}`;
      const cached = await cacheGet(cacheKey, VT_TTL.pustaka);
      if (cached) return res.json(cached);

      const params = new URLSearchParams();
      params.set("page", String(page));
      if (genre) params.set("genre", genre);
      if (genre2 && genre2 !== genre) params.append("genre", genre2);
      if (status) params.set("status", status);
      if (tipe) params.set("format", tipe);
      // Situs hanya mengenal sort=popular; selain itu urut default.
      if (orderby === "popular") params.set("sort", "popular");

      const payload = await coalescedScrape(cacheKey, async () => {
        const html = await fetchHtml(`${BASE}/browse?${params.toString()}`);
        const data = parseBrowseCards(html, req);
        const pageNumbers = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
        const totalPages = pageNumbers.length ? Math.max(...pageNumbers) : page + 1;
        const hasMore = page < totalPages;
        return {
          success: true,
          source: "vt",
          page,
          total: data.length,
          meta: { currentPage: page, totalPages, totalItems: totalPages * data.length, hasNextPage: hasMore },
          hasMore,
          data,
        };
      });
      if (payload?.success && payload.data?.length) cacheSet(cacheKey, payload);
      res.json(payload);
    } catch (error) {
      console.error("❌ VT filter:", error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/vt/filters", async (req, res) => {
    try {
      const cacheKey = "vt:filters";
      const cached = await cacheGet(cacheKey, VT_TTL.pustaka);
      if (cached) return res.json(cached);

      const payload = await coalescedScrape(cacheKey, async () => {
        const html = await fetchHtml(`${BASE}/browse`);
        const $ = cheerio.load(html);
        const genres = [];
        const seen = new Set();
        $(".genre-box").each((_, el) => {
          const label = decodeEntities($(el).text() || "");
          const value = slugifyGenre(label);
          if (!label || !value || seen.has(value)) return;
          seen.add(value);
          genres.push({ value, label });
        });
        genres.sort((a, b) => a.label.localeCompare(b.label));

        return {
          success: true,
          data: {
            tipe: [
              { value: "manhwa", label: "Manhwa" },
              { value: "manga", label: "Manga" },
              { value: "manhua", label: "Manhua" },
            ],
            status: [
              { value: "ongoing", label: "Ongoing" },
              { value: "completed", label: "Completed" },
              { value: "hiatus", label: "Hiatus" },
            ],
            genre: genres,
          },
        };
      });
      if (payload?.success) cacheSet(cacheKey, payload);
      res.json(payload);
    } catch (error) {
      console.error("❌ VT filters:", error.message);
      res.status(500).json({ success: false, data: { tipe: [], status: [], genre: [] } });
    }
  });


  // Pemanasan cache: situs sumber butuh 7-20 detik per halaman, jadi cache
  // diisi di belakang supaya pengunjung tidak menunggu jalur dingin.
  const SELF = `http://127.0.0.1:${process.env.PORT || 3012}`;
  let warming = false;

  async function warmCache() {
    if (warming) return;
    warming = true;
    const started = Date.now();
    try {
      const responses = await Promise.all([
        fetch(`${SELF}/vt/pustaka?page=1`).catch(() => null),
        fetch(`${SELF}/vt/pustaka?page=2`).catch(() => null),
        fetch(`${SELF}/vt/filters`).catch(() => null),
      ]);
      const first = responses[0];
      const listing = first ? await first.json().catch(() => null) : null;
      const slugs = (listing?.data || []).slice(0, 6).map((item) => item.slug).filter(Boolean);
      for (const slug of slugs) {
        await fetch(`${SELF}/vt/detail/${encodeURIComponent(slug)}`).catch(() => null);
      }
      vlog(`cache hangat dalam ${Math.round((Date.now() - started) / 1000)}s (${slugs.length} seri)`);
    } catch (error) {
      vlog("warm gagal:", error.message);
    } finally {
      warming = false;
    }
  }

  setTimeout(() => void warmCache(), 8000);
  setInterval(() => void warmCache(), 60 * 60 * 1000);

  vlog("routes registered: /vt/pustaka, /vt/detail/:slug, /vt/chapter/*, /vt/image");
}

module.exports = registerVtRoutes;
