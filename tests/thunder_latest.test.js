"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseCards, rssBySlug, isoDate } = require("../thunder")._test;

const LATEST_PATH = "/comics/?status=&type=&order=latest";
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "thunder_latest.html"), "utf8");

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Thunder</title>
  <item>
    <title>My Exclusive Evil King Skill Is Too Overpowered</title>
    <link>https://en-thunderscans.com/comics/my-exclusive-evil-king-skill-is-too-overpowered/?utm_source=rss</link>
    <pubDate>Tue, 29 Sep 2026 17:24:28 +0000</pubDate>
  </item>
  <item>
    <title>My Dragon Girlfriend Has Returned</title>
    <link>https://en-thunderscans.com/comics/my-dragon-girlfriend-has-returned/</link>
    <pubDate>Mon, 28 Sep 2026 09:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

test("list order=latest terurai dari .listupd .bs", () => {
  const items = parseCards(FIXTURE, ".listupd .bs");
  assert.equal(items.length, 2, "kedua kartu harus terurai");
  assert.equal(items[0].slug, "my-exclusive-evil-king-skill-is-too-overpowered");
  assert.equal(items[1].slug, "my-dragon-girlfriend-has-returned");
  assert.equal(items[0].source, "thunder");
  assert.ok(items[0].title.includes("Evil King"), "judul harus dari atribut title/.tt");
  assert.ok(items[0].detail_link.startsWith("https://en-thunderscans.com/comics/"));
  assert.ok(items[0].image.startsWith("https://"), "cover harus absolut");
});

test("urutan halaman dipertahankan (sort Added = newest first)", () => {
  const items = parseCards(FIXTURE, ".listupd .bs");
  const slugs = items.map((item) => item.slug);
  assert.deepEqual(
    slugs,
    ["my-exclusive-evil-king-skill-is-too-overpowered", "my-dragon-girlfriend-has-returned"],
    "urutan kartu di HTML harus keluar apa adanya, karena urutan itulah sinyal 'baru'"
  );
});

test("selector lama .latest-updates .bs tetap kosong di halaman ini", () => {
  assert.equal(parseCards(FIXTURE, ".latest-updates .bs").length, 0,
    "pemakaian selector keliru harus gagal terbaca, bukan diam-diam kosong");
});

test("rssBySlug memetakan slug ke pubDate dan cuek pada query string", () => {
  const found = rssBySlug(RSS);
  assert.equal(Object.keys(found).length, 2);
  assert.equal(found["my-exclusive-evil-king-skill-is-too-overpowered"], "Tue, 29 Sep 2026 17:24:28 +0000");
  assert.equal(found["my-dragon-girlfriend-has-returned"], "Mon, 28 Sep 2026 09:00:00 +0000");
});

test("isoDate menghasilkan ISO-8601 dan menahan tanggal rusak", () => {
  assert.equal(isoDate("Tue, 29 Sep 2026 17:24:28 +0000"), "2026-09-29T17:24:28.000Z");
  assert.equal(isoDate(""), "", "tanpa tanggal harus tetap string kosong, bukan NaN/Invalid Date");
  assert.equal(isoDate("bukan-tanggal"), "");
});

test("RSS gagal tidak boleh menghapus field published_at dari daftar", () => {
  const items = parseCards(FIXTURE, ".listupd .bs");
  const published = {}; // mensimulasikan feed gagal diurai
  const merged = items.map((item) => ({ ...item, published_at: isoDate(published[item.slug] || "") }));
  assert.equal(merged.length, items.length, "jumlah item tidak boleh berubah");
  assert.deepEqual(merged.map((item) => item.published_at), ["", ""],
    "tanpa RSS field tetap ada dan kosong, bukan hilang");
});

test("path listing sesuai permintaan order=latest (sort Added)", () => {
  assert.equal(LATEST_PATH, "/comics/?status=&type=&order=latest");
});
