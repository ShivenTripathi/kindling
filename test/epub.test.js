import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { JSDOM } from "jsdom";

import { buildEpub, splitForSizeLimit } from "../src/epub.js";

// ---------------------------------------------------------------------------
// Minimal ZIP reader (mirrors the writer in src/epub.js) so we can assert on
// the archive's structure without a zip dependency.
// ---------------------------------------------------------------------------

function readZip(buffer) {
  // Find End Of Central Directory record (no comment, so it's the last 22 bytes).
  const eocdOffset = buffer.length - 22;
  assert.equal(
    buffer.readUInt32LE(eocdOffset),
    0x06054b50,
    "EOCD signature not found at expected offset",
  );
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  const order = [];
  const entries = new Map();
  let ptr = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.equal(
      buffer.readUInt32LE(ptr),
      0x02014b50,
      "central directory signature mismatch",
    );
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    // Local header: read its own name/extra lengths to find the data start.
    const lfNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const lfExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, uncompressedSize, `size mismatch for ${name}`);

    order.push(name);
    entries.set(name, { data, method });
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return { order, entries };
}

function parseXhtmlOrThrow(xml) {
  const dom = new JSDOM(xml, { contentType: "application/xhtml+xml" });
  const parserError = dom.window.document.querySelector("parsererror");
  if (parserError) {
    throw new Error(`XHTML failed to parse: ${parserError.textContent}`);
  }
  return dom;
}

function makeArticle(overrides = {}) {
  return {
    url: "https://example.com/articles/one",
    title: "The Quiet Art of Reading Slowly",
    byline: "Jane Doe",
    siteName: "Example Times",
    publishedTime: "2026-07-01T12:00:00.000Z",
    contentHtml:
      "<p>This is the <strong>body</strong> of the article.</p><p>A second paragraph.</p>",
    textContent: "This is the body of the article. A second paragraph.",
    wordCount: 10,
    engine: "defuddle",
    score: 0.9,
    ...overrides,
  };
}

async function tempOutPath(name) {
  const dir = await mkdtemp(join(tmpdir(), "kindling-epub-test-"));
  return join(dir, name);
}

