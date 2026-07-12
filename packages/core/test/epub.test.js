import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { JSDOM } from "jsdom";

import { buildEpub, splitForSizeLimit } from "../src/epub/index.js";

// core/epub is browser-safe (no DOM library import); it uses the DOMParser/
// XMLSerializer globals when present, else an injected dom. In the browser
// those globals exist; here we supply jsdom's — exactly what a Node adapter
// does — so every buildEpub call below exercises the real serialization path.
const { window } = new JSDOM("");
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date("2026-07-12T09:30:00.000Z");

function article(overrides = {}) {
  return {
    url: "https://example.com/a",
    title: "A Great Article",
    byline: "Jane Doe",
    siteName: "Example",
    publishedTime: "2026-07-10T00:00:00.000Z",
    contentHtml: "<p>Hello <b>world</b>.</p>",
    textContent: "Hello world.",
    wordCount: 2,
    ...overrides,
  };
}

const ARTICLES = [
  article({
    url: "https://example.com/first",
    title: "First Article",
    contentHtml: "<p>First body paragraph.</p><img src=\"https://cdn.example.com/img1.jpg\"/>",
  }),
  article({
    url: "https://news.example.org/second",
    title: "Second Article",
    siteName: "News Example",
    byline: "John Smith",
    contentHtml: "<p>Second body paragraph with <em>emphasis</em>.</p>",
  }),
  article({
    url: "https://blog.example.net/third",
    title: "Third Article — Control chars \x01\x07",
    contentHtml: "<p>Third body & <a href=\"https://x.example\">a link</a>.</p>",
  }),
];

function decoder() {
  return new TextDecoder();
}

// ---------------------------------------------------------------------------
// Zip structure
// ---------------------------------------------------------------------------

describe("buildEpub — zip container", () => {
  test("mimetype is first entry, stored uncompressed, exact bytes", async () => {
    const { bytes } = await buildEpub(ARTICLES, {
      title: "Tab Digest",
      date: FIXED_DATE,
    });

    // fflate's zipSync preserves insertion order; verify by walking the raw
    // local file header at offset 0 rather than trusting unzipSync's map
    // (which re-orders into a plain object but does preserve insertion order
    // for string keys in V8 in practice — the raw-bytes check below is the
    // real proof).
    assert.equal(bytes[0], 0x50); // 'P'
    assert.equal(bytes[1], 0x4b); // 'K'
    assert.equal(bytes[2], 0x03);
    assert.equal(bytes[3], 0x04);
    // Local file header layout: sig(4) version(2) flags(2) method(2) ...
    const method = bytes[8] | (bytes[9] << 8);
    assert.equal(method, 0, "mimetype entry must be STORED (method 0)");
    const nameLen = bytes[26] | (bytes[27] << 8);
    const extraLen = bytes[28] | (bytes[29] << 8);
    const name = decoder().decode(bytes.slice(30, 30 + nameLen));
    assert.equal(name, "mimetype");
    const dataStart = 30 + nameLen + extraLen;
    const compressedSize = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24);
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    assert.equal(decoder().decode(data), "application/epub+zip");
  });

  test("unzips cleanly and contains the expected OCF files", async () => {
    const { bytes } = await buildEpub(ARTICLES, {
      title: "Tab Digest",
      date: FIXED_DATE,
    });
    const files = unzipSync(bytes);

    assert.equal(decoder().decode(files["mimetype"]), "application/epub+zip");
    assert.ok(files["META-INF/container.xml"]);
    assert.ok(files["OEBPS/content.opf"]);
    assert.ok(files["OEBPS/nav.xhtml"]);
    assert.ok(files["OEBPS/toc.ncx"]);
    assert.ok(files["OEBPS/css/style.css"]);
    assert.ok(files["OEBPS/cover.xhtml"]);

    const container = decoder().decode(files["META-INF/container.xml"]);
    assert.match(container, /OEBPS\/content\.opf/);

    const opf = decoder().decode(files["OEBPS/content.opf"]);
    assert.match(opf, /application\/oebps-package\+xml|package xmlns/);
    assert.match(opf, /dc:title/);
  });
});

// ---------------------------------------------------------------------------
// Article rendering
// ---------------------------------------------------------------------------

