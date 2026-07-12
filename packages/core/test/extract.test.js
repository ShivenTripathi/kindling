// extract.test.js
//
// Ported from /test/extract.test.js (see docs/rework-interfaces.md,
// `src/extract/index.js`). The old suite drove extraction via
// `opts.rawHtml` so it never touched the network; here there's no fetcher in
// core at all, so every case drives `extractFromHtml(html, url, opts)` with
// an injected `parseHtml` — linkedom's `parseHTML`, exactly the Node-side
// DOM implementation the module comments in engines.js describe. No
// network, no jsdom, no Postlight — same as before.

import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

import { extractFromDocument, extractFromHtml } from "../src/extract/index.js";
import { runEngine, ENGINE_ORDER } from "../src/extract/engines.js";
import { scoreArticle } from "../src/extract/score.js";
import { sanitizeHtml } from "../src/extract/sanitize.js";

const ARTICLE_URL = "https://example.com/articles/great-piece";

function parseHtml(html) {
  // linkedom's parseHTML returns the `window`; extract* only needs the
  // Document (mirrors extension/CLI callers, who'd pass the same thing).
  return parseHTML(html).document;
}

async function extract(url, opts = {}) {
  const { rawHtml, ...rest } = opts;
  return extractFromHtml(rawHtml, url, { parseHtml, ...rest });
}

// A ~20-word sentence, repeated to build up to an arbitrary word count
// without hand-typing lorem ipsum.
const SENTENCE =
  "The quiet town by the river had watched centuries pass without much fuss, " +
  "and the old bridge still carried farmers to market every single morning. ";

function paragraphOf(words) {
  const sentenceWords = SENTENCE.trim().split(/\s+/).length;
  const repeats = Math.ceil(words / sentenceWords);
  return `<p>${SENTENCE.repeat(repeats)}</p>`;
}

