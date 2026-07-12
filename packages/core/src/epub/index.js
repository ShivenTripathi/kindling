// packages/core/src/epub/index.js
//
// Assemble one digest EPUB (EPUB 3, accepted by Amazon Send-to-Kindle) from a
// list of extracted articles: a typographically calm cover page, a table of
// contents, one XHTML chapter per article (header + sanitized body), a single
// Kindle-tuned stylesheet, best-effort embedded images, and an optional
// "couldn't fetch" end page so nothing is silently dropped (invariant #5 in
// CLAUDE.md).
//
// This is a re-home of the audited `src/epub.js` into `@kindling/core`, made
// browser-safe:
//   - the zip backend is `fflate`'s `zipSync` instead of a hand-rolled ZIP
//     writer over `node:zlib`'s `deflateRawSync`.
//   - `buildEpub` returns bytes (`Uint8Array`), not a written file — writing
//     is a platform (cli/desktop/extension) concern.
//   - images are fetched through an injected `opts.fetchImage(url)` port
//     instead of importing the Node SSRF-guarded fetcher directly; if the
//     caller doesn't supply one, images are simply dropped (a safe default
//     that works with zero network access, e.g. in the browser extension).
//   - the deterministic book id uses a small pure-JS FNV-1a hash instead of
//     `node:crypto`'s `createHash`, so nothing in this module reaches for a
//     Node built-in.
//
// EPUB container rule this module must always uphold: the `mimetype` entry
// must be the first entry in the zip and stored uncompressed. With fflate's
// `zipSync`, entry order follows the object key insertion order of the input
// map, so `mimetype` is inserted first and given `{level: 0}` (store, no
// compression); every other entry gets `{level: 6}` (deflate).

import { zipSync } from "fflate";
// No DOM library is imported here — core stays browser-safe. The caller injects
// a `dom` provider ({ parseHtml, serialize }); in a browser we default to the
// native DOMParser/XMLSerializer globals. The Node adapter (CLI/desktop/tests)
// passes a jsdom-backed provider (jsdom self-closes void elements to valid
// XHTML; linkedom's toString does NOT, so it can't be used for EPUB output).
function resolveDom(injected) {
  if (injected) return injected;
  if (typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined") {
    return {
      parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
      serialize: (node) => new XMLSerializer().serializeToString(node),
    };
  }
  throw new Error(
    "buildEpub requires opts.dom = { parseHtml, serialize } outside a browser (e.g. a jsdom-backed provider).",
  );
}

/**
 * @typedef {import('../ports.js').Article} Article
 */

/**
 * @typedef {Object} EpubOptions
 * @property {string} title          // e.g. "Tab Digest"
 * @property {Date} [date]
 * @property {string[]} [failedUrls] // listed on a "couldn't fetch" end page
 * @property {boolean} [fetchImages=true]      // download+embed <img> sources (requires opts.fetchImage)
 * @property {number} [maxTotalImageBytes]     // total image budget (default 20MB)
 * @property {number} [maxImageBytes]          // per-image cap (default 5MB)
 * @property {(url:string)=>Promise<{bytes:Uint8Array,contentType:string}|null>} [fetchImage]
 *   // injected image fetcher; if absent, images are dropped (browser-safe
 *   // default). cli/desktop pass an SSRF-guarded impl; the extension passes
 *   // one that pulls from the already-rendered page. Core never calls a bare
 *   // fetch() itself.
 * @property {{parseHtml:(html:string)=>any, serialize:(node:any)=>string}} [dom]
 *   // DOM provider for parsing/serializing article HTML into valid XHTML.
 *   // Defaults to the browser's DOMParser/XMLSerializer globals; Node callers
 *   // (CLI/desktop/tests) must inject a jsdom-backed provider.
 */

const DEFAULT_MAX_BYTES = 52428800; // 50 MiB, the Send-to-Kindle cap
const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const EPUB_NS = "http://www.idpf.org/2007/ops";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build a single EPUB from articles.
 * @param {Article[]} articles
 * @param {EpubOptions} opts
 * @returns {Promise<{bytes: Uint8Array, sizeBytes: number, articleCount: number}>} */
