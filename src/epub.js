// src/epub.js
//
// Assemble one digest EPUB (EPUB 3, accepted by Amazon Send-to-Kindle) from a
// list of extracted articles: a typographically calm cover page, a table of
// contents, one XHTML chapter per article (header + sanitized body), a single
// Kindle-tuned stylesheet, best-effort embedded images, and an optional
// "couldn't fetch" end page so nothing is silently dropped (invariant #5 in
// CLAUDE.md).
//
// Dependency choice: no zip library. An EPUB container is just a ZIP with one
// rule (the `mimetype` entry must be the first entry, stored uncompressed).
// `node:zlib`'s `deflateRawSync` plus a hand-rolled ~100-line ZIP writer
// (local headers + central directory + EOCD, CRC-32 computed with a plain
// table) covers exactly what we need with zero new dependencies. `jsdom` is
// already a project dependency (used by the extraction engines) and gives us
// a real HTML parser + `XMLSerializer`, which is what actually guarantees the
// generated chapter markup is well-formed XHTML (self-closing void elements,
// entities escaped) rather than ad-hoc string surgery on `contentHtml`.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { fetchBytesSafe } from "./extract/fetch.js";

/**
 * @typedef {import('./extract/index.js').Article} Article
 */

/**
 * @typedef {Object} EpubOptions
 * @property {string} outPath        // where to write the .epub
 * @property {string} title          // e.g. "Tab Digest"
 * @property {Date} [date]
 * @property {string[]} [failedUrls] // listed on a "couldn't fetch" end page
 * @property {boolean} [fetchImages=true]      // download+embed <img> sources
 * @property {number} [maxTotalImageBytes]     // total image budget (default 20MB)
 * @property {number} [maxImageBytes]          // per-image cap (default 5MB)
 * @property {number} [imageFetchTimeoutMs]    // per-image fetch timeout (default 8000)
 */

const DEFAULT_MAX_BYTES = 52428800; // 50 MiB, the Send-to-Kindle cap
const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 8000;

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const EPUB_NS = "http://www.idpf.org/2007/ops";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build a single EPUB file from articles.
 * @param {Article[]} articles
 * @param {EpubOptions} opts
 * @returns {Promise<{path:string, sizeBytes:number, articleCount:number}>} */