describe("buildEpub", () => {
  test("builds a well-formed EPUB from synthetic articles", async () => {
    const articles = [
      makeArticle({
        url: "https://example.com/a",
        title: "Article One",
        contentHtml: "<p>Body of article one.</p>",
      }),
      makeArticle({
        url: "https://blog.example.org/b",
        title: 'Article Two & <Special> "Chars"',
        byline: undefined,
        siteName: undefined,
        publishedTime: undefined,
        contentHtml:
          "<p>Body of article two with an ampersand & a lt sign <.</p>",
      }),
      makeArticle({
        url: "https://another.example.net/c",
        title: "Article Three",
        contentHtml:
          "<h2>Heading</h2><blockquote>A quote</blockquote><pre><code>const x = 1;</code></pre>",
      }),
    ];

    const outPath = await tempOutPath("digest.epub");
    const date = new Date("2026-07-08T15:00:00.000Z");

    const result = await buildEpub(articles, {
      outPath,
      title: "Tab Digest",
      date,
      fetchImages: false,
    });

    assert.equal(result.path, outPath);
    assert.equal(result.articleCount, 3);
    assert.ok(result.sizeBytes > 0);

    const onDisk = await stat(outPath);
    assert.equal(onDisk.size, result.sizeBytes);

    const buffer = await readFile(outPath);
    const { order, entries } = readZip(buffer);

    // mimetype must be first, stored (uncompressed), and exactly the spec value.
    assert.equal(order[0], "mimetype");
    const mimetypeEntry = entries.get("mimetype");
    assert.equal(
      mimetypeEntry.method,
      0,
      "mimetype must be stored, not deflated",
    );
    assert.equal(mimetypeEntry.data.toString("ascii"), "application/epub+zip");

    assert.ok(entries.has("META-INF/container.xml"));
    assert.ok(entries.has("OEBPS/content.opf"));
    assert.ok(entries.has("OEBPS/nav.xhtml"));
    assert.ok(entries.has("OEBPS/toc.ncx"));
    assert.ok(entries.has("OEBPS/css/style.css"));
    assert.ok(entries.has("OEBPS/cover.xhtml"));
    assert.ok(entries.has("OEBPS/article-0001.xhtml"));
    assert.ok(entries.has("OEBPS/article-0002.xhtml"));
    assert.ok(entries.has("OEBPS/article-0003.xhtml"));
    assert.ok(!entries.has("OEBPS/failed.xhtml"));

    // container.xml points at the OPF.
    const containerXml = entries
      .get("META-INF/container.xml")
      .data.toString("utf8");
    assert.match(containerXml, /OEBPS\/content\.opf/);

    // Cover shows the right count and date.
    const coverXhtml = entries.get("OEBPS/cover.xhtml").data.toString("utf8");
    parseXhtmlOrThrow(coverXhtml);
    assert.match(coverXhtml, /3 articles/);
    assert.match(coverXhtml, /July 8, 2026/);
    assert.match(coverXhtml, /Tab Digest/);

    // Every article XHTML file is well-formed and contains its title + body.
    for (const [i, article] of articles.entries()) {
      const filename = `OEBPS/article-000${i + 1}.xhtml`;
      const xhtml = entries.get(filename).data.toString("utf8");
      const dom = parseXhtmlOrThrow(xhtml);
      assert.ok(
        dom.window.document.body.textContent.includes(
          article.title.replace(/&/, "").split(" ")[0],
        ),
        `article ${i + 1} XHTML should contain its title`,
      );
      // Sanitized body text made it through.
      assert.ok(
        xhtml.includes("Body of article") || xhtml.includes("Heading"),
        `article ${i + 1} XHTML should contain its body content`,
      );
      // Header block: source + link to original.
      assert.match(
        xhtml,
        new RegExp(article.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }

    // The OPF and nav are themselves well-formed XML.
    parseXhtmlOrThrow(entries.get("OEBPS/nav.xhtml").data.toString("utf8"));
    const opf = entries.get("OEBPS/content.opf").data.toString("utf8");
    parseXhtmlOrThrow(opf);
    assert.match(opf, /urn:uuid:[0-9a-f-]{36}/);
    assert.match(opf, /<dc:title>Tab Digest<\/dc:title>/);
  });

  test("is deterministic: same date + urls produce the same book identifier", async () => {
    const date = new Date("2026-07-08T00:00:00.000Z");
    const articles = [makeArticle({ url: "https://example.com/a" })];

    const outPath1 = await tempOutPath("one.epub");
    const outPath2 = await tempOutPath("two.epub");

    await buildEpub(articles, {
      outPath: outPath1,
      title: "Tab Digest",
      date,
      fetchImages: false,
    });
    await buildEpub(articles, {
      outPath: outPath2,
      title: "Tab Digest",
      date,
      fetchImages: false,
    });

    const opf1 = readZip(await readFile(outPath1))
      .entries.get("OEBPS/content.opf")
      .data.toString("utf8");
    const opf2 = readZip(await readFile(outPath2))
      .entries.get("OEBPS/content.opf")
      .data.toString("utf8");

    const uuid1 = opf1.match(/urn:uuid:([0-9a-f-]{36})/)[1];
    const uuid2 = opf2.match(/urn:uuid:([0-9a-f-]{36})/)[1];
    assert.equal(uuid1, uuid2);
  });

  test('adds a "couldn\'t fetch" end page when failedUrls is non-empty', async () => {
    const outPath = await tempOutPath("digest-with-failures.epub");
    const failedUrls = [
      "https://example.com/blocked",
      "https://example.com/timed-out",
    ];

    const result = await buildEpub([makeArticle()], {
      outPath,
      title: "Tab Digest",
      date: new Date("2026-07-08T00:00:00.000Z"),
      failedUrls,
      fetchImages: false,
    });

    assert.equal(result.articleCount, 1);
    const { entries } = readZip(await readFile(outPath));
    assert.ok(entries.has("OEBPS/failed.xhtml"));

    const failedXhtml = entries.get("OEBPS/failed.xhtml").data.toString("utf8");
    parseXhtmlOrThrow(failedXhtml);
    for (const url of failedUrls) {
      assert.match(
        failedXhtml,
        new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }

    const navXhtml = entries.get("OEBPS/nav.xhtml").data.toString("utf8");
    assert.match(navXhtml, /failed\.xhtml/);

    const opf = entries.get("OEBPS/content.opf").data.toString("utf8");
    assert.match(opf, /failed\.xhtml/);
  });

  test('omits the "couldn\'t fetch" page when failedUrls is empty or absent', async () => {
    const outPath = await tempOutPath("digest-no-failures.epub");
    await buildEpub([makeArticle()], {
      outPath,
      title: "Tab Digest",
      date: new Date("2026-07-08T00:00:00.000Z"),
      fetchImages: false,
    });
    const { entries } = readZip(await readFile(outPath));
    assert.ok(!entries.has("OEBPS/failed.xhtml"));
  });

  test("drops <img> tags entirely when fetchImages is false (no dangling remote refs)", async () => {
    const outPath = await tempOutPath("digest-images-off.epub");
    const articles = [
      makeArticle({
        contentHtml:
          '<p>Before</p><img src="https://example.com/photo.jpg" alt="a photo"/><p>After</p>',
      }),
    ];
    await buildEpub(articles, {
      outPath,
      title: "Tab Digest",
      date: new Date("2026-07-08T00:00:00.000Z"),
      fetchImages: false,
    });
    const { entries } = readZip(await readFile(outPath));
    const xhtml = entries.get("OEBPS/article-0001.xhtml").data.toString("utf8");
    assert.ok(!xhtml.includes("<img"));
    assert.ok(xhtml.includes("Before") && xhtml.includes("After"));
  });

  test("rejects missing outPath or title", async () => {
    await assert.rejects(() => buildEpub([], { title: "x" }));
    await assert.rejects(() => buildEpub([], { outPath: "/tmp/x.epub" }));
  });
});

describe("splitForSizeLimit", () => {
  test("keeps small articles in a single group", () => {
    const articles = [makeArticle(), makeArticle(), makeArticle()];
    const groups = splitForSizeLimit(articles, 52428800);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
  });

  test("partitions oversized articles into multiple groups", () => {
    // Each article's contentHtml alone is ~2MB; with a 3MB cap, at most one
    // fits per group (plus fixed per-build overhead).
    const bigHtml = `<p>${"x".repeat(2 * 1024 * 1024)}</p>`;
    const articles = Array.from({ length: 5 }, (_, i) =>
      makeArticle({
        url: `https://example.com/big-${i}`,
        contentHtml: bigHtml,
      }),
    );

    const groups = splitForSizeLimit(articles, 3 * 1024 * 1024);
    assert.ok(
      groups.length >= 5,
      `expected at least 5 groups, got ${groups.length}`,
    );
    for (const group of groups) {
      assert.ok(group.length >= 1);
    }
    const total = groups.reduce((n, g) => n + g.length, 0);
    assert.equal(total, articles.length);
  });

  test("a single article larger than maxBytes still gets its own group", () => {
    const hugeHtml = `<p>${"x".repeat(4 * 1024 * 1024)}</p>`;
    const articles = [makeArticle({ contentHtml: hugeHtml })];
    const groups = splitForSizeLimit(articles, 1024 * 1024);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 1);
  });

  test("empty input returns no groups", () => {
    assert.deepEqual(splitForSizeLimit([], 52428800), []);
  });

  test("accounts for embedded <img> tags in size estimates", () => {
    const withImages = makeArticle({
      contentHtml: `<p>text</p>${'<img src="https://example.com/x.jpg"/>'.repeat(10)}`,
    });
    const withoutImages = makeArticle({ contentHtml: "<p>text</p>" });
    // 10 images at the conservative per-image estimate should push this
    // article into its own group well before a text-only article would split.
    const groups = splitForSizeLimit(
      [withImages, withoutImages, withoutImages],
      3 * 1024 * 1024,
    );
    assert.ok(groups.length >= 2);
  });
});
