const axios = require("axios");
const cheerio = require("cheerio");

const IKIRU_BASE_URL = "https://06.ikiru.wtf";
const WORKER_PROXY = process.env.IKIRU_PROXY_URL || "https://proxy.akunncoc992.workers.dev/";

function getRequestBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function toIkiruBackendImageUrl(url, req) {
  if (!url) return "";
  // Tembak langsung ke Worker dari browser frontend agar tidak memakan bandwidth VPS
  return `${WORKER_PROXY}${WORKER_PROXY.includes("?") ? "&" : "?"}url=${encodeURIComponent(url)}&referer=${encodeURIComponent(IKIRU_BASE_URL + "/")}`;
}

async function fetchIkiruHtml(urlPath) {
  const targetUrl = urlPath.startsWith("http") ? urlPath : IKIRU_BASE_URL + urlPath;
  const proxyUrl = `${WORKER_PROXY}${WORKER_PROXY.includes("?") ? "&" : "?"}url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(IKIRU_BASE_URL + "/")}`;
  
  const response = await axios.get(proxyUrl, {
    timeout: 15000,
  });
  return response.data;
}

module.exports = function (app, { getCache, setCache, coalescedScrape }) {

  // ── IMAGE PROXY ──────────────────────────────────────
  app.get("/ikiru/image", async (req, res) => {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("No URL provided");
    }

    try {
      const decodedUrl = decodeURIComponent(url);
      const workerUrl = `${WORKER_PROXY}${WORKER_PROXY.includes("?") ? "&" : "?"}url=${encodeURIComponent(decodedUrl)}&referer=${encodeURIComponent(IKIRU_BASE_URL + "/")}`;
      
      const response = await axios.get(workerUrl, {
        responseType: "arraybuffer",
        timeout: 15000,
      });

      const ct = response.headers["content-type"] || "image/jpeg";
      res.set({
        "Content-Type": ct,
        "Content-Length": response.data.length,
        "Cache-Control": "public, max-age=31536000",
      });
      res.send(response.data);
    } catch (err) {
      console.error(`[Ikiru Proxy Error] URL: ${url} | Error: ${err.message}`);
      res.status(err.response?.status || 500).send(err.message);
    }
  });

  // ── PUSTAKA (LATEST) ─────────────────────────────────
  app.get("/ikiru/pustaka", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `ikiru:pustaka:p:${page}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      // Rewrite URLs inside cache based on current request
      const cloned = JSON.parse(JSON.stringify(cached));
      cloned.data.forEach(item => {
        if(item.image) item.image = toIkiruBackendImageUrl(item.image, req);
      });
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const html = await fetchIkiruHtml(`/page/${page}/`);
        const $ = cheerio.load(html);

        const data = [];
        const seenUrls = new Set();

        $('a').each((i, el) => {
          const href = $(el).attr('href');
          // Match manga links but not chapters
          if (href && href.includes('/manga/') && !href.includes('chapter-') && !seenUrls.has(href)) {
            seenUrls.add(href);
            
            // The structure is weird, so we traverse parents to find the image and title
            const container = $(el).parent();
            const title = $(el).attr('title') || container.find('img').attr('alt') || $(el).text().trim();
            const img = container.find('img').attr('src') || $(el).find('img').attr('src') || "";
            
            // Extract slug
            const parts = href.split('/').filter(Boolean);
            const slug = parts[parts.length - 1];

            if (title && slug) {
              data.push({
                title,
                slug,
                image: img,
              });
            }
          }
        });

        const result = {
          success: true,
          source: "ikiru.wtf",
          page,
          data,
        };

        setCache(cacheKey, result, 300); // 5 menit
        return result;
      });

      // Rewrite images for output
      const cloned = JSON.parse(JSON.stringify(responseData));
      cloned.data.forEach(item => {
        if(item.image) item.image = toIkiruBackendImageUrl(item.image, req);
      });
      res.json(cloned);

    } catch (err) {
      console.error("[Ikiru Pustaka Error]", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── DETAIL MANGA ─────────────────────────────────────
  app.get("/ikiru/detail/:slug", async (req, res) => {
    const slug = req.params.slug;
    const cacheKey = `ikiru:detail:${slug}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      const cloned = JSON.parse(JSON.stringify(cached));
      if (cloned.thumbnail) cloned.thumbnail = toIkiruBackendImageUrl(cloned.thumbnail, req);
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const html = await fetchIkiruHtml(`/manga/${slug}/`);
        const $ = cheerio.load(html);

        const title = $('h1').first().text().trim();
        
        let thumbnail = "";
        $('img.wp-post-image').each((i, el) => {
            const src = $(el).attr('src');
            if(src && !src.includes('logo')) {
                thumbnail = src;
            }
        });
        if(!thumbnail) {
            $('img').each((i, el) => {
                const src = $(el).attr('src');
                if(src && src.includes('wp-content/uploads') && !src.includes('logo')) {
                    thumbnail = src;
                }
            });
        }

        const synopsis = $('.text-sm.text-gray-300').text().trim() || $('p').first().text().trim();

        const genres = [];
        $('a[href*="/genre/"]').each((i, el) => {
          genres.push($(el).text().trim());
        });

        const chapters = [];
        const seenChapters = new Set();
        $('a[href*="chapter-"]').each((i, el) => {
          const href = $(el).attr('href');
          if (href && !seenChapters.has(href)) {
            seenChapters.add(href);
            // Extract chapter slug
            const parts = href.split('/').filter(Boolean);
            const chapterSlug = parts[parts.length - 1];
            
            // Extract chapter number from text or slug
            const name = $(el).text().trim() || chapterSlug.replace(/-/g, ' ');
            
            chapters.push({
              title: name,
              slug: `${slug}/${chapterSlug}`, // We use compound slug to match the chapter structure
              url: href
            });
          }
        });

        const result = {
          success: true,
          title,
          thumbnail,
          synopsis,
          genres,
          chapters,
        };

        setCache(cacheKey, result, 3600); // 1 jam
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      if (cloned.thumbnail) cloned.thumbnail = toIkiruBackendImageUrl(cloned.thumbnail, req);
      res.json(cloned);

    } catch (err) {
      console.error("[Ikiru Detail Error]", err.message);
      res.status(500).json({ success: false, message: "Manga tidak ditemukan" });
    }
  });

  // ── CHAPTER MANGA ────────────────────────────────────
  app.get("/ikiru/chapter/:slug/:chapterSlug", async (req, res) => {
    const { slug, chapterSlug } = req.params;
    const fullSlug = `${slug}/${chapterSlug}`;
    const cacheKey = `ikiru:chapter:${fullSlug}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      const cloned = JSON.parse(JSON.stringify(cached));
      cloned.images = cloned.images.map(img => toIkiruBackendImageUrl(img, req));
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const html = await fetchIkiruHtml(`/manga/${slug}/${chapterSlug}/`);
        const $ = cheerio.load(html);

        const images = [];
        $('img').each((i, el) => {
          const src = $(el).attr('src');
          // Basic filtering to avoid ads/logos
          if (src && !src.includes('logo') && !src.includes('.gif') && !src.includes('banner')) {
            images.push(src);
          }
        });

        const title = $('h1').first().text().trim();

        // Very basic prev/next extraction if available
        let prev = null;
        let next = null;
        $('a').each((i, el) => {
           const href = $(el).attr('href');
           const text = $(el).text().toLowerCase();
           if(href && href.includes('chapter-')) {
               const cSlug = href.split('/').filter(Boolean).pop();
               if(text.includes('prev')) prev = `${slug}/${cSlug}`;
               if(text.includes('next')) next = `${slug}/${cSlug}`;
           }
        });

        const result = {
          success: true,
          mangaId: slug,
          chapterSlug: fullSlug,
          currentChapter: title,
          images,
          prev,
          next
        };

        setCache(cacheKey, result, 3600 * 24); // 24 jam
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      cloned.images = cloned.images.map(img => toIkiruBackendImageUrl(img, req));
      res.json(cloned);

    } catch (err) {
      console.error("[Ikiru Chapter Error]", err.message);
      res.status(500).json({ success: false, message: "Chapter tidak ditemukan" });
    }
  });

  // ── SEARCH ───────────────────────────────────────────
  app.get("/ikiru/search", async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ success: true, data: [] });

    const cacheKey = `ikiru:search:${query}`;

    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ [Cache Hit] ${cacheKey}`);
      const cloned = JSON.parse(JSON.stringify(cached));
      cloned.data.forEach(item => {
        if(item.image) item.image = toIkiruBackendImageUrl(item.image, req);
      });
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        // ikiru search typically: /?s=keyword
        const html = await fetchIkiruHtml(`/?s=${encodeURIComponent(query)}`);
        const $ = cheerio.load(html);

        const data = [];
        const seenUrls = new Set();

        $('a').each((i, el) => {
          const href = $(el).attr('href');
          if (href && href.includes('/manga/') && !href.includes('chapter-') && !seenUrls.has(href)) {
            seenUrls.add(href);
            
            const container = $(el).parent();
            const title = $(el).attr('title') || container.find('img').attr('alt') || $(el).text().trim();
            const img = container.find('img').attr('src') || $(el).find('img').attr('src') || "";
            
            const parts = href.split('/').filter(Boolean);
            const slug = parts[parts.length - 1];

            if (title && slug) {
              data.push({
                title,
                slug,
                image: img,
              });
            }
          }
        });

        const result = {
          success: true,
          source: "ikiru.wtf",
          data,
        };

        setCache(cacheKey, result, 3600); // 1 jam
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      cloned.data.forEach(item => {
        if(item.image) item.image = toIkiruBackendImageUrl(item.image, req);
      });
      res.json(cloned);

    } catch (err) {
      console.error("[Ikiru Search Error]", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  console.log("✅ Ikiru routes registered: /ikiru/pustaka, /ikiru/detail/:slug, /ikiru/chapter/:slug/:chapterSlug, /ikiru/search, /ikiru/image");
};