export async function buildEpub(articles, opts) {
  if (!opts || !opts.outPath)
    throw new Error("buildEpub: opts.outPath is required");
  if (!opts.title) throw new Error("buildEpub: opts.title is required");

  const date = opts.date ?? new Date();
  const failedUrls = opts.failedUrls ?? [];
  const fetchImages = opts.fetchImages ?? true;
  const maxTotalImageBytes =
    opts.maxTotalImageBytes ?? DEFAULT_MAX_TOTAL_IMAGE_BYTES;
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const imageFetchTimeoutMs =
    opts.imageFetchTimeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;

  const bookId = deterministicBookId(
    date,
    articles.map((a) => a.url).concat(failedUrls),
  );
  const dateLong = formatLongDate(date);
  const dateIso = formatIsoDate(date);
  const dateTimeIso = formatIsoDateTime(date);

  // Process each article's content: parse -> (optionally) embed images -> serialize.
  const imageBudget = { remaining: maxTotalImageBytes };
  const imageCounter = { n: 0 };
  /** @type {{filename:string, mediaType:string, bytes:Buffer}[]} */
  const allImages = [];
  const chapters = [];
  for (const [i, article] of articles.entries()) {
    const { bodyXhtml, images } = await processArticleContent(
      article.contentHtml ?? "",
      {
        fetchImages,
        imageBudget,
        maxImageBytes,
        imageFetchTimeoutMs,
        counter: imageCounter,
      },
    );
    allImages.push(...images);
    chapters.push({
      article,
      index: i,
      filename: `article-${pad(i + 1)}.xhtml`,
      bodyXhtml,
    });
  }

  const hasFailedPage = failedUrls.length > 0;

  // ---- Assemble the OEBPS document set ----
  /** @type {{name:string, data:Buffer, store?:boolean}[]} */
  const entries = [];

  entries.push({
    name: "mimetype",
    data: Buffer.from("application/epub+zip", "ascii"),
    store: true,
  });

  entries.push({
    name: "META-INF/container.xml",
    data: Buffer.from(renderContainerXml(), "utf8"),
  });

  entries.push({
    name: "OEBPS/css/style.css",
    data: Buffer.from(KINDLE_CSS, "utf8"),
  });

  entries.push({
    name: "OEBPS/cover.xhtml",
    data: Buffer.from(
      renderCoverXhtml(opts.title, dateLong, articles.length),
      "utf8",
    ),
  });

  entries.push({
    name: "OEBPS/nav.xhtml",
    data: Buffer.from(renderNavXhtml(chapters, hasFailedPage), "utf8"),
  });

  entries.push({
    name: "OEBPS/toc.ncx",
    data: Buffer.from(
      renderNcx(bookId, opts.title, chapters, hasFailedPage),
      "utf8",
    ),
  });

  for (const chapter of chapters) {
    entries.push({
      name: `OEBPS/${chapter.filename}`,
      data: Buffer.from(
        renderArticleXhtml(chapter.article, chapter.bodyXhtml),
        "utf8",
      ),
    });
  }

  if (hasFailedPage) {
    entries.push({
      name: "OEBPS/failed.xhtml",
      data: Buffer.from(renderFailedXhtml(failedUrls), "utf8"),
    });
  }

  for (const image of allImages) {
    entries.push({ name: `OEBPS/${image.filename}`, data: image.bytes });
  }

  entries.push({
    name: "OEBPS/content.opf",
    data: Buffer.from(
      renderOpf({
        bookId,
        title: opts.title,
        dateIso,
        dateTimeIso,
        chapters,
        images: allImages,
        hasFailedPage,
      }),
      "utf8",
    ),
  });

  const zipBuffer = buildZipBuffer(entries, date);

  // Owner-only: the EPUB contains the user's article content and persists in
  // the data dir.
  await mkdir(dirname(opts.outPath), { recursive: true, mode: 0o700 });
  await writeFile(opts.outPath, zipBuffer, { mode: 0o600 });

  return {
    path: opts.outPath,
    sizeBytes: zipBuffer.length,
    articleCount: articles.length,
  };
}

/** Split articles into groups that each fit under maxBytes when built.
 * @param {Article[]} articles
 * @param {number} [maxBytes=52428800]
 * @returns {Article[][]} */
