/**
 * =====================================================
 * Scraper router Otakudesu — sumber https://otakudesu.blog/
 * =====================================================
 * Output JSON SENGAJA dibuat IDENTIK dengan scraper animeid di main.js
 * supaya frontend bisa memakai scraper ini tanpa mengubah kode apa pun.
 * Jangan ubah nama field tanpa menyesuaikan frontend.
 *
 *   ongoing  : { success, season{name,progress}, total, data[] }
 *   terbaru  : { success, total, data[] }
 *   jadwal   : { success, activeDay, data{ senin..minggu: [] } }
 *   search   : { success, query, page, totalPages, totalResults, hasNext, hasPrev, data[] }
 *   detail   : { success, data{ title, thumbnail, score, type, trailerUrl, details,
 *               genres, synopsis, status, episodes, duration, season{name,slug},
 *               firstEpisode, lastEpisode, episodeList[] } }
 *   episode  : { success, data{ entryTitle, author, date{raw,formatted}, title,
 *               thumbnail, players[], downloads[], prev, allEpisode, next } }
 *
 * Situs ini TIDAK memakai Cloudflare Managed Challenge, jadi cukup axios +
 * cheerio (tanpa worker/browser).
 *
 * Struktur DOM (WordPress, tema Otakudesu):
 *   listing  : .venz .detpost → .jdlflm, .epz, .epztipe, .newnime, .thumbz img
 *   detail   : h1 (polos), .fotoanime img, .infozingle p, .sinopc p, .episodelist li a
 *   episode  : h1.posttl, .responsive-embed iframe, select.mirror option,
 *              .flir a, .download ul li
 *   search   : ul.chivsrc li → img + h2 a
 *   jadwal   : .kglist321 → h2 (hari) + ul li a
 * =====================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");

const OTAKU_BASE_URL = process.env.OTAKUDESU_BASE_URL || "https://otakudesu.blog";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const axiosOtaku = axios.create({
  timeout: 20000,
  maxRedirects: 3,
  headers: {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  },
});

const CHALLENGE_RE =
  /Just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies|SITUS DIBLOKIR|Trustpositif/i;

async function fetchOtaku(path, retries = 2) {
  const url = path.startsWith("http")
    ? path
    : `${OTAKU_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  try {
    const res = await axiosOtaku.get(url, {
      headers: { "User-Agent": randomUA(), Referer: OTAKU_BASE_URL + "/" },
    });
    if (typeof res.data === "string" && CHALLENGE_RE.test(res.data)) {
      throw new Error("Cloudflare challenge terdeteksi");
    }
    return { res, url };
  } catch (err) {
    if (retries <= 0) throw err;
    const delay = err.response?.status === 403 ? 1500 : 600;
    await sleep(delay);
    return fetchOtaku(path, retries - 1);
  }
}

// Thumbnail otakudesu kadang relatif (/wp-content/...) — wajib diabsolutkan,
// kalau tidak browser resolve ke origin ryukomik dan gambarnya pecah.
function absoluteOtakuUrl(src, base = OTAKU_BASE_URL) {
  if (!src) return "";
  const clean = String(src).trim();
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean)) return clean;
  if (clean.startsWith("//")) return `https:${clean}`;
  return `${base}${clean.startsWith("/") ? "" : "/"}${clean}`;
}

// Slug = segmen terakhir URL (sama semantiknya dengan extractSlug() di animeid)
function extractSlug(href) {
  if (!href) return "";
  return String(href)
    .replace(/\/$/, "")
    .split("/")
    .filter(Boolean)
    .pop() || "";
}

// "Episode 12" / "12 Episode" / "Batch 1-12" → angka
function parseEpisodeNumber(text) {
  const m = String(text || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const HARI = ["senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu"];
const HARI_LABEL = {
  senin: "Senin",
  selasa: "Selasa",
  rabu: "Rabu",
  kamis: "Kamis",
  jumat: "Jumat",
  sabtu: "Sabtu",
  minggu: "Minggu",
};

// ─────────────────────────────────────────────────────────────────────────────
// LISTING PARSER (.venz .detpost) — dipakai ongoing & complete
// ─────────────────────────────────────────────────────────────────────────────
function parseOtakuListing($) {
  const items = [];
  const today = new Date();

  $(".venz .detpost").each((i, el) => {
    const thumbA = $(el).find(".thumb a").first();
    const href = thumbA.attr("href") || "";
    const img = $(el).find(".thumbz img").first();

    const title =
      $(el).find(".jdlflm").text().trim() || img.attr("alt") || thumbA.attr("title") || "";

    const thumbnail = absoluteOtakuUrl(
      img.attr("src") || img.attr("data-src") || img.attr("data-lazy-src") || ""
    );

    if (!href || !title) return;

    const epText = $(el).find(".epz").text().trim();
    const releaseDay = $(el).find(".epztipe").text().trim();

    items.push({
      title,
      thumbnail,
      slug: extractSlug(href),
      // animeid menyebut ini currentEpisode; di otakudesu = episode yang baru rilis
      currentEpisode: parseEpisodeNumber(epText),
      // otakudesu listing tidak menyediakan total episode
      totalEpisode: null,
      // animeid mengisi rarity & isHot; otakudesu tidak punya → null/false
      rarity: null,
      isHot: false,
      url: href.startsWith("http") ? href : `${OTAKU_BASE_URL}${href}`,
      // field tambahan khas otakudesu (tidak mengganggu frontend animeid)
      releaseDay: releaseDay || null,
      releaseDate: $(el).find(".newnime").text().trim() || null,
      episodeLabel: epText || null,
      updatedAt: today.toISOString(),
    });
  });

  return items;
}

function parseOtakuPagination($) {
  const pages = [];
  $(".pagination .pagenavix a.page-numbers, .pagination a.page-numbers").each((i, el) => {
    const n = parseInt($(el).text().trim(), 10);
    if (Number.isFinite(n)) pages.push(n);
  });
  const currentText = $(".pagination .page-numbers.current").first().text().trim();
  const currentPage = Number.isFinite(parseInt(currentText, 10)) ? parseInt(currentText, 10) : 1;
  const totalPages = pages.length ? Math.max(currentPage, ...pages) : currentPage;
  return { currentPage, totalPages, hasNext: currentPage < totalPages, hasPrev: currentPage > 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// ONGOING — bentuk mengikuti scrapeNontonAnimeOngoing():
//   { success, season{name,progress}, total, data[] }
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeOtakuOngoing(page = 1) {
  try {
    const path = page > 1 ? `/ongoing-anime/page/${page}/` : "/ongoing-anime/";
    const { res } = await fetchOtaku(path);
    const $ = cheerio.load(res.data);

    const items = parseOtakuListing($);
    const pag = parseOtakuPagination($);

    return {
      success: true,
      season: {
        // animeid menampilkan nama musim & progress; otakudesu tidak punya blok ini
        name: $(".venutama .title h1, .venz h1").first().text().trim() || "Ongoing Anime",
        progress: "",
      },
      total: items.length,
      page,
      totalPages: pag.totalPages,
      hasNext: pag.hasNext,
      hasPrev: pag.hasPrev,
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape ongoing: " + err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE — bungkus listing yang sama. Tidak ada padanan langsung di animeid,
// jadi bentuknya disamakan dengan ongoing agar frontend bisa pakai parser sama.
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeOtakuComplete(page = 1) {
  try {
    const path = page > 1 ? `/complete-anime/page/${page}/` : "/complete-anime/";
    const { res } = await fetchOtaku(path);
    const $ = cheerio.load(res.data);

    const items = parseOtakuListing($);
    const pag = parseOtakuPagination($);

    return {
      success: true,
      total: items.length,
      page,
      totalPages: pag.totalPages,
      hasNext: pag.hasNext,
      hasPrev: pag.hasPrev,
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape complete: " + err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TERBARU — bentuk mengikuti scrapeNontonAnimeTerbaru():
//   { success, total, data[{ title, thumbnail, slug, latestEpisode, url }] }
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeOtakuTerbaru() {
  try {
    const { res } = await fetchOtaku("/");
    const $ = cheerio.load(res.data);
    const items = [];

    // Otakudesu menaruh rilisan terbaru di blok rilisan terakhir / venz pertama.
    const containers = $(".venz .detpost, .rseries .rapi .venz .detpost");
    const seen = new Set();

    containers.each((i, el) => {
      const thumbA = $(el).find(".thumb a").first();
      const href = thumbA.attr("href") || "";
      const img = $(el).find(".thumbz img").first();
      const slug = extractSlug(href);
      if (!href || !slug || seen.has(slug)) return;
      seen.add(slug);

      const epText = $(el).find(".epz").text().trim();

      items.push({
        title: $(el).find(".jdlflm").text().trim() || img.attr("alt") || "",
        thumbnail: absoluteOtakuUrl(
          img.attr("src") || img.attr("data-src") || img.attr("data-lazy-src") || ""
        ),
        slug,
        latestEpisode: parseEpisodeNumber(epText),
        url: href.startsWith("http") ? href : `${OTAKU_BASE_URL}${href}`,
      });
    });

    return { success: true, total: items.length, data: items };
  } catch (err) {
    return { success: false, message: "Gagal scrape terbaru: " + err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JADWAL — bentuk mengikuti scrapeNontonAnimeJadwal():
//   { success, activeDay, data{ senin..minggu: [{title,thumbnail,slug,status,
//      rating,type,episodes,releaseTime}] } }
// ─────────────────────────────────────────────────────────────────────────────
// Halaman /jadwal-rilis/ Otakudesu HANYA berisi teks — tidak ada cover anime
// sama sekali (8 <img> di sana cuma logo situs). Jadi cover harus diambil dari
// listing ongoing+complete lalu di-match lewat slug.
// Terbukti 58/58 cocok. Hasil match disimpan di cache agar tidak scrape 12
// halaman setiap request.
// ─────────────────────────────────────────────────────────────────────────────

let otakuCoverMapMem = { map: null, expiresAt: 0 };
const OTAKU_COVER_TTL_MS = 6 * 60 * 60 * 1000; // 6 jam

async function buildOtakuCoverMap() {
  if (otakuCoverMapMem.map && otakuCoverMapMem.expiresAt > Date.now()) {
    return otakuCoverMapMem.map;
  }

  const map = {};
  const sources = [
    { path: "/ongoing-anime", pages: 4 },
    { path: "/complete-anime", pages: 8 },
  ];

  for (const src of sources) {
    for (let p = 1; p <= src.pages; p++) {
      const path = p === 1 ? `${src.path}/` : `${src.path}/page/${p}/`;
      try {
        const { res } = await fetchOtaku(path);
        const $ = cheerio.load(res.data);
        $(".venz .detpost").each((i, el) => {
          const href = $(el).find(".thumb a").first().attr("href") || "";
          const slug = extractSlug(href);
          const img = $(el).find(".thumbz img").first();
          const src2 = img.attr("src") || img.attr("data-src") || img.attr("data-lazy-src") || "";
          if (slug && src2 && !map[slug]) {
            map[slug] = absoluteOtakuUrl(src2);
          }
        });
      } catch (_) {
        // lewati halaman yang gagal — map tetap dipakai dengan hasil yang ada
      }
    }
  }

  otakuCoverMapMem = { map, expiresAt: Date.now() + OTAKU_COVER_TTL_MS };
  console.log(`[Otakudesu] cover map dibangun: ${Object.keys(map).length} entri`);
  return map;
}

async function scrapeOtakuJadwal() {
  try {
    const { res } = await fetchOtaku("/jadwal-rilis/");
    const $ = cheerio.load(res.data);

    const jadwal = {};
    HARI.forEach((h) => (jadwal[h] = []));

    $(".kglist321").each((i, block) => {
      const rawDay = $(block).find("h2").first().text().trim();
      const key = rawDay.toLowerCase();
      if (!HARI.includes(key)) return; // hari "Random" dll diabaikan agar sama dgn animeid

      $(block)
        .find("ul li a")
        .each((j, el) => {
          const href = $(el).attr("href") || "";
          if (!href) return;
          jadwal[key].push({
            title: $(el).text().trim(),
            thumbnail: "", // diisi di bawah dari cover map
            slug: extractSlug(href),
            status: "on-schedule",
            rating: "",
            type: "",
            episodes: "",
            releaseTime: "",
            url: href.startsWith("http") ? href : `${OTAKU_BASE_URL}${href}`,
          });
        });
    });

    // Lengkapi thumbnail dari listing (halaman jadwal sendiri tidak punya cover).
    try {
      const covers = await buildOtakuCoverMap();
      let filled = 0;
      HARI.forEach((h) => {
        jadwal[h].forEach((item) => {
          if (covers[item.slug]) {
            item.thumbnail = covers[item.slug];
            filled++;
          }
        });
      });
      console.log(`[Otakudesu] jadwal: ${filled} cover terisi dari ${Object.keys(covers).length} map`);
    } catch (err) {
      console.warn(`[Otakudesu] gagal melengkapi cover jadwal: ${err.message}`);
    }

    return { success: true, activeDay: "senin", data: jadwal };
  } catch (err) {
    return { success: false, message: "Gagal scrape jadwal: " + err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH — bentuk mengikuti scrapeNontonAnimeSearchPaged():
//   { success, query, page, totalPages, totalResults, hasNext, hasPrev, data[] }
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeOtakuSearch(query, page = 1) {
  try {
    const q = String(query || "").trim();
    if (!q) return { success: false, message: "Query kosong", data: [] };

    const { res } = await fetchOtaku(`/?s=${encodeURIComponent(q)}&post_type=anime`);
    const $ = cheerio.load(res.data);

    const items = [];
    $("ul.chivsrc li").each((i, el) => {
      const img = $(el).find("img").first();
      const a = $(el).find("h2 a").first();
      const href = a.attr("href") || "";
      if (!href) return;

      // otakudesu search hanya menyediakan Genres / Status / Rating.
      // animeid menaruh "Season" di field `season`, tapi otakudesu tidak punya
      // season sama sekali — jadi `season` dibiarkan null dan Status ditaruh
      // di field `status` (jangan campur, maknanya beda).
      let rating = null;
      let type = null;
      let status = null;
      const genres = [];
      $(el)
        .find(".set")
        .each((j, s) => {
          const t = $(s).text().trim();
          if (/^rating|^skor/i.test(t)) {
            rating = t.replace(/^(rating|skor)\s*:\s*/i, "").trim();
          } else if (/^tipe/i.test(t)) {
            type = t.replace(/^tipe\s*:\s*/i, "").trim();
          } else if (/^status/i.test(t)) {
            status = t.replace(/^status\s*:\s*/i, "").trim();
          } else if (/^genres?/i.test(t)) {
            t.replace(/^genres?\s*:\s*/i, "")
              .split(",")
              .map((g) => g.trim())
              .filter(Boolean)
              .forEach((g) => genres.push(g));
          }
        });

      items.push({
        title: a.text().trim() || img.attr("alt") || "",
        thumbnail: absoluteOtakuUrl(img.attr("src") || img.attr("data-src") || ""),
        slug: extractSlug(href),
        url: href.startsWith("http") ? href : `${OTAKU_BASE_URL}${href}`,
        rating: rating || null,
        type: type || null,
        // otakudesu tidak punya data Season → null (bukan Status)
        season: null,
        status: status || null,
        synopsis: "",
        genres,
      });
    });

    // otakudesu search tidak mem-paginate; samakan bentuknya dengan animeid
    const totalPages = 1;

    return {
      success: true,
      query: q,
      page: parseInt(page, 10) || 1,
      totalPages,
      totalResults: items.length,
      hasNext: false,
      hasPrev: false,
      total: items.length,
      data: items,
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape search: " + err.message, data: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL — bentuk mengikuti scrapeNontonAnimeDetail():
//   { success, data{ title, thumbnail, score, type, trailerUrl, details, genres,
//     synopsis, status, episodes, duration, season{name,slug},
//     firstEpisode{label,title,slug}, lastEpisode{...}, episodeList[] } }
// episodeList item: { title, date, slug, source, isGuessed? }
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeOtakuDetail(slug) {
  try {
    const clean = String(slug).trim().replace(/^\/|\/$/g, "");
    const path = clean.startsWith("anime/") ? `/${clean}/` : `/anime/${clean}/`;
    const { res } = await fetchOtaku(path);
    const $ = cheerio.load(res.data);

    // Slug yang tidak ada di otakudesu.blog akan di-redirect ke otakudesu.io
    // (halaman "Otakudesu Official") yang tetap HTTP 200 tapi tanpa konten seri.
    // Tanpa guard ini, scraper akan salah lapor success:true dengan data kosong.
    const hasSeriesDom = $(".fotoanime").length > 0 || $(".infozingle").length > 0;
    if (!hasSeriesDom) {
      return {
        success: false,
        message: "Halaman seri tidak ditemukan (slug salah atau di-redirect ke situs lain)",
      };
    }

    // ── THUMBNAIL ──
    const foto = $(".fotoanime img").first();
    const thumbnail = absoluteOtakuUrl(
      foto.attr("src") || foto.attr("data-src") || foto.attr("data-lazy-src") || ""
    );

    // ── JUDUL (h1 polos; buang span ikon view di float:right) ──
    const title = $("h1")
      .first()
      .clone()
      .children("span")
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    // ── DETAILS (label: value) ──
    // HTML asli: <p><span><b>Skor</b>: 7.44</span></p>
    // Jadi <b> HANYA berisi label, dan nilainya ada di luar <b> tapi di dalam
    // <span>. Karena itu `.children("b")` tidak cukup — <b> harus dibuang dari
    // seluruh subtree, kalau tidak nilainya jadi "Skor: 7.44" (label ikut terbawa).
    const details = {};
    $(".infozingle p").each((i, el) => {
      const label = $(el).find("b").first().text().replace(/:/g, "").trim();
      const clone = $(el).clone();
      clone.find("b").remove();
      const value = clone.text().replace(/^\s*:\s*/, "").replace(/\s+/g, " ").trim();
      if (label) details[label] = value;
    });

    // Lookup tahan-kapitalisasi: "total episode" / "Total Episode" / "TOTAL EPISODE"
    const detailGet = (key) => {
      const want = String(key).toLowerCase();
      for (const [k, v] of Object.entries(details)) {
        if (k.toLowerCase() === want) return v;
      }
      return "";
    };

    // ── GENRES ──
    // Frontend animeid membaca `genre.name` dan `genre.slug`
    // (lihat DetailClient.tsx: data.genres?.map((genre) => genre.name / genre.slug)),
    // jadi WAJIB array objek { name, slug } — bukan array string.
    const genres = [];
    $(".infozingle p a[href*='/genres/']").each((i, el) => {
      const name = $(el).text().trim();
      if (!name) return;
      genres.push({
        name,
        slug: extractSlug($(el).attr("href") || ""),
      });
    });

    // ── SINOPSIS ──
    let synopsis = $(".sinopc p")
      .map((i, el) => $(el).text().trim())
      .get()
      .filter(Boolean)
      .join("\n\n");
    if (!synopsis) synopsis = $(".sinopc").first().text().replace(/\s+/g, " ").trim();
    if (!synopsis) {
      synopsis = ($("meta[name='description']").attr("content") || "").trim();
    }

    // ── SKOR / TIPE / STATUS / EPISODES / DURASI (dari details, tahan-kapitalisasi) ──
    const score = detailGet("skor");
    const type = detailGet("tipe");
    const status = detailGet("status");
    const episodes = detailGet("total episode");
    const duration = detailGet("durasi");
    const seasonName = detailGet("musim");
    const studio = detailGet("studio");

    // ── EPISODE LIST → { title, date, slug, source } ──
    // PENTING: halaman detail punya TIGA blok .episodelist:
    //   1) "<Judul> Batch"      → 1 <li> (link batch, BUKAN episode)
    //   2) "<Judul> Episode List" → N <li> (episode sebenarnya)
    //   3) "<Judul> Lengkap"    → 1 <li> (link semua episode, BUKAN episode)
    // Mengambil semua blok membuat batch & lengkap ikut terhitung sebagai
    // episode (mis. 12 episode jadi 14, dan "Lengkap" salah dapat ep=1).
    // Karena itu: pilih blok yang judulnya mengandung "episode list".
    const episodeList = [];
    let episodeBlock = null;

    $(".episodelist").each((i, block) => {
      const heading = $(block).find(".monktit").first().text().trim();
      if (/episode\s*list/i.test(heading)) {
        episodeBlock = $(block);
        return false; // sudah ketemu, stop
      }
    });

    // Fallback: kalau tidak ada blok berjudul "Episode List", pilih blok dengan
    // <li> TERBANYAK (batch/lengkap selalu cuma 1 <li>).
    if (!episodeBlock || episodeBlock.find("ul li").length === 0) {
      let maxCount = -1;
      $(".episodelist").each((i, block) => {
        const n = $(block).find("ul li").length;
        if (n > maxCount) {
          maxCount = n;
          episodeBlock = $(block);
        }
      });
    }

    if (episodeBlock) {
      episodeBlock.find("ul li").each((i, el) => {
        const a = $(el).find("a").first();
        const href = a.attr("href") || "";
        if (!href) return;
        // Buang link batch/all-episode yang nyasar: href-nya bukan /episode/.
        if (!/\/episode\//i.test(href)) return;

        const epTitle = a.text().trim();
        if (/\[batch\]|batch\s*\d|\bbatch\b/i.test(epTitle)) return;

        episodeList.push({
          title: epTitle,
          date: $(el).find(".zeebr").text().trim() || "",
          slug: extractSlug(href),
          url: href.startsWith("http") ? href : `${OTAKU_BASE_URL}${href}`,
          episode: parseEpisodeNumber(epTitle),
          source: "html",
        });
      });
    }

    // animeid mengembalikan episodeList terbaru → terlama (reverse).
    // Di otakudesu .episodelist urutannya juga terbaru dulu, jadi dipertahankan.
    const firstEpisode = episodeList.length ? episodeList[episodeList.length - 1] : null;
    const lastEpisode = episodeList.length ? episodeList[0] : null;

    return {
      success: true,
      data: {
        title,
        thumbnail,
        score,
        type,
        trailerUrl: "",
        details,
        genres,
        synopsis,
        status,
        episodes,
        duration,
        // Field yang dibaca frontend animeid tapi di situs hanya ada di `.details`:
        // DetailClient memakai data.totalEpisode & data.studio secara langsung.
        totalEpisode: detailGet("total episode"),
        studio,
        season: {
          name: seasonName,
          slug: extractSlug(seasonName),
        },
        firstEpisode: firstEpisode
          ? { label: "Episode 1", title: firstEpisode.title, slug: firstEpisode.slug }
          : null,
        lastEpisode: lastEpisode
          ? { label: lastEpisode.title, title: lastEpisode.title, slug: lastEpisode.slug }
          : null,
        episodeList,

        // ── tambahan khas otakudesu (tidak dipakai frontend animeid) ──
        totalEpisodesListed: episodeList.length,
        episodeListAsc: [...episodeList].reverse(),
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape: " + err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER MIRRORS (admin-ajax.php)
// ─────────────────────────────────────────────────────────────────────────────
// Otakudesu TIDAK menaruh iframe server di HTML. Yang ada hanya daftar mirror:
//   <ul class="m360p"><li><a data-content="<base64 {id,i,q}>">filedon</a></li>…</ul>
// Untuk mendapat iframe-nya butuh 2 langkah AJAX ke wp-admin/admin-ajax.php:
//   1) action "aa12…"            → dapat nonce
//   2) {...payload, nonce, action "2a35…"} → dapat HTML iframe (base64)
// Action-nya di-generate per-halaman, jadi WAJIB di-parse dari HTML, bukan di-hardcode.
// ─────────────────────────────────────────────────────────────────────────────

function extractOtakuNonceActions(html) {
  const nonceAction = (html.match(/data:\{action:"([a-f0-9]{20,})"\}/) || [])[1] || null;
  const playerAction =
    (html.match(/nonce:window\.__x__nonce,action:"([a-f0-9]{20,})"/) || [])[1] || null;
  return { nonceAction, playerAction };
}

// Kumpulkan daftar mirror dari .mirrorstream: [{ quality, provider, content }]
function parseOtakuMirrors($) {
  const mirrors = [];
  $(".mirrorstream ul").each((i, ul) => {
    const cls = $(ul).attr("class") || "";
    const quality = (cls.match(/m(\d+p)/) || [])[1] || "";
    $(ul)
      .find("li a[data-content]")
      .each((j, a) => {
        mirrors.push({
          quality,
          provider: $(a).text().trim(),
          content: $(a).attr("data-content") || "",
        });
      });
  });
  return mirrors;
}

async function scrapeOtakuPlayers(episodeUrl, html, $) {
  const mirrors = parseOtakuMirrors($);
  if (mirrors.length === 0) return [];

  const { nonceAction, playerAction } = extractOtakuNonceActions(html);
  if (!nonceAction || !playerAction) return [];

  const jar = {};
  const client = axios.create({
    timeout: 20000,
    headers: {
      "User-Agent": randomUA(),
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      Referer: episodeUrl,
      Origin: OTAKU_BASE_URL,
    },
  });
  // Simpan & kirim cookie antar request — admin-ajax butuh sesi yang konsisten.
  client.interceptors.response.use((r) => {
    const sc = r.headers["set-cookie"];
    if (sc) {
      sc.forEach((c) => {
        const [kv] = c.split(";");
        const i = kv.indexOf("=");
        if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1);
      });
    }
    return r;
  });
  client.interceptors.request.use((c) => {
    const ck = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (ck) c.headers.Cookie = ck;
    c.headers["X-Requested-With"] = "XMLHttpRequest";
    c.headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    return c;
  });

  const ajaxUrl = `${OTAKU_BASE_URL}/wp-admin/admin-ajax.php`;
  const form = (obj) =>
    Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

  // Langkah 1: nonce
  let nonce = "";
  try {
    const r = await client.post(ajaxUrl, form({ action: nonceAction }));
    nonce = typeof r.data?.data === "string" ? r.data.data : String(r.data?.data || "");
  } catch (_) {
    return [];
  }

  // Langkah 2: ambil iframe tiap mirror (paralel, dibatasi)
  const players = await Promise.all(
    mirrors.map(async (m) => {
      try {
        const payload = JSON.parse(Buffer.from(m.content, "base64").toString("utf8"));
        const r = await client.post(
          ajaxUrl,
          form({ ...payload, nonce, action: playerAction })
        );
        let iframeHtml = "";
        const raw = r.data?.data;
        try {
          iframeHtml = Buffer.from(String(raw || ""), "base64").toString("utf8");
        } catch (_) {
          iframeHtml = String(raw || "");
        }
        const src = (iframeHtml.match(/src=["']([^"']+)/) || [])[1] || "";
        if (!src) return null;
        return {
          name: m.quality ? `${m.quality} ${m.provider}` : m.provider,
          iframe: src,
          quality: m.quality,
          provider: m.provider,
        };
      } catch (_) {
        return null;
      }
    })
  );

  return players.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// EPISODE — bentuk mengikuti scrapeNontonAnimeEpisode():
//   { success, data{ entryTitle, author, date{raw,formatted}, title, thumbnail,
//     players[{name,iframe}], downloads[{name,url}], prev, allEpisode, next } }
// prev/next/allEpisode = SLUG (string), bukan objek.
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeOtakuEpisode(slug) {
  try {
    const clean = String(slug).trim().replace(/^\/|\/$/g, "");
    const path = clean.startsWith("episode/") ? `/${clean}/` : `/episode/${clean}/`;
    const { res } = await fetchOtaku(path);
    const $ = cheerio.load(res.data);

    // Guard sama seperti detail: slug bohong akan redirect ke otakudesu.io
    // dan tetap HTTP 200 tanpa DOM episode.
    const hasEpisodeDom =
      $(".responsive-embed iframe, #embed_holder iframe, iframe.metaframe").length > 0 ||
      $("select.mirror option").length > 0 ||
      $("h1.posttl").length > 0;
    if (!hasEpisodeDom) {
      return {
        success: false,
        message: "Halaman episode tidak ditemukan (slug salah atau di-redirect ke situs lain)",
      };
    }

    const pageTitle = $("title").text().split("|")[0].trim();
    const entryTitle = $("h1.posttl").first().text().replace(/\s+/g, " ").trim() || pageTitle;

    // ── THUMBNAIL (og:image) ──
    const thumbnail = absoluteOtakuUrl($("meta[property='og:image']").attr("content") || "");

    // ── PLAYERS → [{ name, iframe }] ──
    // Ambil SEMUA server mirror (360p/480p/720p × filedon/vidhide/mega/blogs/…)
    // lewat admin-ajax.php, bukan cuma iframe pertama di HTML.
    let players = [];
    try {
      players = await scrapeOtakuPlayers(res.config?.url || path, res.data, $);
    } catch (_) {
      players = [];
    }

    // Fallback: kalau AJAX gagal, pakai iframe yang memang ada di HTML.
    if (players.length === 0) {
      const pushPlayer = (label, src) => {
        if (!src) return;
        players.push({ name: label, iframe: src });
      };
      $(".responsive-embed iframe, #embed_holder iframe, iframe.metaframe").each((i, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src") || "";
        pushPlayer(players.length === 0 ? "Default" : `Mirror ${players.length + 1}`, src);
      });
      if (players.length === 0) {
        $("iframe").each((i, el) => {
          const src = $(el).attr("src") || "";
          if (!src || /google|analytics|doubleclick|googletagmanager/i.test(src)) return;
          pushPlayer("Default", src);
        });
      }
    }

    // ── DOWNLOADS → [{ name, url }] ──
    const downloads = [];
    $(".download ul li").each((i, el) => {
      const quality = $(el).find("strong").first().text().trim();
      $(el)
        .find("a")
        .each((j, a) => {
          const href = $(a).attr("href") || "";
          const label = $(a).text().trim();
          if (!href) return;
          downloads.push({
            name: quality ? `${quality} - ${label}` : label,
            url: href,
          });
        });
    });

    // ── EPISODE LIST (dari <option>) untuk allEpisode ──
    const episodeOptions = [];
    $("select.mirror option, select option").each((i, el) => {
      const val = $(el).attr("value") || "";
      const label = $(el).text().trim();
      if (!val || !label || /pilih episode|select/i.test(label)) return;
      episodeOptions.push({ label, slug: extractSlug(val) });
    });

    // ── PREV / NEXT / ALL EPISODE → slug string ──
    let prev = "";
    let next = "";
    let allEpisode = "";

    $(".flir a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const label = $(el).text().trim();
      const titleAttr = ($(el).attr("title") || "").trim();
      if (!href) return;

      // "See All Episodes" mengarah ke halaman seri (/anime/), bukan episode.
      if (/see all episodes|lihat semua/i.test(label) || /\/anime\//.test(href)) {
        allEpisode = extractSlug(href);
        return;
      }
      if (/previous|sebelumnya/i.test(label) || /previous|sebelumnya/i.test(titleAttr)) {
        prev = extractSlug(href);
        return;
      }
      if (/next|selanjutnya/i.test(label) || /next|selanjutnya/i.test(titleAttr)) {
        next = extractSlug(href);
      }
    });

    // Fallback allEpisode: ambil dari daftar seri bila .flir tidak menyediakannya
    if (!allEpisode && episodeOptions.length === 0) {
      const seriesHref = $(".flir a[href*='/anime/']").attr("href") || "";
      allEpisode = extractSlug(seriesHref);
    }

    // animeid memakai <time class="updated"> untuk tanggal episode.
    const rawDate =
      $("time.updated").attr("datetime") ||
      $(".updated").attr("datetime") ||
      "";

    return {
      success: true,
      data: {
        entryTitle,
        author: $(".entry-author b").text().trim() || "Otakudesu",
        date: {
          raw: rawDate,
          formatted: $("time.updated").text().trim() || $(".updated").text().trim() || "",
        },
        title: entryTitle,
        thumbnail,
        players,
        downloads,
        prev,
        allEpisode,
        next,

        // ── tambahan khas otakudesu (tidak dipakai frontend animeid) ──
        episodeList: episodeOptions,
        navigation: {
          prev: prev ? { slug: prev, url: `${OTAKU_BASE_URL}/episode/${prev}/` } : null,
          next: next ? { slug: next, url: `${OTAKU_BASE_URL}/episode/${next}/` } : null,
          allEpisode: episodeOptions,
        },
      },
    };
  } catch (err) {
    return { success: false, message: "Gagal scrape: " + err.message };
  }
}

module.exports = function registerOtakudesuRoutes(app, deps = {}) {
  const getCache = deps.getCache || (() => null);
  const setCache = deps.setCache || (() => {});

  // ── Handler bersama: dipakai oleh /otakudesu/* DAN alias /animeid2/* ──
  // Supaya bentuk respons dijamin identik (satu sumber kebenaran).
  async function handleOngoing(req, res) {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `otaku_ongoing_p${page}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const result = await scrapeOtakuOngoing(page);
    if (result.success) setCache(cacheKey, result, 300);
    res.json(result);
  }

  async function handleComplete(req, res) {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `otaku_complete_p${page}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const result = await scrapeOtakuComplete(page);
    if (result.success) setCache(cacheKey, result, 1800);
    res.json(result);
  }

  async function handleTerbaru(req, res) {
    const cached = getCache("otaku_terbaru");
    if (cached) return res.json(cached);
    const result = await scrapeOtakuTerbaru();
    if (result.success) setCache("otaku_terbaru", result, 120);
    res.json(result);
  }

  async function handleJadwal(req, res) {
    const cached = getCache("otaku_jadwal");
    if (cached) return res.json(cached);
    const result = await scrapeOtakuJadwal();
    if (result.success) setCache("otaku_jadwal", result, 3600);
    res.json(result);
  }

  async function handleJadwalHari(req, res) {
    const hari = String(req.params.hari || "").toLowerCase();
    if (!HARI.includes(hari)) {
      return res.status(400).json({
        success: false,
        message: `Hari tidak valid. Pilihan: ${HARI.join(", ")}`,
      });
    }
    const cacheKey = `otaku_jadwal_${hari}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const full = await scrapeOtakuJadwal();
    if (!full.success) return res.json(full);

    const result = { success: true, day: HARI_LABEL[hari], data: full.data[hari] || [] };
    setCache(cacheKey, result, 3600);
    res.json(result);
  }

  async function handleSearch(req, res) {
    const q = req.query.q || req.query.s;
    if (!q || String(q).trim().length < 2) {
      return res
        .status(400)
        .json({ success: false, message: "Parameter 'q' minimal 2 karakter" });
    }
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `otaku_search_${String(q).toLowerCase().replace(/\s+/g, "_")}_p${page}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const result = await scrapeOtakuSearch(q, page);
    if (result.success && result.totalResults > 0) setCache(cacheKey, result, 600);
    res.json(result);
  }

  async function handleDetail(req, res) {
    const slug = req.params[0] || req.params.slug;
    if (!slug) return res.status(400).json({ success: false, message: "Slug diperlukan" });
    const cacheKey = `otaku_detail_${slug}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const result = await scrapeOtakuDetail(slug);
    if (result.success) setCache(cacheKey, result, 3600);
    res.json(result);
  }

  // Hangatkan cache resolve saat halaman episode dibuka, supaya klik server
  // pertama langsung tersaji (provider non-UA-sensitive saja; lihat
  // preResolveStream di stream-resolver.js).
  function preResolveEpisodePlayers(result, req) {
    try {
      if (!result || !result.success || !result.data || !Array.isArray(result.data.players)) return;
      const resolver = require("./stream-resolver");
      if (typeof resolver.preResolveStream !== "function") return;
      const ua = req && req.get ? req.get("user-agent") : null;
      for (const p of result.data.players.slice(0, 4)) {
        if (p && typeof p.iframe === "string" && p.iframe.startsWith("http")) {
          Promise.resolve(resolver.preResolveStream(p.iframe, ua)).catch(() => {});
        }
      }
    } catch (_) {
      /* pre-resolve terbaik saja */
    }
  }

  async function handleEpisode(req, res) {
    const slug = req.params[0] || req.params.slug;
    if (!slug) return res.status(400).json({ success: false, message: "Slug diperlukan" });
    const cacheKey = `otaku_episode_${slug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      preResolveEpisodePlayers(cached, req);
      return res.json(cached);
    }
    const result = await scrapeOtakuEpisode(slug);
    if (result.success) setCache(cacheKey, result, 1800);
    preResolveEpisodePlayers(result, req);
    res.json(result);
  }

  // ── ROUTE UTAMA (otakudesu/*) ──
  app.get("/otakudesu/ongoing", handleOngoing);
  app.get("/otakudesu/complete", handleComplete);
  app.get("/otakudesu/terbaru", handleTerbaru);
  app.get("/otakudesu/jadwal", handleJadwal);
  app.get("/otakudesu/jadwal/:hari", handleJadwalHari);
  app.get("/otakudesu/search", handleSearch);
  app.get(/^\/otakudesu\/detail\/(.+)/, handleDetail);
  app.get(/^\/otakudesu\/episode\/(.+)/, handleEpisode);

  // ───────────────────────────────────────────────────────────────────────────
  // ALIAS /animeid2/* — respons 100% identik animeid/* (nama field sama persis),
  // supaya frontend cukup menukar prefix URL tanpa mengubah parsing.
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/animeid2/ongoing", handleOngoing);
  app.get("/animeid2/terbaru", handleTerbaru);
  app.get("/animeid2/jadwal", handleJadwal);
  app.get("/animeid2/jadwal/:hari", handleJadwalHari);
  app.get("/animeid2/search", handleSearch);
  app.get(/^\/animeid2\/detail\/(.+)/, handleDetail);
  app.get(/^\/animeid2\/episode\/(.+)/, handleEpisode);

  // ───────────────────────────────────────────────────────────────────────────
  // TAKEOVER /animeid/* — scraper animeid asli sudah MATI (Cloudflare Managed
  // Challenge, upstream selalu 403). Karena itu prefix /animeid/* dialihkan ke
  // otakudesu supaya frontend TIDAK perlu diubah sama sekali.
  //
  // Dikontrol env OTAKUDESU_TAKEOVER_ANIMEID (default: "1" = aktif).
  // Set "0" untuk mengembalikan perilaku lama tanpa mengubah kode.
  // Route animeid lama tetap tersedia di /animeid-old/* untuk debugging.
  // ───────────────────────────────────────────────────────────────────────────
  const takeover =
    String(process.env.OTAKUDESU_TAKEOVER_ANIMEID || "1").trim() !== "0";

  if (takeover) {
    console.log("🔁 /animeid/* dialihkan ke Otakudesu (scraper animeid mati/403)");
    app.get("/animeid/ongoing", handleOngoing);
    app.get("/animeid/terbaru", handleTerbaru);
    app.get("/animeid/jadwal", handleJadwal);
    app.get("/animeid/jadwal/:hari", handleJadwalHari);
    app.get("/animeid/search", handleSearch);
    app.get(/^\/animeid\/detail\/(.+)/, handleDetail);
    app.get(/^\/animeid\/episode\/(.+)/, handleEpisode);
  }
};

module.exports.scrapers = {
  scrapeOtakuOngoing,
  scrapeOtakuComplete,
  scrapeOtakuTerbaru,
  scrapeOtakuJadwal,
  scrapeOtakuSearch,
  scrapeOtakuDetail,
  scrapeOtakuEpisode,
};
