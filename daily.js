/**
 * =====================================================
 * SCRAPER DAILY SUKA - https://dailysuka.com/
 * =====================================================
 * Menggunakan WordPress REST API (bukan HTML scraping)
 * karena dailysuka.com pakai Cloudflare Turnstile yang
 * memblokir semua HTTP scraper biasa.
 *
 * Struktur site:
 * - Category = Manga (slug category = manga slug)
 * - Post     = Chapter (slug post = chapter slug)
 * - Images   = di content.rendered (img tag dari CDN)
 * =====================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");

const DAILY_BASE_URL = "https://dailysuka.com";
const WORKER_PROXY = process.env.DAILY_PROXY_URL || "https://daily.kanimenia778.workers.dev/";

// ===========================
// HELPER FUNCTIONS
// ===========================

function getRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol || "http").split(",")[0].trim();
  return proto + "://" + req.get("host");
}

function toDailyBackendImageUrl(url, req) {
  if (!url) return "";
  return getRequestBaseUrl(req) + "/daily/image?url=" + encodeURIComponent(url);
}

/**
 * Fetch dari URL dailysuka.com melalui Worker proxy
 * (Worker bypass Cloudflare untuk wp-json endpoint)
 */
async function dailyApiFetch(path, options) {
  options = options || {};
  const fullUrl = path.startsWith("http") ? path : (DAILY_BASE_URL + path);
  const sep = WORKER_PROXY.includes("?") ? "&" : "?";
  const proxyUrl = WORKER_PROXY + sep + "url=" + encodeURIComponent(fullUrl) + "&referer=" + encodeURIComponent(DAILY_BASE_URL + "/");
  const timeout = options.timeout || 20000;

  const resp = await axios.get(proxyUrl, { timeout });
  return resp.data;
}

/**
 * Ekstrak gambar dari content.rendered HTML
 */
function extractImagesFromContent(content) {
  content = content || "";
  const $ = cheerio.load(content);
  const images = [];
  $("img").each(function (i, el) {
    const src = $(el).attr("data-src") || $(el).attr("src") || "";
    if (src && src.length > 10 && !src.includes("logo") && !src.includes("icon")) {
      images.push(src);
    }
  });
  // Also match src in raw HTML (lazy load)
  const rawMatches = content.match(/src="(https:\/\/[^"]+\.(jpg|jpeg|png|webp|gif)[^"]*)"/gi) || [];
  rawMatches.forEach(function (m) {
    const urlMatch = m.match(/src="([^"]+)"/);
    if (urlMatch) {
      const u = urlMatch[1];
      if (!images.includes(u) && !u.includes("logo") && !u.includes("icon")) {
        images.push(u);
      }
    }
  });
  return Array.from(new Set(images));
}

/**
 * Format tanggal ke human readable
 */
function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return diff + " detik lalu";
    if (diff < 3600) return Math.floor(diff / 60) + " menit lalu";
    if (diff < 86400) return Math.floor(diff / 3600) + " jam lalu";
    if (diff < 2592000) return Math.floor(diff / 86400) + " hari lalu";
    if (diff < 31536000) return Math.floor(diff / 2592000) + " bulan lalu";
    return Math.floor(diff / 31536000) + " tahun lalu";
  } catch (e) {
    return dateStr;
  }
}

/**
 * Strip HTML tags
 */
function stripHtml(html) {
  return (html || "").replace(/<[^>]+>/g, "").trim();
}

// ===========================
// MODULE EXPORT
// ===========================

