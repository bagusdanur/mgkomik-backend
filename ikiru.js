const axios = require("axios");
const cheerio = require("cheerio");

const IKIRU_BASE_URL = "https://06.ikiru.wtf";
const WORKER_PROXY = process.env.IKIRU_PROXY_URL || "https://proxy.akunncoc992.workers.dev/";

function getRequestBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function toIkiruBackendImageUrl(url, req) {
  if (!url) return "";
  return `${getRequestBaseUrl(req)}/ikiru/image?url=${encodeURIComponent(url)}`;
}

async function fetchIkiruHtml(urlPath) {
  const targetUrl = urlPath.startsWith("http") ? urlPath : IKIRU_BASE_URL + urlPath;
  const proxyUrl = `${WORKER_PROXY}${WORKER_PROXY.includes("?") ? "&" : "?"}url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(IKIRU_BASE_URL + "/")}`;
  
  const response = await axios.get(proxyUrl, {
    timeout: 15000,
  });
  return response.data;
}

function translateTime(str) {
  if (!str) return "";
  return str
    .replace(/seconds?/i, "detik")
    .replace(/minutes?/i, "menit")
    .replace(/hours?/i, "jam")
    .replace(/days?/i, "hari")
    .replace(/weeks?/i, "minggu")
    .replace(/months?/i, "bulan")
    .replace(/years?/i, "tahun")
    .replace(/ago/i, "lalu");
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
      
      const response = await axios.get(decodedUrl, {
        responseType: "arraybuffer",
        timeout: 15000,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "" 
        }
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

        $('.flex.items-start.gap-4').each((i, el) => {
          const detailLinkEl = $(el).find('a[href*="/manga/"]').first();
          const href = detailLinkEl.attr('href');
          
          if (href && !href.includes('chapter-') && !seenUrls.has(href)) {
            seenUrls.add(href);
            
            const title = $(el).find('.flex-col > a.font-medium').text().trim() || detailLinkEl.attr('title') || "";
            const img = detailLinkEl.find('img').first().attr('src') || "";
            
            let type_genre = "";
            detailLinkEl.find('img').each((idx, imgEl) => {
               const alt = $(imgEl).attr('alt') || "";
               if(alt.toLowerCase() === 'manhwa' || alt.toLowerCase() === 'manga' || alt.toLowerCase() === 'manhua') {
                   type_genre = alt;
               }
            });

            const parts = href.split('/').filter(Boolean);
            const slug = parts[parts.length - 1];

            const chapters = [];
            $(el).find('.flex-col a[href*="chapter-"]').each((idx, chEl) => {
                const chLink = $(chEl).attr('href');
                const chTitle = $(chEl).find('p').text().trim() || $(chEl).text().trim();
                const chTime = translateTime($(chEl).find('time').text().trim() || "");
                if(chLink && chTitle) {
                    chapters.push({
                        title: chTitle,
                        link: chLink,
                        time: chTime,
                        locked: false
                    });
                }
            });

            const latest = chapters[0] || {};
            const oldest = chapters[chapters.length - 1] || {};

            if (title && slug) {
              data.push({
                source: "ikiru.wtf",
                title,
                slug,
                image: img,
                detail_link: href,
                description: "",
                type_genre: type_genre || "Manga",
                info: latest.time || "",
                chapter_awal: oldest.title || "",
                chapter_terbaru: latest.title || "",
                chapters
              });
            }
          }
        });

        if (data.length === 0) {
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
                    source: "ikiru.wtf",
                    title,
                    slug,
                    image: img,
                    detail_link: href,
                    description: "",
                    type_genre: "",
                    info: "",
                    chapter_awal: "",
                    chapter_terbaru: "",
                    chapters: []
                  });
                }
              }
            });
        }

        const result = {
          success: true,
          meta: {
            currentPage: page,
            totalPages: page + 1,
            totalItems: data.length,
          },
          data,
        };

        setCache(cacheKey, result, 300); // 5 menit
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      cloned.data.forEach(item => {
        if(item.image) item.image = toIkiruBackendImageUrl(item.image, req);
      });
      res.json(cloned);

    } catch (err) {
      console.error("[Ikiru Pustaka Error]", err.message);
      res.status(500).json({ success: false, message: err.message, meta: { currentPage: page, totalPages: 1, totalItems: 0 }, data: [] });
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
      if (cloned.data && cloned.data.thumbnail) cloned.data.thumbnail = toIkiruBackendImageUrl(cloned.data.thumbnail, req);
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
            if(src && !src.includes('logo')) thumbnail = src;
        });
        if(!thumbnail) {
            $('img').each((i, el) => {
                const src = $(el).attr('src');
                if(src && src.includes('wp-content/uploads') && !src.includes('logo')) thumbnail = src;
            });
        }

        let synopsis = $('.text-sm.text-gray-300').text().trim() || $('p').first().text().trim();

        let author = "-";
        let status = "-";
        let released = "-";
        
        $('script[type="application/ld+json"]').each((i, el) => {
            try {
                const json = JSON.parse($(el).html());
                if (json && typeof json === 'object') {
                    const data = Array.isArray(json) ? json : (json['@graph'] || [json]);
                    for (const item of data) {
                        if (item['@type'] && item['@type'].includes('ComicSeries')) {
                            if (item.author && item.author.name) author = item.author.name.replace(/\]|\[Add/g, '').trim();
                            if (item.creativeWorkStatus) status = item.creativeWorkStatus;
                            if (item.datePublished) released = item.datePublished;
                            if (item.description) synopsis = item.description.replace(/\[&hellip;\]/g, '...');
                        }
                    }
                }
            } catch(e) {}
        });

        const genres = [];
        $('a[href*="/genre/"]').each((i, el) => {
          const g = $(el).text().trim();
          if(g) genres.push(g);
        });

        const chapters = [];
        const seenChapters = new Set();
        
        // Find chapters only in the actual list container (which has #search-chapter)
        let chapterLinks = $('#search-chapter').parent().find('a[href*="chapter-"]');
        if (chapterLinks.length === 0) {
            // Fallback
            chapterLinks = $('.overflow-auto a[href*="chapter-"]');
        }
        if (chapterLinks.length === 0) {
            // Ultimate fallback
            chapterLinks = $('a[href*="chapter-"]');
        }

        chapterLinks.each((i, el) => {
          let href = $(el).attr('href');
          if (href) {
            href = href.trim();
            if (!seenChapters.has(href)) {
              seenChapters.add(href);
              const parts = href.split('/').filter(Boolean);
              const chapterSlug = parts[parts.length - 1];
              
              const chTitle = $(el).find('span').first().text().trim() || $(el).find('p').first().text().trim() || chapterSlug.replace(/-/g, ' ');
              const chDate = translateTime($(el).find('time').text().trim() || "");
              
              chapters.push({
                title: chTitle,
                slug: `${slug}/${chapterSlug}`, 
                link: href,
                date: chDate 
              });
            }
          }
        });

        const result = {
          success: true,
          data: {
              title: title || "",
              thumbnail: thumbnail || "",
              type: "",
              status: status || "-",
              Pengarang: author || "-",
              Umur: "-",
              Konsep: released || "-",
              artist: "-",
              genres: genres || [],
              synopsis: synopsis || "",
              info: "",
              total_chapter: chapters.length,
              chapters,
          }
        };

        setCache(cacheKey, result, 3600); // 1 jam
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      if (cloned.data && cloned.data.thumbnail) cloned.data.thumbnail = toIkiruBackendImageUrl(cloned.data.thumbnail, req);
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
      if(cloned.images) cloned.images = cloned.images.map(img => toIkiruBackendImageUrl(img, req));
      return res.json(cloned);
    }

    try {
      const responseData = await coalescedScrape(cacheKey, async () => {
        const html = await fetchIkiruHtml(`/manga/${slug}/${chapterSlug}/`);
        const $ = cheerio.load(html);

        const images = [];
        $('img').each((i, el) => {
          const src = $(el).attr('src');
          if (src && !src.includes('logo') && !src.includes('.gif') && !src.includes('banner') && src.includes('wp-content')) {
            images.push(src);
          }
        });

        const title = $('h1').first().text().trim();

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
          prev,
          next,
          back_to_detail: `${IKIRU_BASE_URL}/manga/${slug}/`,
          totalImages: images.length,
          images,
        };

        setCache(cacheKey, result, 3600 * 24); // 24 jam
        return result;
      });

      const cloned = JSON.parse(JSON.stringify(responseData));
      if(cloned.images) cloned.images = cloned.images.map(img => toIkiruBackendImageUrl(img, req));
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
        const html = await fetchIkiruHtml(`/?s=${encodeURIComponent(query)}`);
        const $ = cheerio.load(html);

        const data = [];
        const seenUrls = new Set();

        $('.flex.items-start.gap-4').each((i, el) => {
          const detailLinkEl = $(el).find('a[href*="/manga/"]').first();
          const href = detailLinkEl.attr('href');
          
          if (href && !href.includes('chapter-') && !seenUrls.has(href)) {
            seenUrls.add(href);
            
            const title = $(el).find('.flex-col > a.font-medium').text().trim() || detailLinkEl.attr('title') || "";
            const img = detailLinkEl.find('img').first().attr('src') || "";
            
            let type_genre = "";
            detailLinkEl.find('img').each((idx, imgEl) => {
               const alt = $(imgEl).attr('alt') || "";
               if(alt.toLowerCase() === 'manhwa' || alt.toLowerCase() === 'manga' || alt.toLowerCase() === 'manhua') {
                   type_genre = alt;
               }
            });

            const parts = href.split('/').filter(Boolean);
            const slug = parts[parts.length - 1];

            const chapters = [];
            $(el).find('.flex-col a[href*="chapter-"]').each((idx, chEl) => {
                const chLink = $(chEl).attr('href');
                const chTitle = $(chEl).find('p').text().trim() || $(chEl).text().trim();
                const chTime = $(chEl).find('time').text().trim() || "";
                if(chLink && chTitle) {
                    chapters.push({
                        title: chTitle,
                        link: chLink,
                        time: chTime,
                        locked: false
                    });
                }
            });

            const latest = chapters[0] || {};
            const oldest = chapters[chapters.length - 1] || {};

            if (title && slug) {
              data.push({
                source: "ikiru.wtf",
                title,
                slug,
                image: img,
                detail_link: href,
                description: "",
                type_genre: type_genre || "Manga", // fallback
                info: latest.time || "",
                chapter_awal: oldest.title || "",
                chapter_terbaru: latest.title || "",
                chapters
              });
            }
          }
        });

        // Backup fallback
        if (data.length === 0) {
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
                    source: "ikiru.wtf",
                    title,
                    slug,
                    image: img,
                    detail_link: href,
                    description: "",
                    type_genre: "",
                    info: "",
                    chapter_awal: "",
                    chapter_terbaru: "",
                    chapters: []
                  });
                }
              }
            });
        }

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
      res.status(500).json({ success: false, message: err.message, data: [] });
    }
  });

  console.log("✅ Ikiru routes registered: /ikiru/pustaka, /ikiru/detail/:slug, /ikiru/chapter/:slug/:chapterSlug, /ikiru/search, /ikiru/image");
};
