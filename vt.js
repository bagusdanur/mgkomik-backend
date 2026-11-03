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
const ALT_HOST = Buffer.from("MTIudm9yYXRvb24uY29t", "base64").toString("utf8");

const BASE = BASE_HOST;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function absolute(req, pathValue) {
  if (!pathValue) return "";
  if (/^https?:/i.test(pathValue)) return pathValue;
  // Di belakang nginx, req.protocol selalu http — pakai x-forwarded-proto.
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  return `${proto}://${req.get("host")}${pathValue}`;
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
    timeout: 20000,
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
      const cached = getCache(cacheKey);
      if (cached) return res.json(cached);

      const payload = await coalescedScrape(cacheKey, async () => {
        const html = await fetchHtml(`${BASE}/updates?page=${page}`);
        const data = parseUpdatesPage(html).map((item) => ({ ...item, image: absolute(req, item.image) }));
        return {
          success: true,
          source: "vt",
          page,
          total: data.length,
          meta: { currentPage: page, totalPages: page + 1, totalItems: data.length },
          data,
        };
      });
      if (payload?.success && payload.data?.length) setCache(cacheKey, payload, 300);
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
      const cached = getCache(cacheKey);
      if (cached) return res.json(cached);

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
            mangaId: slug,
          },
        };
      });
      if (payload?.success) setCache(cacheKey, payload, 600);
      res.json(payload);
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
      const cached = getCache(cacheKey);
      if (cached) return res.json(cached);

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

        const chapterNum = Number(chapterNumber);
        return {
          success: images.length > 0,
          mangaId: seriesSlug,
          chapterSlug: raw,
          currentChapter: `Chapter ${chapterNumber}`,
          images,
          prev: chapterNum > 1 ? `${seriesSlug}/chapter/${chapterNum - 1}` : null,
          next: `${seriesSlug}/chapter/${chapterNum + 1}`,
          source_broken: false,
          source_status: 200,
        };
      });
      if (payload?.success) setCache(cacheKey, payload, 7200);
      res.json(payload);
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
        timeout: 20000,
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
      const cached = getCache(cacheKey);
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

      if (payload?.success) setCache(cacheKey, payload, 600);
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
      const cached = getCache(cacheKey);
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
        return {
          success: true,
          source: "vt",
          page,
          total: data.length,
          meta: { currentPage: page, totalPages: page + 1, totalItems: data.length },
          data,
        };
      });
      if (payload?.success && payload.data?.length) setCache(cacheKey, payload, 300);
      res.json(payload);
    } catch (error) {
      console.error("❌ VT filter:", error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/vt/filters", async (req, res) => {
    try {
      const cacheKey = "vt:filters";
      const cached = getCache(cacheKey);
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
      if (payload?.success) setCache(cacheKey, payload, 6 * 3600);
      res.json(payload);
    } catch (error) {
      console.error("❌ VT filters:", error.message);
      res.status(500).json({ success: false, data: { tipe: [], status: [], genre: [] } });
    }
  });

  vlog("routes registered: /vt/pustaka, /vt/detail/:slug, /vt/chapter/*, /vt/image");
}

module.exports = registerVtRoutes;