module.exports = function (app, deps) {
  const getCache = deps.getCache;
  const setCache = deps.setCache;
  const coalescedScrape = deps.coalescedScrape;
  const getImageCache = deps.getImageCache;
  const setImageCache = deps.setImageCache;

  // ─── IMAGE PROXY ────────────────────────────────────────
  app.get("/daily/image", async function (req, res) {
    const url = req.query.url;
    if (!url) return res.status(400).send("No URL provided");
    try {
      const imageUrl = decodeURIComponent(url);

      const cached = getImageCache(imageUrl);
      if (cached) {
        return res.set('Content-Type', cached.contentType).set('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=604800').send(cached.buffer);
      }

      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": DAILY_BASE_URL + "/"
      };
      let imageBuffer, contentType = "image/jpeg";
      const errors = [];

      function isValidImage(buf) {
        if (!Buffer.isBuffer(buf) || buf.length < 500) return false;
        const h = buf.slice(0, 4);
        return (h[0] === 0xFF && h[1] === 0xD8) ||
               (h[0] === 0x89 && h[1] === 0x50) ||
               (h[0] === 0x52 && h[1] === 0x49) ||
               (h[0] === 0x47 && h[1] === 0x49);
      }

      // Strategi 1: Direct fetch (CDN biasanya tidak diblock)
      try {
        const r = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 10000, headers });
        const ct = r.headers["content-type"] || "";
        if (isValidImage(r.data)) {
          imageBuffer = r.data;
          contentType = ct.startsWith("image/") ? ct : "image/jpeg";
          console.log("[Daily Proxy] Direct OK: " + imageUrl);
        } else {
          errors.push("direct:bukan-gambar-valid");
        }
      } catch (err) {
        errors.push("direct:" + (err.response ? err.response.status : (err.code || err.message)));
      }

      // Strategi 2: Worker proxy
      if (!imageBuffer && WORKER_PROXY) {
        try {
          const sep = WORKER_PROXY.includes("?") ? "&" : "?";
          const wu = WORKER_PROXY + sep + "url=" + encodeURIComponent(imageUrl) + "&referer=" + encodeURIComponent(DAILY_BASE_URL + "/");
          const r = await axios.get(wu, { responseType: "arraybuffer", timeout: 15000 });
          const ct = r.headers["content-type"] || "";
          if (isValidImage(r.data)) {
            imageBuffer = r.data;
            contentType = ct.startsWith("image/") ? ct : "image/jpeg";
            console.log("[Daily Proxy] Worker OK: " + imageUrl);
          } else {
            errors.push("worker:bukan-gambar-valid");
          }
        } catch (err) {
          errors.push("worker:" + (err.response ? err.response.status : (err.code || err.message)));
        }
      }

      // Strategi 3: Cloudscraper
      if (!imageBuffer) {
        try {
          const cs = require("cloudscraper");
          const buf = await cs.get({ uri: imageUrl, encoding: null, timeout: 20000, headers });
          if (Buffer.isBuffer(buf) && buf.length > 500 && isValidImage(buf)) {
            imageBuffer = buf;
            if (buf[0] === 0x89) contentType = "image/png";
            else if (buf[0] === 0x52) contentType = "image/webp";
            else if (buf[0] === 0x47) contentType = "image/gif";
            console.log("[Daily Proxy] Cloudscraper OK: " + imageUrl);
          } else {
            errors.push("cloudscraper:bukan-gambar-valid");
          }
        } catch (err) {
          errors.push("cloudscraper:" + err.message);
        }
      }

      if (!imageBuffer) {
        console.error("[Daily Proxy] Semua gagal: " + errors.join(" -> "));
        return res.status(502).send("Gagal ambil gambar: " + errors.join(" -> "));
      }
      setImageCache(imageUrl, imageBuffer, contentType);
      res.set({ "Content-Type": contentType, "Content-Length": imageBuffer.length, "Cache-Control": "public, max-age=86400, s-maxage=86400" });
      res.send(imageBuffer);
    } catch (err) {
      console.error("[Daily Proxy Error] URL: " + url + " | Error: " + err.message);
      res.status(502).send(err.message);
    }
  });

  // ─── PUSTAKA (LATEST) ────────────────────────────────────
  // Ambil posts terbaru (setiap post = chapter), group by category (manga)
  app.get("/daily/pustaka", async function (req, res) {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = "daily:pustaka:p:" + page;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[Cache Hit] " + cacheKey);
      const cloned = JSON.parse(JSON.stringify(cached));
      cloned.data.forEach(function (item) { if (item.image) item.image = toDailyBackendImageUrl(item.image, req); });
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async function () {
        // Ambil posts terbaru - setiap post = chapter terbaru suatu manga
        const posts = await dailyApiFetch(
          "/wp-json/wp/v2/posts?per_page=50&page=" + page + "&orderby=modified&order=desc&_fields=id,slug,title,date,modified,categories,featured_media,link,yoast_head_json,content"
        );

        if (!Array.isArray(posts) || posts.length === 0) {
          throw new Error("Tidak ada posts dari API");
        }

        // Kumpulkan category IDs unik
        const catIds = [];
        const catIdToPost = {};
        posts.forEach(function (post) {
          (post.categories || []).forEach(function (catId) {
            if (!catIds.includes(catId)) {
              catIds.push(catId);
              catIdToPost[catId] = post;
            }
          });
        });

        // Fetch info category (= manga) untuk catIds unik
        const data = [];
        const seenCatIds = new Set();

        // Batch fetch categories
        const catChunks = [];
        for (let i = 0; i < catIds.length; i += 100) {
          catChunks.push(catIds.slice(i, i + 100));
        }

        for (const chunk of catChunks) {
          try {
            const cats = await dailyApiFetch(
              "/wp-json/wp/v2/categories?include=" + chunk.join(",") + "&per_page=100&_fields=id,name,slug,count,link,description"
            );
            if (!Array.isArray(cats)) continue;

            cats.forEach(function (cat) {
              if (seenCatIds.has(cat.id)) return;
              seenCatIds.add(cat.id);

              const latestPost = catIdToPost[cat.id];
              const chapterTitle = latestPost ? (latestPost.title ? latestPost.title.rendered : latestPost.slug) : "";
              const chapterSlug = latestPost ? latestPost.slug : "";
              const info = latestPost ? formatDate(latestPost.modified || latestPost.date) : "";
              
              let image = "";
              if (latestPost) {
                if (latestPost.yoast_head_json && latestPost.yoast_head_json.og_image && latestPost.yoast_head_json.og_image.length > 0) {
                  image = latestPost.yoast_head_json.og_image[0].url;
                } else if (latestPost.content && latestPost.content.rendered) {
                  const imgs = extractImagesFromContent(latestPost.content.rendered);
                  if (imgs.length > 0) image = imgs[0];
                }
              }

              data.push({
                source: "dailysuka.com",
                title: stripHtml(cat.name) || "",
                slug: cat.slug || "",
                image: image,
                detail_link: DAILY_BASE_URL + "/category/" + cat.slug + "/",
                description: stripHtml(cat.description) || "",
                type_genre: "Manga",
                info: info,
                chapter_awal: "",
                chapter_terbaru: stripHtml(chapterTitle),
                chapters: chapterSlug ? [{
                  title: stripHtml(chapterTitle),
                  slug: cat.slug + "/" + chapterSlug,
                  link: DAILY_BASE_URL + "/" + chapterSlug + "/",
                  date: info
                }] : []
              });
            });
          } catch (e) {
            console.warn("[Daily Pustaka] Gagal fetch cats chunk:", e.message);
          }
        }

        const result = {
          success: true,
          source: "dailysuka.com",
          page,
          total: data.length,
          meta: {
            currentPage: page,
            totalPages: page + 1,
            totalItems: data.length
          },
          data
        };
        setCache(cacheKey, result, 300);
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      cloned.data.forEach(function (item) { if (item.image) item.image = toDailyBackendImageUrl(item.image, req); });
      res.json(cloned);
    } catch (err) {
      console.error("[Daily Pustaka Error]", err.message);
      res.status(500).json({ success: false, message: err.message, meta: { currentPage: page, totalPages: 1, totalItems: 0 }, data: [] });
    }
  });

  // ─── DETAIL MANGA ────────────────────────────────────────
  // Slug = category slug (manga slug)
  // Ambil semua posts di category tersebut = daftar chapter
  app.get("/daily/detail/:slug", async function (req, res) {
    const slug = req.params.slug;
    const cacheKey = "daily:detail:" + slug;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[Cache Hit] " + cacheKey);
      const cloned = JSON.parse(JSON.stringify(cached));
      if (cloned.data && cloned.data.thumbnail) cloned.data.thumbnail = toDailyBackendImageUrl(cloned.data.thumbnail, req);
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async function () {
        // Cari category berdasarkan slug
        const cats = await dailyApiFetch("/wp-json/wp/v2/categories?slug=" + encodeURIComponent(slug) + "&_fields=id,name,slug,count,description,link");
        if (!Array.isArray(cats) || cats.length === 0) {
          throw new Error("Manga tidak ditemukan: " + slug);
        }
        const cat = cats[0];

        // Ambil semua posts di category ini (semua chapter)
        // WP REST API max per_page = 100, loop jika perlu
        const chapters = [];
        let fetchPage = 1;
        let hasMore = true;
        while (hasMore) {
          const posts = await dailyApiFetch(
            "/wp-json/wp/v2/posts?categories=" + cat.id + "&per_page=100&page=" + fetchPage + "&orderby=date&order=asc&_fields=id,slug,title,date,modified"
          );
          if (!Array.isArray(posts) || posts.length === 0) {
            hasMore = false;
          } else {
            posts.forEach(function (post) {
              chapters.push({
                title: stripHtml(post.title ? post.title.rendered : post.slug),
                slug: slug + "/" + post.slug,
                link: DAILY_BASE_URL + "/" + post.slug + "/",
                date: formatDate(post.date)
              });
            });
            if (posts.length < 100) hasMore = false;
            else fetchPage++;
            if (fetchPage > 10) hasMore = false; // safety limit
          }
        }

        // Thumbnail: ambil dari gambar pertama post terbaru
        let thumbnail = "";
        if (chapters.length > 0) {
          try {
            const latestPosts = await dailyApiFetch(
              "/wp-json/wp/v2/posts?categories=" + cat.id + "&per_page=1&orderby=date&order=desc&_fields=id,featured_media,yoast_head_json,content"
            );
            if (Array.isArray(latestPosts) && latestPosts.length > 0) {
              const lp = latestPosts[0];
              if (lp.yoast_head_json && lp.yoast_head_json.og_image && lp.yoast_head_json.og_image.length > 0) {
                thumbnail = lp.yoast_head_json.og_image[0].url;
              } else if (lp.content && lp.content.rendered) {
                const imgs = extractImagesFromContent(lp.content.rendered);
                if (imgs.length > 0) thumbnail = imgs[0];
              } else if (lp.featured_media) {
                const media = await dailyApiFetch("/wp-json/wp/v2/media/" + lp.featured_media + "?_fields=source_url,media_details");
                if (media && media.source_url) thumbnail = media.source_url;
              }
            }
          } catch (e) { /* skip */ }
        }

        const result = {
          success: true,
          data: {
            title: stripHtml(cat.name) || "",
            thumbnail: thumbnail || "",
            type: "Manga",
            status: "-",
            Pengarang: "-",
            Umur: "-",
            Konsep: "-",
            artist: "-",
            genres: [],
            synopsis: stripHtml(cat.description) || "",
            info: "",
            total_chapter: chapters.length,
            chapters
          }
        };
        setCache(cacheKey, result, 3600);
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      if (cloned.data && cloned.data.thumbnail) cloned.data.thumbnail = toDailyBackendImageUrl(cloned.data.thumbnail, req);
      res.json(cloned);
    } catch (err) {
      console.error("[Daily Detail Error]", err.message);
      res.status(500).json({ success: false, message: "Manga tidak ditemukan" });
    }
  });

  // ─── CHAPTER READER ──────────────────────────────────────
  // Slug format: {manga-slug}/{chapter-post-slug}
  app.get("/daily/chapter/:slug/:chapterSlug", async function (req, res) {
    const mangaSlug = req.params.slug;
    const chapterSlug = req.params.chapterSlug;
    const fullSlug = mangaSlug + "/" + chapterSlug;
    const cacheKey = "daily:chapter:" + fullSlug;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[Cache Hit] " + cacheKey);
      const cloned = JSON.parse(JSON.stringify(cached));
      if (cloned.images) cloned.images = cloned.images.map(function (img) { return toDailyBackendImageUrl(img, req); });
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async function () {
        // Fetch post by slug
        const posts = await dailyApiFetch("/wp-json/wp/v2/posts?slug=" + encodeURIComponent(chapterSlug) + "&_fields=id,slug,title,content,date,categories");
        if (!Array.isArray(posts) || posts.length === 0) {
          throw new Error("Chapter tidak ditemukan: " + chapterSlug);
        }
        const post = posts[0];

        const images = extractImagesFromContent(post.content ? post.content.rendered : "");
        const title = stripHtml(post.title ? post.title.rendered : chapterSlug);
        const catId = (post.categories || [])[0];

        // Prev/next: fetch posts yang adjacent di category yang sama
        let prev = null, next = null;
        if (catId) {
          try {
            // Ambil semua posts di category ini, sortir by date asc
            const allPosts = await dailyApiFetch(
              "/wp-json/wp/v2/posts?categories=" + catId + "&per_page=100&orderby=date&order=asc&_fields=id,slug,title,date"
            );
            if (Array.isArray(allPosts)) {
              const idx = allPosts.findIndex(function (p) { return p.slug === chapterSlug; });
              if (idx > 0) {
                const prevPost = allPosts[idx - 1];
                prev = mangaSlug + "/" + prevPost.slug;
              }
              if (idx >= 0 && idx < allPosts.length - 1) {
                const nextPost = allPosts[idx + 1];
                next = mangaSlug + "/" + nextPost.slug;
              }
            }
          } catch (e) { /* skip navigation */ }
        }

        const result = {
          success: true,
          mangaId: mangaSlug,
          chapterSlug: fullSlug,
          currentChapter: title,
          prev,
          next,
          back_to_detail: DAILY_BASE_URL + "/category/" + mangaSlug + "/",
          totalImages: images.length,
          images
        };
        setCache(cacheKey, result, 3600 * 24);
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      if (cloned.images) cloned.images = cloned.images.map(function (img) { return toDailyBackendImageUrl(img, req); });
      res.json(cloned);
    } catch (err) {
      console.error("[Daily Chapter Error]", err.message);
      res.status(500).json({ success: false, message: "Chapter tidak ditemukan" });
    }
  });

  // ─── SEARCH ──────────────────────────────────────────────
  // Cari manga = cari category berdasarkan nama
  app.get("/daily/search", async function (req, res) {
    const query = req.query.q;
    if (!query) return res.json({ success: true, data: [] });

    const cacheKey = "daily:search:" + query.toLowerCase().trim();

    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[Cache Hit] " + cacheKey);
      const cloned = JSON.parse(JSON.stringify(cached));
      cloned.data.forEach(function (item) { if (item.image) item.image = toDailyBackendImageUrl(item.image, req); });
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async function () {
        // Search di categories = search manga
        const cats = await dailyApiFetch(
          "/wp-json/wp/v2/categories?search=" + encodeURIComponent(query) + "&per_page=20&_fields=id,name,slug,count,description"
        );

        const data = [];
        if (Array.isArray(cats) && cats.length > 0) {
          // Coba fetch latest post untuk setiap category untuk mendapat thumbnail
          const catIds = cats.map(function(c) { return c.id; });
          let posts = [];
          try {
            posts = await dailyApiFetch(
              "/wp-json/wp/v2/posts?categories=" + catIds.join(",") + "&per_page=50&_fields=id,categories,yoast_head_json,content"
            );
          } catch(e) { /* abaikan error */ }
          
          const catImages = {};
          if (Array.isArray(posts)) {
            posts.forEach(function(p) {
              let img = "";
              if (p.yoast_head_json && p.yoast_head_json.og_image && p.yoast_head_json.og_image.length > 0) {
                img = p.yoast_head_json.og_image[0].url;
              } else if (p.content && p.content.rendered) {
                const imgs = extractImagesFromContent(p.content.rendered);
                if (imgs.length > 0) img = imgs[0];
              }
              (p.categories || []).forEach(function(cid) {
                if (!catImages[cid] && img) catImages[cid] = img;
              });
            });
          }

          cats.forEach(function (cat) {
            data.push({
              source: "dailysuka.com",
              title: stripHtml(cat.name) || "",
              slug: cat.slug || "",
              image: catImages[cat.id] || "",
              detail_link: DAILY_BASE_URL + "/category/" + cat.slug + "/",
              description: stripHtml(cat.description) || "",
              type_genre: "Manga",
              info: cat.count + " chapters",
              chapter_awal: "",
              chapter_terbaru: "",
              chapters: []
            });
          });
        }

        const result = { success: true, source: "dailysuka.com", data };
        setCache(cacheKey, result, 3600);
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      cloned.data.forEach(function (item) { if (item.image) item.image = toDailyBackendImageUrl(item.image, req); });
      res.json(cloned);
    } catch (err) {
      console.error("[Daily Search Error]", err.message);
      res.status(500).json({ success: false, message: err.message, data: [] });
    }
  });

  console.log("Daily routes registered (WP REST API): /daily/pustaka, /daily/detail/:slug, /daily/chapter/:slug/:chapterSlug, /daily/search, /daily/image");
};