export function splitForSizeLimit(articles, maxBytes = DEFAULT_MAX_BYTES) {
  const FIXED_OVERHEAD_BYTES = 64 * 1024; // mimetype, container, opf, nav, ncx, css, cover
  const groups = [];
  let current = [];
  let currentBytes = FIXED_OVERHEAD_BYTES;

  for (const article of articles) {
    const size = estimateArticleBytes(article);
    if (current.length > 0 && currentBytes + size > maxBytes) {
      groups.push(current);
      current = [];
      currentBytes = FIXED_OVERHEAD_BYTES;
    }
    current.push(article);
    currentBytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// ---------------------------------------------------------------------------
// Size estimation
// ---------------------------------------------------------------------------

// Conservative: real photos from news/blog sites are commonly 200KB-800KB;
// we don't fetch here (this runs before image download decisions are made),
// so we budget generously per <img> tag to avoid ever exceeding maxBytes.
const AVG_IMAGE_BYTES_ESTIMATE = 400 * 1024;
const PER_ARTICLE_OVERHEAD_BYTES = 4 * 1024; // XHTML wrapper + header block

function estimateArticleBytes(article) {
  const html = article.contentHtml ?? "";
  const htmlBytes = Buffer.byteLength(html, "utf8");
  const imgCount = (html.match(/<img\b/gi) ?? []).length;
  return (
    htmlBytes + imgCount * AVG_IMAGE_BYTES_ESTIMATE + PER_ARTICLE_OVERHEAD_BYTES
  );
}

// ---------------------------------------------------------------------------
// Article content processing (parse, embed images, serialize to XHTML)
// ---------------------------------------------------------------------------

const IMAGE_EXT_BY_MEDIA_TYPE = {
  "image/jpeg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
};

async function processArticleContent(contentHtml, ctx) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="kindling-root">${contentHtml}</div></body></html>`,
  );
  const document = dom.window.document;
  const root = document.getElementById("kindling-root");
  /** @type {{filename:string, mediaType:string, bytes:Buffer}[]} */
  const images = [];

  if (root) {
    const imgEls = Array.from(root.querySelectorAll("img"));
    for (const img of imgEls) {
      const src = img.getAttribute("src");
      const shouldTryFetch =
        ctx.fetchImages &&
        src &&
        /^https?:\/\//i.test(src) &&
        ctx.imageBudget.remaining > 0;

      if (!shouldTryFetch) {
        img.remove();
        continue;
      }

      const fetched = await fetchImageSafely(
        src,
        ctx.maxImageBytes,
        ctx.imageBudget.remaining,
        ctx.imageFetchTimeoutMs,
      );
      if (!fetched) {
        img.remove();
        continue;
      }

      ctx.counter.n += 1;
      const filename = `images/img-${pad(ctx.counter.n)}${fetched.ext}`;
      images.push({
        filename,
        mediaType: fetched.mediaType,
        bytes: fetched.bytes,
      });
      ctx.imageBudget.remaining -= fetched.bytes.length;

      img.setAttribute("src", filename);
      img.removeAttribute("srcset");
      img.removeAttribute("loading");
      img.removeAttribute("decoding");
    }
  }

  const bodyXhtml = root ? serializeInner(dom.window, root) : "";
  return { bodyXhtml, images };
}

/** Serialize the children of `el` as well-formed XHTML, without repeating the
 * XHTML namespace declaration on every top-level child. */
function serializeInner(win, el) {
  const serializer = new win.XMLSerializer();
  const full = serializer.serializeToString(el);
  const openEnd = full.indexOf(">");
  const closeStart = full.length - "</div>".length;
  if (openEnd === -1 || closeStart <= openEnd) return "";
  return full.slice(openEnd + 1, closeStart);
}

async function fetchImageSafely(
  url,
  maxImageBytes,
  remainingBudget,
  timeoutMs,
) {
  const cap = Math.min(maxImageBytes, remainingBudget);
  if (cap <= 0) return null;
  // Route through the shared SSRF-guarded fetcher: an <img src> in a fetched
  // page is attacker-controlled, so it must get the same private/loopback/
  // link-local + DNS-pin + per-redirect-hop guard as the article fetch. A raw
  // fetch() here would let a page embed cloud-metadata / internal-LAN bytes
  // into the digest.
  const result = await fetchBytesSafe(url, { maxBytes: cap, timeoutMs });
  if (!result) return null;
  const ext = IMAGE_EXT_BY_MEDIA_TYPE[result.contentType];
  if (!ext) return null;
  if (result.bytes.length === 0 || result.bytes.length > cap) return null;
  return { bytes: result.bytes, mediaType: result.contentType, ext };
}

// ---------------------------------------------------------------------------
// XHTML / OPF / NCX templates
// ---------------------------------------------------------------------------

function pad(n) {
  return String(n).padStart(4, "0");
}

function escapeXml(value) {
  // Strip C0 control chars (except tab/LF/CR) first: they're illegal in XML 1.0
  // and a malicious page <title> containing them would produce a non-well-formed
  // EPUB that strict readers refuse to open.

  return String(value ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/[&<>"']/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&apos;";
      }
    });
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function formatIsoDateTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z"); // strip milliseconds
}

function xhtmlShell(title, bodyContent, extraHead = "") {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}" lang="en" xml:lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="css/style.css"/>
${extraHead}
</head>
<body>
${bodyContent}
</body>
</html>
`;
}

function renderCoverXhtml(title, dateLong, articleCount) {
  const countLabel =
    articleCount === 1 ? "1 article" : `${articleCount} articles`;
  const body = `
<section class="cover">
  <p class="cover-kicker">Kindling</p>
  <h1 class="cover-title">${escapeXml(title)}</h1>
  <hr class="cover-rule"/>
  <p class="cover-date">${escapeXml(dateLong)}</p>
  <p class="cover-count">${escapeXml(countLabel)}</p>
</section>
`;
  return xhtmlShell(title, body);
}

function renderNavXhtml(chapters, hasFailedPage) {
  const items = chapters
    .map(
      (c) =>
        `<li><a href="${c.filename}">${escapeXml(c.article.title || "Untitled")} <span class="nav-domain">— ${escapeXml(
          domainOf(c.article.url),
        )}</span></a></li>`,
    )
    .join("\n");
  const failedItem = hasFailedPage
    ? `<li><a href="failed.xhtml">Couldn't fetch</a></li>`
    : "";
  const bodymatterTarget =
    chapters.length > 0 ? chapters[0].filename : "cover.xhtml";

  const body = `
<nav epub:type="toc" id="toc">
  <h1>Table of Contents</h1>
  <ol>
${items}
${failedItem}
  </ol>
</nav>
<nav epub:type="landmarks" hidden="hidden">
  <ol>
    <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>
    <li><a epub:type="toc" href="nav.xhtml">Table of Contents</a></li>
    <li><a epub:type="bodymatter" href="${bodymatterTarget}">Start Reading</a></li>
  </ol>
</nav>
`;
  return xhtmlShell("Table of Contents", body);
}

function renderArticleXhtml(article, bodyXhtml) {
  const domain = domainOf(article.url);
  const source = article.siteName
    ? escapeXml(article.siteName)
    : escapeXml(domain);
  const bylineLine = article.byline
    ? `<p class="byline">By ${escapeXml(article.byline)}</p>`
    : "";
  const publishedLine = article.publishedTime
    ? `<p class="published">${escapeXml(formatLongDate(new Date(article.publishedTime)))}</p>`
    : "";
  const body = `
<section class="chapter">
  <header class="article-header">
    <h1 class="article-title">${escapeXml(article.title || "Untitled")}</h1>
    ${bylineLine}
    <p class="source-line">${source} <span class="source-domain">(${escapeXml(domain)})</span></p>
    ${publishedLine}
    <p class="original-link"><a href="${escapeXml(article.url)}">Read the original ↗</a></p>
  </header>
  <div class="article-body">
${bodyXhtml}
  </div>
</section>
`;
  return xhtmlShell(article.title || "Untitled", body);
}

function renderFailedXhtml(failedUrls) {
  const items = failedUrls
    .map((u) => `<li><a href="${escapeXml(u)}">${escapeXml(u)}</a></li>`)
    .join("\n");
  const body = `
<section class="chapter failed-page">
  <h1>Couldn't fetch</h1>
  <p class="failed-intro">These tabs were stale but could not be turned into readable articles. Nothing was silently dropped — reopen them from here if you still want them.</p>
  <ol class="failed-list">
${items}
  </ol>
</section>
`;
  return xhtmlShell("Couldn't fetch", body);
}

function renderContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function renderOpf({
  bookId,
  title,
  dateIso,
  dateTimeIso,
  chapters,
  images,
  hasFailedPage,
}) {
  const manifestChapters = chapters
    .map(
      (c) =>
        `    <item id="chapter-${pad(c.index + 1)}" href="${c.filename}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const manifestImages = images
    .map(
      (img, i) =>
        `    <item id="image-${pad(i + 1)}" href="${img.filename}" media-type="${img.mediaType}"/>`,
    )
    .join("\n");
  const manifestFailed = hasFailedPage
    ? `    <item id="failed" href="failed.xhtml" media-type="application/xhtml+xml"/>`
    : "";

  const spineChapters = chapters
    .map((c) => `    <itemref idref="chapter-${pad(c.index + 1)}"/>`)
    .join("\n");
  const spineFailed = hasFailedPage ? `    <itemref idref="failed"/>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:date>${dateIso}</dc:date>
    <meta property="dcterms:modified">${dateTimeIso}</meta>
  </metadata>
  <manifest>
    <item id="css" href="css/style.css" media-type="text/css"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${manifestChapters}
${manifestFailed}
${manifestImages}
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover"/>
    <itemref idref="nav"/>
${spineChapters}
${spineFailed}
  </spine>
  <guide>
    <reference type="toc" title="Table of Contents" href="nav.xhtml"/>
    <reference type="text" title="Cover" href="cover.xhtml"/>
  </guide>
</package>
`;
}

function renderNcx(bookId, title, chapters, hasFailedPage) {
  let playOrder = 1;
  const navPoints = [];
  navPoints.push(
    `  <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>Cover</text></navLabel><content src="cover.xhtml"/></navPoint>`,
  );
  playOrder += 1;
  navPoints.push(
    `  <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>Table of Contents</text></navLabel><content src="nav.xhtml"/></navPoint>`,
  );
  playOrder += 1;
  for (const c of chapters) {
    navPoints.push(
      `  <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>${escapeXml(
        c.article.title || "Untitled",
      )}</text></navLabel><content src="${c.filename}"/></navPoint>`,
    );
    playOrder += 1;
  }
  if (hasFailedPage) {
    navPoints.push(
      `  <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>Couldn't fetch</text></navLabel><content src="failed.xhtml"/></navPoint>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${bookId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints.join("\n")}
  </navMap>
</ncx>
`;
}

// ---------------------------------------------------------------------------
// Kindle-tuned CSS
// ---------------------------------------------------------------------------

const KINDLE_CSS = `
/* Kindling — Kindle-tuned digest stylesheet.
 * Serif reading type, a real type scale, generous margins, and careful
 * handling of the things that break on narrow e-ink screens: wide tables,
 * long code lines, and oversized images. */

body {
  font-family: Georgia, "Bookerly", "Palatino Linotype", serif;
  line-height: 1.5;
  margin: 0 6%;
  color: #111;
  font-size: 100%;
  text-rendering: optimizeLegibility;
}

/* ---- Cover ------------------------------------------------------------ */

.cover {
  margin-top: 30%;
  text-align: center;
}

.cover-kicker {
  font-family: Georgia, serif;
  font-size: 0.8em;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: #666;
  margin: 0 0 1.5em 0;
}

.cover-title {
  font-size: 2.4em;
  font-weight: bold;
  line-height: 1.25;
  margin: 0 0 0.6em 0;
}

.cover-rule {
  width: 20%;
  border: none;
  border-top: 1px solid #999;
  margin: 1.5em auto;
}

.cover-date {
  font-size: 1.1em;
  color: #333;
  margin: 0 0 0.3em 0;
}

.cover-count {
  font-size: 0.95em;
  color: #666;
  font-style: italic;
  margin: 0;
}

/* ---- Table of contents -------------------------------------------------- */

nav[epub|type~="toc"] h1,
nav h1 {
  font-size: 1.6em;
  margin: 0 0 1em 0;
  text-align: center;
}

nav[epub|type~="toc"] ol {
  list-style: none;
  padding: 0;
  margin: 0;
}

nav[epub|type~="toc"] li {
  margin: 0 0 0.9em 0;
  line-height: 1.4;
}

nav[epub|type~="toc"] a {
  text-decoration: none;
  color: #111;
}

.nav-domain {
  color: #777;
  font-size: 0.85em;
  font-style: italic;
}

/* ---- Article chapters --------------------------------------------------- */

.chapter {
  page-break-before: always;
  break-before: page;
}

.article-header {
  margin-bottom: 1.6em;
}

.article-title {
  font-size: 1.8em;
  line-height: 1.3;
  margin: 0 0 0.4em 0;
}

.byline,
.source-line,
.published {
  font-size: 0.9em;
  color: #555;
  margin: 0.15em 0;
}

.source-domain {
  color: #888;
}

.original-link {
  font-size: 0.85em;
  margin: 0.6em 0 0 0;
}

.original-link a {
  color: #555;
}

.article-header hr,
.article-body hr {
  border: none;
  border-top: 1px solid #ddd;
  margin: 1.2em 0;
}

/* ---- Body typography ----------------------------------------------------- */

.article-body h1 { font-size: 1.5em; margin: 1.4em 0 0.6em 0; line-height: 1.3; }
.article-body h2 { font-size: 1.3em; margin: 1.3em 0 0.5em 0; line-height: 1.3; }
.article-body h3 { font-size: 1.15em; margin: 1.2em 0 0.5em 0; line-height: 1.3; }
.article-body h4,
.article-body h5,
.article-body h6 { font-size: 1.05em; margin: 1.1em 0 0.4em 0; }

.article-body p {
  margin: 0 0 1em 0;
  text-align: justify;
  orphans: 2;
  widows: 2;
}

.article-body ul,
.article-body ol {
  margin: 0 0 1em 0;
  padding-left: 1.4em;
}

.article-body li {
  margin: 0 0 0.4em 0;
}

.article-body blockquote {
  margin: 1.2em 0.6em;
  padding-left: 1em;
  border-left: 3px solid #ccc;
  color: #333;
  font-style: italic;
}

.article-body pre,
.article-body code {
  font-family: "Courier New", monospace;
  font-size: 0.85em;
}

.article-body pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  background: #f4f4f4;
  border: 1px solid #ddd;
  padding: 0.8em;
  margin: 0 0 1.2em 0;
  line-height: 1.4;
}

.article-body code {
  background: #f4f4f4;
  padding: 0.1em 0.3em;
}

.article-body pre code {
  background: none;
  padding: 0;
}

.article-body figure {
  margin: 1.5em 0;
  text-align: center;
}

.article-body img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1.5em auto;
}

.article-body figcaption {
  font-size: 0.85em;
  font-style: italic;
  color: #666;
  margin-top: 0.5em;
  text-align: center;
}

.article-body table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85em;
  margin: 0 0 1.2em 0;
}

