const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3012;

async function scrapeNontonAnimeDetail(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://s13.nontonanimeid.boats/",
      },
    });

    const data = res.data;

    // 🔥 AMBIL COOKIE DI SINI
    const cookies =
      res.headers["set-cookie"]?.map((c) => c.split(";")[0]).join("; ") || "";

    const $ = cheerio.load(data);

    // ================= BASIC =================
    const title = $(".name").text().trim();
    const thumbnail = $(".featuredimgs img").attr("src") || "";

    // ================= DECODE SCRIPT =================
    let nonce = "";
    let ajaxUrl = "";

    const scriptSrc = $("#ajax_video-js-extra").attr("src") || "";

    if (scriptSrc.includes("base64,")) {
      const base64 = scriptSrc.split("base64,")[1];
      const decoded = Buffer.from(base64, "base64").toString("utf-8");

      nonce = decoded.match(/"nonce":"(.*?)"/)?.[1] || "";
      ajaxUrl = decoded.match(/"url":"(.*?)"/)?.[1] || "";
    }

    // ================= SERVERS =================
    const servers = [];

    $(".serverplayer").each((i, el) => {
      servers.push({
        name: $(el).text().trim(),
        post: $(el).attr("data-post"),
        nume: $(el).attr("data-nume"),
        type: $(el).attr("data-type"),
      });
    });

    // ================= DEFAULT IFRAME =================
    const defaultIframe = $("#videoku iframe").attr("src") || "";

    // cari server aktif
    const activeIndex = $(".serverplayer.current1").index();

    // ================= PLAYER AJAX =================
    async function getPlayer({ post, nume, type }) {
      try {
        const params = new URLSearchParams();
        params.append("action", "player_ajax");
        params.append("nonce", nonce);
        params.append("serverName", type.toLowerCase());
        params.append("nume", nume);
        params.append("post", post);

        const { data } = await axios.post(ajaxUrl, params, {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "Mozilla/5.0",

            // 🔥 WAJIB BANGET
            Origin: "https://s13.nontonanimeid.boats",
            Referer: url,
            "X-Requested-With": "XMLHttpRequest",

            // 🔥 INI YANG KAMU BELUM
            Cookie: cookies,

            // 🔥 tambahan biar mirip browser
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
          },
        });

        const $$ = cheerio.load(data);
        const iframe = $$("iframe").attr("src") || "";

        if (!iframe) {
          console.log("❌ EMPTY:", type, nume);
          console.log(data.slice(0, 200)); // debug
        }

        return iframe;
      } catch (err) {
        console.log("ERR:", err.message);
        return "";
      }
    }

    // ================= AMBIL SEMUA PLAYER =================
    const players = [];

    for (let i = 0; i < servers.length; i++) {
      let iframe = "";

      if (i === activeIndex && defaultIframe) {
        // pakai iframe yang sudah ada
        iframe = defaultIframe;
      } else {
        iframe = await getPlayer(servers[i]);
      }

      players.push({
        name: servers[i].name,
        iframe,
      });
    }

    // ================= DOWNLOAD =================
    const downloads = [];

    $("#download_area .listlink a").each((i, el) => {
      downloads.push({
        name: $(el).text().trim(),
        url: $(el).attr("href"),
      });
    });

    // ================= NAVIGATION =================
    const prev = $("#navigation-episode a:contains('Prev')").attr("href") || "";
    const next = $("#navigation-episode a:contains('Next')").attr("href") || "";

    return {
      success: true,
      data: {
        title,
        thumbnail,
        players,
        downloads,
        prev,
        next,
      },
    };
  } catch (err) {
    console.error("❌ Error:", err.message);

    return {
      success: false,
      message: "Gagal scrape",
    };
  }
}

app.get("/nontonanime/episode", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.json({
        success: false,
        message: "URL diperlukan",
      });
    }

    const result = await scrapeNontonAnimeDetail(url);

    res.json(result);
  } catch (err) {
    res.json({
      success: false,
      message: err.message,
    });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 Server jalan di http://localhost:${PORT}`),
);