describe("buildEpub — article chapters", () => {
  test("one xhtml chapter per article containing title + body", async () => {
    const { bytes, articleCount } = await buildEpub(ARTICLES, {
      title: "Tab Digest",
      date: FIXED_DATE,
    });
    assert.equal(articleCount, 3);

    const files = unzipSync(bytes);
    const ch1 = decoder().decode(files["OEBPS/article-0001.xhtml"]);
    assert.match(ch1, /First Article/);
    assert.match(ch1, /First body paragraph\./);

    const ch2 = decoder().decode(files["OEBPS/article-0002.xhtml"]);
    assert.match(ch2, /Second Article/);
    assert.match(ch2, /John Smith/);

    const ch3 = decoder().decode(files["OEBPS/article-0003.xhtml"]);
    // C0 control chars must be stripped from the escaped title.
    assert.match(ch3, /Third Article — Control chars/);
    assert.ok(!/\x01|\x07/.test(ch3));
    assert.match(ch3, /Third body &amp;/);
  });

  test("cover shows article count and date", async () => {
    const { bytes } = await buildEpub(ARTICLES, {
      title: "My Digest",
      date: FIXED_DATE,
    });
    const files = unzipSync(bytes);
    const cover = decoder().decode(files["OEBPS/cover.xhtml"]);
    assert.match(cover, /My Digest/);
    assert.match(cover, /3 articles/);
    assert.match(cover, /July 12, 2026/);
  });

  test("images are dropped when no fetchImage is supplied (browser-safe default)", async () => {
    const { bytes } = await buildEpub(ARTICLES, {
      title: "Tab Digest",
      date: FIXED_DATE,
    });
    const files = unzipSync(bytes);
    const imageFiles = Object.keys(files).filter((n) => n.startsWith("OEBPS/images/"));
    assert.equal(imageFiles.length, 0);
    const ch1 = decoder().decode(files["OEBPS/article-0001.xhtml"]);
    assert.ok(!/<img/.test(ch1));
  });

  test("images are embedded when fetchImage is supplied", async () => {
    const fetchImage = async (url) => {
      assert.equal(url, "https://cdn.example.com/img1.jpg");
      return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg" };
    };
    const { bytes } = await buildEpub(ARTICLES, {
      title: "Tab Digest",
      date: FIXED_DATE,
      fetchImage,
    });
    const files = unzipSync(bytes);
    const imageFiles = Object.keys(files).filter((n) => n.startsWith("OEBPS/images/"));
    assert.equal(imageFiles.length, 1);
    assert.match(imageFiles[0], /\.jpg$/);
    const ch1 = decoder().decode(files["OEBPS/article-0001.xhtml"]);
    assert.match(ch1, /src="images\/img-0001\.jpg"/);
  });

  test("couldn't fetch end page is included when failedUrls given", async () => {
    const { bytes } = await buildEpub(ARTICLES, {
      title: "Tab Digest",
      date: FIXED_DATE,
      failedUrls: ["https://stale.example.com/gone"],
    });
    const files = unzipSync(bytes);
    assert.ok(files["OEBPS/failed.xhtml"]);
    const failedPage = decoder().decode(files["OEBPS/failed.xhtml"]);
    assert.match(failedPage, /Couldn't fetch/);
    assert.match(failedPage, /https:\/\/stale\.example\.com\/gone/);

    const nav = decoder().decode(files["OEBPS/nav.xhtml"]);
    assert.match(nav, /failed\.xhtml/);
  });

  test("no failed page when failedUrls is empty", async () => {
    const { bytes } = await buildEpub(ARTICLES, { title: "Tab Digest", date: FIXED_DATE });
    const files = unzipSync(bytes);
    assert.equal(files["OEBPS/failed.xhtml"], undefined);
  });
});

// ---------------------------------------------------------------------------
// splitForSizeLimit
// ---------------------------------------------------------------------------

describe("splitForSizeLimit", () => {
  test("keeps small article sets in a single group", () => {
    const groups = splitForSizeLimit(ARTICLES);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
  });

  test("partitions oversized input into multiple groups under maxBytes", () => {
    const bigHtml = "<p>" + "x".repeat(50_000) + "</p>";
    const many = Array.from({ length: 10 }, (_, i) =>
      article({ url: `https://example.com/big-${i}`, title: `Big ${i}`, contentHtml: bigHtml }),
    );
    const maxBytes = 200_000; // forces multiple groups given 50KB+ articles
    const groups = splitForSizeLimit(many, maxBytes);
    assert.ok(groups.length > 1, "expected more than one group");
    const total = groups.reduce((n, g) => n + g.length, 0);
    assert.equal(total, many.length, "no article should be dropped by splitting");
    for (const g of groups) assert.ok(g.length > 0);
  });

  test("never drops an article even if a single one exceeds maxBytes alone", () => {
    const huge = article({ contentHtml: "<p>" + "y".repeat(500_000) + "</p>" });
    const groups = splitForSizeLimit([huge], 1000);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 1);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("buildEpub — determinism", () => {
  test("GOLDEN: same articles + date produce byte-identical output across two builds", async () => {
    const opts = { title: "Tab Digest", date: FIXED_DATE };
    const first = await buildEpub(ARTICLES, opts);
    const second = await buildEpub(ARTICLES, { ...opts, date: new Date(FIXED_DATE) });

    assert.equal(first.sizeBytes, second.sizeBytes);
    assert.equal(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)), true);
  });

  test("book id (dc:identifier) is stable for the same articles + date", async () => {
    const opts = { title: "Tab Digest", date: FIXED_DATE };
    const a = await buildEpub(ARTICLES, opts);
    const b = await buildEpub(ARTICLES, opts);
    const filesA = unzipSync(a.bytes);
    const filesB = unzipSync(b.bytes);
    const opfA = decoder().decode(filesA["OEBPS/content.opf"]);
    const opfB = decoder().decode(filesB["OEBPS/content.opf"]);
    const idA = opfA.match(/urn:uuid:([0-9a-f-]+)/)[1];
    const idB = opfB.match(/urn:uuid:([0-9a-f-]+)/)[1];
    assert.equal(idA, idB);
    // RFC 4122-ish shape: 8-4-4-4-12 hex groups.
    assert.match(idA, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("book id changes when the article set changes", async () => {
    const opts = { title: "Tab Digest", date: FIXED_DATE };
    const a = await buildEpub(ARTICLES, opts);
    const b = await buildEpub([ARTICLES[0]], opts);
    const opfA = decoder().decode(unzipSync(a.bytes)["OEBPS/content.opf"]);
    const opfB = decoder().decode(unzipSync(b.bytes)["OEBPS/content.opf"]);
    const idA = opfA.match(/urn:uuid:([0-9a-f-]+)/)[1];
    const idB = opfB.match(/urn:uuid:([0-9a-f-]+)/)[1];
    assert.notEqual(idA, idB);
  });
});
