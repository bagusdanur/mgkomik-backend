"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const BASE = "https://mgread.io";
const KEY_ENDPOINT = `${BASE}/wp-json/initmanga/v1/chapter-key`;
const IMAGE_HOSTS = new Set(["mgread.io", "www.mgread.io", "mg.mgread.io"]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36";
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const normalizedTitle = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function matchesSearch(title, query) {
  const candidate = normalizedTitle(title), wanted = normalizedTitle(query);
  if (!candidate || !wanted) return false;
  if (candidate.includes(wanted) || wanted.includes(candidate)) return true;
  const ignored = new Set(["the", "and", "for", "with", "from"]);
  const terms = wanted.split(" ").filter((term) => term.length >= 2 && !ignored.has(term));
  const words = new Set(candidate.split(" "));
  const matched = terms.filter((term) => words.has(term)).length;
  return matched >= Math.max(1, Math.ceil(terms.length * 0.6));
}
function searchFallbacks(query) {
  const terms = normalizedTitle(query).split(" ").filter(Boolean);
  const candidates = [clean(query)];
  // MGRead's WordPress search is literal. Gradually trim the least-important
  // trailing term so small suffix/romanisation typos (Ing vs Ying) still find
  // the correct series, while matchesSearch guards against unrelated cards.
  while (terms.length > 2) {
    terms.pop();
    candidates.push(terms.join(" "));
  }
  return [...new Set(candidates)];
}
const absolute = (v) => { try { return new URL(clean(v), BASE).href; } catch { return ""; } };
const slugFrom = (v) => { try { const p = new URL(v, BASE).pathname.split("/").filter(Boolean); return p[p.indexOf("manga") + 1] || ""; } catch { return ""; } };
async function html(path) { return (await axios.get(path.startsWith("http") ? path : BASE + path, { timeout: 30000, headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" } })).data; }

function parseCards(body) {
  const $ = cheerio.load(body), out = [], seen = new Set();
  $("a[href*='/manga/']").each((_, el) => {
    const a = $(el), link = absolute(a.attr("href")), slug = slugFrom(link);
    if (!slug || /\/chapter-/.test(link) || seen.has(slug)) return;
    const box = a.closest("article,.uk-card,.manga-item,.item,.row");
    const imageEl = (box.length ? box : a).find("img").first();
    const title = clean(a.attr("title") || imageEl.attr("alt") || (box.length ? box.find("h2,h3,h4").first().text() : a.text())).replace(/^Illustration:\s*/i, "");
    if (!title) return;
    seen.add(slug);
    out.push({ source: "mgread", title, slug, image: absolute(imageEl.attr("data-src") || imageEl.attr("src")), detail_link: `${BASE}/manga/${slug}/`, description: "", type_genre: "comic", info: "", chapter_awal: "", chapter_terbaru: "", chapters: [] });
  });
  return out;
}

async function getDetail(slug) {
  const first = await html(`/manga/${encodeURIComponent(slug)}/`);
  const $ = cheerio.load(first), chapters = [], seen = new Set();
  const collect = (body) => {
    const page = body === first ? $ : cheerio.load(body);
    page(".chapter-list a[href*='/chapter-'], a[href*='/chapter-']").each((_, el) => {
      const link = absolute(page(el).attr("href")), chapterSlug = link.split("/").filter(Boolean).pop();
      if (!chapterSlug || seen.has(chapterSlug)) return;
      seen.add(chapterSlug);
      const chapterNumber = chapterSlug.match(/^chapter-([\d.]+)$/i)?.[1];
      const title = chapterNumber ? `Chapter ${chapterNumber}` : (clean(page(el).find(".chapter-title,.uk-text-bold").first().text() || page(el).text()) || chapterSlug);
      chapters.push({ title, slug: chapterSlug, link: `chapter/${slug}/${chapterSlug}`, date: clean(page(el).find("time,.chapter-date").text()), time: "", locked: false });
    });
  };
  collect(first);
  // The detail page paginates its chapter list (~24/page, `…/chapter/page/2/`)
  // and its widget only prints a few page numbers (1,2,3,…,last), so build the
  // full 2..last range instead of following the listed links — parsing page 1
  // alone silently drops the oldest chapters.
  const pageNumbers = (first.match(/\/chapter\/page\/(\d+)\//g) || []).map((v) => Number(v.match(/page\/(\d+)/)?.[1])).filter(Number.isFinite);
  const lastPage = Math.min(Math.max(1, ...pageNumbers), 200);
  const rest = [];
  for (let page = 2; page <= lastPage; page += 1) rest.push(page);
  for (let i = 0; i < rest.length; i += 8) {
    const bodies = await Promise.all(rest.slice(i, i + 8).map((page) => html(`/manga/${encodeURIComponent(slug)}/chapter/page/${page}/`).catch(() => "")));
    bodies.forEach((body) => { if (body) collect(body); });
  }
  const numberOf = (chapter) => Number(chapter.slug.match(/chapter-([\d.]+)/i)?.[1]) || 0;
  chapters.sort((a, b) => numberOf(b) - numberOf(a));
  const ld = $("script[type='application/ld+json']").map((_, e) => { try { return JSON.parse($(e).html()); } catch { return null; } }).get().find(x => x && (x.name || x['@type']));
  const image = absolute($("meta[property='og:image']").attr("content"));
  return { success: true, source: "mgread.io", data: { title: clean($("h1").first().text() || $("meta[property='og:title']").attr("content")), slug, thumbnail: image, image, type: "comic", status: "Unknown", Pengarang: "-", Umur: "-", Konsep: "-", artist: "-", genres: $("a[href*='/genre/']").map((_, e) => clean($(e).text())).get().filter(Boolean), synopsis: clean($("meta[name='description']").attr("content") || ld?.description), info: "", total_chapter: chapters.length, chapters } };
}

// MGRead's init-manga theme no longer prints the reader images into the page.
// Every chapter ships a skeleton loader plus `InitMangaEncryptedChapter`, an
// AES-256-CBC blob whose key is only handed out by the theme's REST route.
const ENCRYPTED_MARKER = "InitMangaEncryptedChapter=";
function encryptedPayload(body) {
  const at = body.indexOf(ENCRYPTED_MARKER);
  if (at === -1) return null;
  const start = body.indexOf("{", at);
  const end = body.indexOf("</script>", start);
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(body.slice(start, end).trim().replace(/;\s*$/, "")); } catch { return null; }
}

// First call returns 403 + challenge token, the retry carrying that token
// returns { key }. Verified server-side; no real browser click is required.
async function chapterKey(payload, nonce, referer) {
  let token = "", lastCode = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const headers = { "User-Agent": UA, "Content-Type": "application/json", Referer: referer };
    if (nonce) headers["X-WP-Nonce"] = nonce;
    const { data } = await axios.post(KEY_ENDPOINT, {
      chapter_id: payload.cid, epoch: payload.e, grant: payload.g,
      verdict: "pass", score: 0, codes: [], challenge_token: token,
    }, { timeout: 30000, headers, validateStatus: () => true });
    if (data && typeof data.key === "string" && data.key) return data.key;
    lastCode = (data && data.code) || "";
    token = (data && data.data && data.data.token) || "";
    if (!token) break;
  }
  throw new Error(`Kunci chapter MGRead gagal diambil${lastCode ? ` (${lastCode})` : ""}`);
}

function decryptChapter(payload, key) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key, "hex"), Buffer.from(payload.iv, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function chapterImages(body) {
  const $ = cheerio.load(body);
  return [...new Set($("img").map((_, el) => {
    const image = $(el);
    const url = absolute(image.attr("data-original-src") || image.attr("data-src") || image.attr("src"));
    return /^https:\/\/mg\.mgread\.io\//i.test(url) ? url : "";
  }).get().filter(Boolean))];
}

async function getChapter(series, chapterSlug) {
  const pageUrl = `${BASE}/manga/${encodeURIComponent(series)}/${encodeURIComponent(chapterSlug)}/`;
  const body = await html(pageUrl);
  const payload = encryptedPayload(body);
  let images;
  if (payload) {
    const nonce = (body.match(/"nonce":"([a-z0-9]+)"/i) || [])[1] || "";
    images = chapterImages(decryptChapter(payload, await chapterKey(payload, nonce, pageUrl)));
  } else {
    // Legacy layout: reader images are already in the HTML (first page uses
    // `src`, the rest `data-original-src`).
    images = chapterImages(body);
  }
  if (!images.length) throw new Error("Gambar chapter MGRead tidak ditemukan");
  const number = chapterSlug.match(/chapter-([\d.]+)/i)?.[1] || chapterSlug;
  return { success: true, source: "mgread", mangaId: series, chapterSlug, currentChapter: `Chapter ${number}`, prev: null, next: null, back_to_detail: series, totalImages: images.length, images };
}


module.exports = function (app, { getCache, setCache, coalescedScrape }) {
  const proxied = (u, req) => u ? `${String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim()}://${req.get("host")}/mgread/image?url=${encodeURIComponent(u)}` : "";
  app.get("/mgread/pustaka", async (req, res) => { const page = Math.max(1, Number(req.query.page) || 1); try { const data = parseCards(await html(page > 1 ? `/page/${page}/` : "/")); res.json({ success: true, source: "mgread.io", page, total: data.length, data: data.map(x => ({ ...x, image: proxied(x.image, req) })) }); } catch (e) { res.status(502).json({ success: false, data: [], message: e.message }); } });
  app.get("/mgread/search", async (req, res) => { const q = clean(req.query.q); if (!q) return res.status(400).json({ success: false, message: "Parameter q wajib diisi" }); try { let data = []; for (const candidate of searchFallbacks(q)) { data = parseCards(await html(`/?s=${encodeURIComponent(candidate)}`)).filter(x => matchesSearch(x.title, q)); if (!data.length) data = parseCards(await html(`/search/${encodeURIComponent(candidate)}/`)).filter(x => matchesSearch(x.title, q)); if (data.length) break; } res.json({ success: true, query: q, total: data.length, data: data.map(x => ({ ...x, image: proxied(x.image, req) })) }); } catch (e) { res.status(502).json({ success: false, query: q, data: [], message: e.message }); } });
  app.get("/mgread/detail/:slug", async (req, res) => { const cacheKey = `mgread:detail:${req.params.slug}`; try { const cached = getCache(cacheKey); const out = cached || await coalescedScrape(cacheKey, () => getDetail(req.params.slug)); if (!cached) setCache(cacheKey, out, 900); const image = proxied(out.data.thumbnail, req); res.set("Cache-Control", "public, max-age=300").json({ ...out, data: { ...out.data, image, thumbnail: image } }); } catch (e) { res.status(502).json({ success: false, message: e.message }); } });
  app.get("/mgread/chapter/:seriesSlug/:chapterSlug", async (req, res) => { const cacheKey = `mgread:chapter:${req.params.seriesSlug}:${req.params.chapterSlug}`; try { const cached = getCache(cacheKey); const out = cached || await coalescedScrape(cacheKey, () => getChapter(req.params.seriesSlug, req.params.chapterSlug)); if (!cached) setCache(cacheKey, out, 7200); res.set("Cache-Control", "public, max-age=600").json({ ...out, images: out.images.map(u => proxied(u, req)) }); } catch (e) { res.status(502).json({ success: false, message: e.message }); } });
  app.get("/mgread/image", async (req, res) => { try { const u = new URL(req.query.url); if (u.protocol !== "https:" || !IMAGE_HOSTS.has(u.hostname)) return res.status(400).send("URL gambar MGRead tidak valid"); const r = await axios.get(u.href, { responseType: "arraybuffer", timeout: 30000, headers: { "User-Agent": UA, Referer: `${BASE}/` } }); const type = r.headers["content-type"] || "image/jpeg"; if (!type.startsWith("image/")) return res.status(502).send("Respons upstream bukan gambar"); res.set("Content-Type", type).set("Cache-Control", "public, max-age=604800").send(r.data); } catch { res.status(502).send("Gambar MGRead tidak tersedia"); } });
};