.article-body th,
.article-body td {
  border: 1px solid #ccc;
  padding: 0.4em 0.5em;
  word-break: break-word;
  text-align: left;
}

.article-body a {
  color: #333;
  text-decoration: underline;
}

.article-body hr {
  margin: 2em 0;
}

/* ---- "Couldn't fetch" end page ------------------------------------------- */

.failed-page h1 {
  font-size: 1.6em;
  margin: 0 0 0.6em 0;
}

.failed-intro {
  color: #555;
  margin: 0 0 1.4em 0;
}

.failed-list {
  padding-left: 1.2em;
}

.failed-list li {
  margin: 0 0 0.6em 0;
  word-break: break-all;
  font-size: 0.9em;
}
`;

// ---------------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------------

function deterministicBookId(date, urls) {
  const seed = `${formatIsoDate(date)}|${urls.join("|")}`;
  const hex = createHash("sha256")
    .update(seed, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5"; // version nibble (name-based, informational)
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant bits
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (store + deflate, node:zlib only)
// ---------------------------------------------------------------------------

const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime =
    ((date.getUTCHours() & 0x1f) << 11) |
    ((date.getUTCMinutes() & 0x3f) << 5) |
    (Math.floor(date.getUTCSeconds() / 2) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getUTCMonth() + 1) & 0xf) << 5) |
    (date.getUTCDate() & 0x1f);
  return { dosTime, dosDate };
}

/** Build a ZIP archive buffer. `entries[0]` is expected to be `mimetype`
 * with `store: true` — the EPUB OCF requirement. */
function buildZipBuffer(entries, date) {
  const { dosTime, dosDate } = dosDateTime(date);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const dataBuf = entry.data;
    const crc = crc32(dataBuf);

    let method = 0;
    let compressed = dataBuf;
    if (!entry.store) {
      const deflated = deflateRawSync(dataBuf, { level: 9 });
      if (deflated.length < dataBuf.length) {
        method = 8;
        compressed = deflated;
      }
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0o644 << 16, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}