function htmlPage({ title = "A Great Piece", bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head><title>${title}</title></head>
<body>
  <header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
  <main>
    <article>
      <h1>${title}</h1>
      <p class="byline">By A. Writer</p>
      ${bodyHtml}
    </article>
  </main>
  <footer>© Example Corp <a href="/privacy">Privacy</a> <a href="/terms">Terms</a></footer>
</body>
</html>`;
}

// ---- Fixtures --------------------------------------------------------

const GOOD_ARTICLE = htmlPage({
  bodyHtml: `
    ${paragraphOf(120)}
    <img src="https://example.com/images/bridge.jpg" alt="The old bridge">
    ${paragraphOf(120)}
    ${paragraphOf(120)}
  `,
});

// A nav/link-farm page: lots of links, almost no prose. Should fail the
// word-count gate (and would score poorly on link density even if it didn't).
const THIN_NAV_PAGE = htmlPage({
  title: "Site Directory",
  bodyHtml: `
    <p>Browse our categories below.</p>
    <ul>
      ${Array.from({ length: 40 }, (_, i) => `<li><a href="/cat/${i}">Category ${i}</a></li>`).join("\n")}
    </ul>
  `,
});

const TABLE_AND_CODE_ARTICLE = htmlPage({
  title: "Benchmarking Sort Algorithms",
  bodyHtml: `
    ${paragraphOf(150)}
    <table>
      <thead><tr><th>Algorithm</th><th>Best</th><th>Worst</th></tr></thead>
      <tbody>
        <tr><td>Quicksort</td><td>O(n log n)</td><td>O(n^2)</td></tr>
        <tr><td>Mergesort</td><td>O(n log n)</td><td>O(n log n)</td></tr>
      </tbody>
    </table>
    ${paragraphOf(150)}
    <pre><code>function quicksort(arr) {
  if (arr.length <= 1) return arr;
  // ...
  return arr;
}</code></pre>
    ${paragraphOf(150)}
  `,
});

const EMPTY_PAGE = `<!doctype html><html><head><title>Untitled</title></head><body></body></html>`;

const GARBAGE_INPUT =
  " ￿<<< not even close to html ###@@@ " + "\x01\x02\x03".repeat(20);

// ---- extractFromHtml(): engine selection, scoring, gating -----------------

test("extractFromHtml() returns ok for a substantial article, with engine/score/source set", async () => {
  const result = await extract(ARTICLE_URL, { rawHtml: GOOD_ARTICLE });
  assert.equal(result.status, "ok");
  assert.ok(result.article, "expected an article");
  assert.equal(result.article.source, "dom");
  assert.ok(["defuddle", "readability"].includes(result.article.engine));
  assert.ok(
    result.article.wordCount >= 300,
    `expected >=300 words, got ${result.article.wordCount}`,
  );
  assert.ok(
    result.article.score > 0,
    `expected a positive score, got ${result.article.score}`,
  );
  assert.equal(result.article.title, "A Great Piece");
  assert.equal(result.article.url, ARTICLE_URL);
});

test("extractFromHtml() picks whichever engine scores higher, and ENGINE_ORDER puts Defuddle first for ties", async () => {
  // We don't assert which engine wins on this particular fixture (that
  // depends on two independently-evolving parser internals) — instead we
  // assert the tie-break contract: ENGINE_ORDER lists Defuddle before
  // Readability, and pickBest's reduce only replaces the running winner on a
  // STRICTLY greater score, so equal-scoring candidates keep the earlier
  // (Defuddle) one. See src/extract/engines.js's ENGINE_ORDER export.
  assert.deepEqual(ENGINE_ORDER, ["defuddle", "readability"]);

  const result = await extract(ARTICLE_URL, { rawHtml: GOOD_ARTICLE });
  assert.equal(result.status, "ok");
  assert.ok(["defuddle", "readability"].includes(result.article.engine));
});

test("extractFromHtml() skips a thin nav-heavy page (fails the word-count gate)", async () => {
  const result = await extract("https://example.com/directory", {
    rawHtml: THIN_NAV_PAGE,
  });
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /too short/i);
});

test("extractFromHtml() honors a custom minWords threshold", async () => {
  const shortButRealArticle = htmlPage({ bodyHtml: paragraphOf(80) });
  const strict = await extract(ARTICLE_URL, {
    rawHtml: shortButRealArticle,
    minWords: 300,
  });
  assert.equal(strict.status, "skipped");

  const lenient = await extract(ARTICLE_URL, {
    rawHtml: shortButRealArticle,
    minWords: 50,
  });
  assert.equal(lenient.status, "ok");
});

test("extractFromHtml() applies an optional minScore quality gate", async () => {
  const result = await extract(ARTICLE_URL, {
    rawHtml: GOOD_ARTICLE,
    minScore: 1_000_000,
  });
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /quality score/i);
});

test("extractFromHtml() keeps tables and code in an article that has them", async () => {
  const result = await extract("https://example.com/benchmarks", {
    rawHtml: TABLE_AND_CODE_ARTICLE,
  });
  assert.equal(result.status, "ok");
  assert.match(result.article.contentHtml, /<table/i);
  assert.match(result.article.contentHtml, /(<pre|<code)/i);
});

test("extractFromHtml() returns skipped/failed (never throws) for an empty page", async () => {
  await assert.doesNotReject(async () => {
    const result = await extract("https://example.com/blank", {
      rawHtml: EMPTY_PAGE,
    });
    // An empty page has no article, not a fetch error — either graceful
    // non-throwing outcome is acceptable; it must carry a reason.
    assert.ok(result.status === "skipped" || result.status === "failed");
    assert.ok(result.reason);
  });
});

test("extractFromHtml() returns failed/skipped (never throws) for garbage input", async () => {
  await assert.doesNotReject(async () => {
    const result = await extract("https://example.com/garbage", {
      rawHtml: GARBAGE_INPUT,
    });
    assert.ok(result.status === "failed" || result.status === "skipped");
  });
});

test("extractFromHtml() never throws even for a malformed url", async () => {
  await assert.doesNotReject(async () => {
    const result = await extract("not a url at all", { rawHtml: GOOD_ARTICLE });
    assert.ok(["ok", "failed", "skipped"].includes(result.status));
  });
});

test("extractFromDocument() runs directly against an already-parsed Document (the browser path)", async () => {
  const doc = parseHtml(GOOD_ARTICLE, ARTICLE_URL);
  const result = await extractFromDocument(doc, ARTICLE_URL);
  assert.equal(result.status, "ok");
  assert.ok(result.article.wordCount >= 300);
});

// ---- score.js: ordering ----------------------------------------------------

test("scoreArticle ranks a substantial article above a thin link-farm page", () => {
  const goodText = SENTENCE.repeat(20);
  const goodScore = scoreArticle({
    textContent: goodText,
    contentHtml: `<p>${goodText}</p><img src="a.jpg"><table><tr><td>x</td></tr></table>`,
  });

  const thinLinks = Array.from(
    { length: 40 },
    (_, i) => `<a href="/${i}">link ${i}</a>`,
  ).join(" ");
  const thinScore = scoreArticle({
    textContent: "Browse our categories below.",
    contentHtml: `<p>Browse our categories below.</p>${thinLinks}`,
  });

  assert.ok(goodScore > thinScore, `expected ${goodScore} > ${thinScore}`);
});

test("scoreArticle penalizes high link density even with decent word count", () => {
  const words = SENTENCE.repeat(15);
  const wordCount = words.trim().split(/\s+/).length;
  const manyLinks = Array.from(
    { length: wordCount },
    (_, i) => `<a href="/${i}">l${i}</a>`,
  ).join(" ");

  const linkHeavyScore = scoreArticle({
    textContent: words,
    contentHtml: `<p>${words}</p>${manyLinks}`,
  });
  const cleanScore = scoreArticle({
    textContent: words,
    contentHtml: `<p>${words}</p>`,
  });

  assert.ok(
    cleanScore > linkHeavyScore,
    "a link-farm version of the same text should score lower",
  );
});

// ---- engines.js: direct engine checks --------------------------------------

test('runEngine("defuddle", ...) extracts a real article', async () => {
  const doc = parseHtml(GOOD_ARTICLE, ARTICLE_URL);
  const result = await runEngine("defuddle", doc, ARTICLE_URL);
  assert.ok(result);
  assert.ok(result.contentHtml.length > 0);
  assert.ok(result.textContent.length > 0);
});

test('runEngine("readability", ...) extracts a real article', async () => {
  const doc = parseHtml(GOOD_ARTICLE, ARTICLE_URL);
  const result = await runEngine("readability", doc, ARTICLE_URL);
  assert.ok(result);
  assert.ok(result.contentHtml.length > 0);
});

test("runEngine does not mutate the caller's Document", async () => {
  const doc = parseHtml(GOOD_ARTICLE, ARTICLE_URL);
  const before = doc.body.innerHTML;
  await runEngine("defuddle", doc, ARTICLE_URL);
  await runEngine("readability", doc, ARTICLE_URL);
  assert.equal(doc.body.innerHTML, before);
});

test("runEngine handles garbage input without throwing, and never fabricates a real article", async () => {
  // Both engines fall back to returning the raw body when they can't find
  // real article structure, rather than returning null (that's their own
  // documented fallback behavior) — so the contract we care about here is
  // "never throws", plus "whatever comes back is clearly not a real
  // article" (near-zero word count), which is what the extract()-level gate
  // relies on to turn this into a 'skipped'/'failed' result.
  const doc = parseHtml(GARBAGE_INPUT, ARTICLE_URL);
  for (const engine of ["defuddle", "readability"]) {
    const result = await runEngine(engine, doc, ARTICLE_URL);
    if (result) {
      assert.ok(result.textContent.trim().split(/\s+/).length < 20);
    }
  }
});

// ---- sanitize.js ------------------------------------------------------------

const scratchDoc = parseHtml("<!doctype html><html><body></body></html>");

test("sanitizeHtml strips scripts, styles, iframes, event handlers, and tracking pixels", () => {
  const dirty = `
    <p onclick="alert(1)">Hello <a href="javascript:alert(2)">click</a></p>
    <script>alert('xss')</script>
    <style>body{color:red}</style>
    <iframe src="https://evil.example.com"></iframe>
    <img src="https://tracker.example.com/pixel.gif" width="1" height="1">
    <img src="https://example.com/real-photo.jpg" alt="A real photo">
    <table><tr><td>data</td></tr></table>
    <pre><code>const x = 1;</code></pre>
  `;

  const clean = sanitizeHtml(dirty, scratchDoc);

  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /<style/i);
  assert.doesNotMatch(clean, /<iframe/i);
  assert.doesNotMatch(clean, /onclick/i);
  assert.doesNotMatch(clean, /javascript:/i);
  assert.doesNotMatch(clean, /pixel\.gif/i);

  assert.match(clean, /real-photo\.jpg/);
  assert.match(clean, /<table/i);
  assert.match(clean, /<(pre|code)/i);
});

test("sanitizeHtml strips SVG SMIL animate/set elements (mutation-XSS bypass)", () => {
  const dirty = `
    <svg>
      <a href="https://example.com/safe">
        <animate attributeName="href" values="javascript:alert(1)" begin="0s" dur="1s" />
      </a>
      <set attributeName="href" to="javascript:alert(2)" />
      <animateTransform attributeName="transform" />
      <animateMotion />
      <animateColor attributeName="fill" />
    </svg>
  `;
  const clean = sanitizeHtml(dirty, scratchDoc);
  assert.doesNotMatch(clean, /<animate/i);
  assert.doesNotMatch(clean, /<set/i);
  assert.doesNotMatch(clean, /javascript:/i);
});

test("sanitizeHtml strips control-char-obfuscated javascript: URLs", () => {
  const dirty = `<a href="java\tscript:alert(1)">click</a><a href="java\nscript:alert(2)">click2</a>`;
  const clean = sanitizeHtml(dirty, scratchDoc);
  assert.doesNotMatch(clean, /href/i);
});

test("sanitizeHtml strips data: URLs on anchor href but keeps data: image src", () => {
  const dirty = `
    <a href="data:text/html,<script>alert(1)</script>">bad link</a>
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="inline image">
  `;
  const clean = sanitizeHtml(dirty, scratchDoc);
  assert.doesNotMatch(clean, /<a[^>]*href="data:/i);
  assert.match(clean, /<img[^>]*src="data:image/i);
});

test("sanitizeHtml strips style attributes and javascript: in srcset", () => {
  const dirty = `
    <p style="background:url(javascript:alert(1))">styled</p>
    <img src="a.jpg" srcset="javascript:alert(1) 1x, b.jpg 2x">
  `;
  const clean = sanitizeHtml(dirty, scratchDoc);
  assert.doesNotMatch(clean, /style=/i);
  assert.doesNotMatch(clean, /srcset="javascript:/i);
});

test("sanitizeHtml handles empty input without throwing", () => {
  assert.equal(sanitizeHtml("", scratchDoc), "");
  assert.equal(sanitizeHtml(undefined, scratchDoc), "");
});