export async function buildEpub(articles, opts) {
  if (!opts || !opts.title) throw new Error("buildEpub: opts.title is required");

  const date = opts.date ?? new Date();
  const failedUrls = opts.failedUrls ?? [];
  const fetchImage = typeof opts.fetchImage === "function" ? opts.fetchImage : null;
  const fetchImages = (opts.fetchImages ?? true) && fetchImage !== null;
  const dom = resolveDom(opts.dom);
  const maxTotalImageBytes =
    opts.maxTotalImageBytes ?? DEFAULT_MAX_TOTAL_IMAGE_BYTES;
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

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
  /** @type {{filename:string, mediaType:string, bytes:Uint8Array}[]} */
  const allImages = [];
  const chapters = [];
  for (const [i, article] of articles.entries()) {
    const { bodyXhtml, images } = await processArticleContent(
      article.contentHtml ?? "",
      {
        fetchImages,
        fetchImage,
        imageBudget,
        maxImageBytes,
        counter: imageCounter,
        dom,
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
  // Insertion order matters: `mimetype` MUST be the first key so fflate emits
  // it as the first zip entry (required by the EPUB OCF spec). fflate's
  // `zipSync` takes each entry as `data` or a `[data, ZipOptions]` tuple, so
  // per-entry compression level travels with the entry itself rather than in
  // a separate options map.
  /** @type {Record<string, Uint8Array | [Uint8Array, {level:0|6, mtime?:Date}]>} */
  const files = {};

  files["mimetype"] = [utf8("application/epub+zip"), { level: 0, mtime: date }];

  addFile(files, "META-INF/container.xml", renderContainerXml(), date);
  addFile(files, "OEBPS/css/style.css", KINDLE_CSS, date);
  addFile(
    files,
    "OEBPS/cover.xhtml",
    renderCoverXhtml(opts.title, dateLong, articles.length),
    date,
  );
  addFile(files, "OEBPS/nav.xhtml", renderNavXhtml(chapters, hasFailedPage), date);
  addFile(
    files,
    "OEBPS/toc.ncx",
    renderNcx(bookId, opts.title, chapters, hasFailedPage),
    date,
  );

  for (const chapter of chapters) {
    addFile(
      files,
      `OEBPS/${chapter.filename}`,
      renderArticleXhtml(chapter.article, chapter.bodyXhtml),
      date,
    );
  }

  if (hasFailedPage) {
    addFile(files, "OEBPS/failed.xhtml", renderFailedXhtml(failedUrls), date);
  }

  for (const image of allImages) {
    files[`OEBPS/${image.filename}`] = [image.bytes, { level: 6, mtime: date }];
  }

  addFile(
    files,
    "OEBPS/content.opf",
    renderOpf({
      bookId,
      title: opts.title,
      dateIso,
      dateTimeIso,
      chapters,
      images: allImages,
      hasFailedPage,
    }),
    date,
  );

  const zipBytes = zipSync(files);

  return {
    bytes: zipBytes,
    sizeBytes: zipBytes.length,
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
// Zip assembly helpers
// ---------------------------------------------------------------------------

function utf8(str) {
  return new TextEncoder().encode(str);
}

/** Add a UTF-8 text entry to `files`, deflated at level 6. `fflate`'s
 * `zipSync` builds the entry ordering from the object's key insertion order,
 * so callers must add `mimetype` first (with `{level: 0}`, done separately
 * above). */
function addFile(files, name, contents, date) {
  files[name] = [utf8(contents), { level: 6, mtime: date }];
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
  const htmlBytes = byteLength(html);
  const imgCount = (html.match(/<img\b/gi) ?? []).length;
  return (
    htmlBytes + imgCount * AVG_IMAGE_BYTES_ESTIMATE + PER_ARTICLE_OVERHEAD_BYTES
  );
}

function byteLength(str) {
  return utf8(str).length;
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
  const document = ctx.dom.parseHtml(
    `<!DOCTYPE html><html><body><div id="kindling-root">${contentHtml}</div></body></html>`,
  );
  const root = document.getElementById("kindling-root");
  /** @type {{filename:string, mediaType:string, bytes:Uint8Array}[]} */
  const images = [];

  if (root) {
    const imgEls = Array.from(root.querySelectorAll("img"));
    for (const img of imgEls) {
      const src = img.getAttribute("src");
      const shouldTryFetch =
        ctx.fetchImages &&
        ctx.fetchImage &&
        src &&
        /^https?:\/\//i.test(src) &&
        ctx.imageBudget.remaining > 0;

      if (!shouldTryFetch) {
        img.remove();
        continue;
      }

      const fetched = await fetchImageSafely(
        ctx.fetchImage,
        src,
        ctx.maxImageBytes,
        ctx.imageBudget.remaining,
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

  const bodyXhtml = root ? serializeInner(ctx.dom, root) : "";
  return { bodyXhtml, images };
}

/** Serialize the children of `el` as well-formed XHTML, without repeating the
 * XHTML namespace declaration on every top-level child. */
function serializeInner(dom, el) {
  const full = dom.serialize(el);
  const openEnd = full.indexOf(">");
  const closeStart = full.length - "</div>".length;
  if (openEnd === -1 || closeStart <= openEnd) return "";
  return full.slice(openEnd + 1, closeStart);
}

/** Fetch one image through the injected port, enforcing the same per-image
 * and remaining-budget caps as before. `opts.fetchImage` is expected to be an
 * SSRF-guarded implementation on platforms with network access (cli/desktop);
 * core itself never calls a bare fetch(). */
async function fetchImageSafely(fetchImage, url, maxImageBytes, remainingBudget) {
  const cap = Math.min(maxImageBytes, remainingBudget);
  if (cap <= 0) return null;
  let result;
  try {
    result = await fetchImage(url);
  } catch {
    return null;
  }
  if (!result || !result.bytes || !result.contentType) return null;
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

/** Pure-JS FNV-1a 32-bit hash (no node:crypto — keeps this module usable in
 * the browser). Used only to derive a deterministic, name-based book UUID;
 * no cryptographic properties are required here (the input is not secret and
 * collision resistance only needs to be "good enough to not collide across a
 * user's own digests"), so a 128-bit id built from four independently-salted
 * FNV-1a passes over the seed string is more than sufficient. */
function fnv1a32(str, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function deterministicBookId(date, urls) {
  const seed = `${formatIsoDate(date)}|${urls.join("|")}`;
  // Four independently-salted FNV-1a passes give 128 bits of deterministic
  // pseudo-randomness derived purely from the seed string.
  const words = [
    fnv1a32(seed, 0x811c9dc5),
    fnv1a32(seed, 0x9e3779b9),
    fnv1a32(seed, 0x85ebca6b),
    fnv1a32(seed, 0xc2b2ae35),
  ];
  const hex = words.map((w) => w.toString(16).padStart(8, "0")).join("").split("");
  hex[12] = "5"; // version nibble (name-based, informational)
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant bits
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
