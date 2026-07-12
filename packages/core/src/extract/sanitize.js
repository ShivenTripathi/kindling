// sanitize.js
//
// Sanitize the winning engine's contentHtml before it goes anywhere near an
// EPUB. Both engines already strip most chrome/boilerplate, but their output
// is still attacker-influenced HTML (it came from an arbitrary web page), so
// we don't trust it as-is: EPUB readers (including Kindle's) render HTML/CSS
// and some support embedded JS-adjacent features, so leftover <script>,
// event handlers, or javascript: URLs are a real risk, not a theoretical one.
//
// Every guard below (disallowed tags, SVG-SMIL animate/set stripping,
// control-char-obfuscated javascript: detection, data:-on-href blocking,
// tracking-pixel removal) is ported verbatim from src/extract/sanitize.js —
// see docs/rework-interfaces.md ("keep the sanitizer... exactly").
//
// Dependency choice (the one thing that DID change from src/extract/):
// the original sanitized by parsing into a jsdom document, because jsdom was
// already a hard dependency of the engines. Core can't do that — jsdom is
// Node-only and too heavy to ship in a browser bundle (see engines.js's
// module comment) — and core must work with whatever minimal DOM
// implementation the caller is running under (a real browser `document`, or
// linkedom in Node/tests). So instead of constructing our own scratch
// document, we ask the CALLER for one: `sanitizeHtml(html, doc)` uses
// `doc.createElement('div')` + `.innerHTML` as the scratch parse target.
// `createElement`/`innerHTML`/`querySelectorAll` are plain standard DOM,
// supported identically by a real browser document and by linkedom, so this
// needs no new dependency and no jsdom-specific behavior.

// Elements with no place in a read-only EPUB body: script/style are the
// obvious XSS/behavior vector; iframe/object/embed/applet embed arbitrary
// external content we have no control over; form controls are interactive
// UI that can't do anything useful in a static ebook; link/meta/base/title
// are `<head>`-only elements that occasionally leak into fragments.
const DISALLOWED_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "noscript",
  "link",
  "meta",
  "base",
  "title",
  // SVG SMIL animation elements can rewrite a sibling/parent attribute (e.g.
  // <animate attributeName="href" values="javascript:…">) at render time — a
  // mutation-XSS the on*/javascript:/data: attribute filters don't anticipate,
  // since attributeName/values/to don't look like URLs. Strip them outright.
  "animate",
  "set",
  "animatemotion",
  "animatecolor",
  "animatetransform",
];

const TRACKING_SRC_MARKERS = [
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.com/tr",
  "facebook.com/plugins/like",
  "scorecardresearch.com",
  "/pixel.gif",
  "/pixel?",
  "beacon.",
  "/beacon?",
  "piwik.php",
  "matomo.php",
];

function isTrackingPixel(img) {
  const width = img.getAttribute("width");
  const height = img.getAttribute("height");
  if (width === "1" && height === "1") return true;
  const src = (img.getAttribute("src") || "").toLowerCase();
  return TRACKING_SRC_MARKERS.some((marker) => src.includes(marker));
}

// Browsers strip ALL C0 control characters (tabs, newlines, CRs, and other
// 0x00-0x1F bytes) from an attribute value before scheme-matching it — that
// is standard URL-parsing behavior, not a bug — so `java\tscript:` and
// `java\nscript:` are both live `javascript:` URLs to a real browser even
// though a naive `/^\s*javascript:/` regex (which only trims leading
// whitespace) doesn't see it. We normalize the same way before any
// scheme check below.
function stripControlChars(value) {
  return value.replace(/[\x00-\x1f]/g, "");
}

function isJavascriptUrl(value) {
  return /^\s*javascript:/i.test(stripControlChars(value));
}

// `data:` URLs are legitimate (and common) on <img src> — that's how a lot
// of inlined/placeholder images arrive — but on an <a href> a `data:` URL
// can carry a full inline document (`data:text/html,<script>...`), which
// is just as capable of running script as a `javascript:` URL once the
// reader follows the link. So we block `data:` only on link-ish attributes,
// never on <img src>.
function isDataUrl(value) {
  return /^\s*data:/i.test(stripControlChars(value));
}

const LINK_ATTRS = new Set(["href", "xlink:href"]);

function stripUnsafeAttributes(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const value = attr.value || "";

    if (name.startsWith("on")) {
      el.removeAttribute(attr.name); // inline event handlers (onclick, onerror, ...)
      continue;
    }

    // Strip `style` entirely: EPUB CSS is our own, and inline style is a
    // real vector (`background:url(javascript:...)`, `width:expression(...)`
    // in legacy-IE-style CSS engines, etc.) that's easier to remove outright
    // than to safely parse and allow-list.
    if (name === "style") {
      el.removeAttribute(attr.name);
      continue;
    }

    if (name === "srcset") {
      if (
        isJavascriptUrl(value) ||
        value.toLowerCase().includes("javascript:")
      ) {
        el.removeAttribute(attr.name);
      }
      continue;
    }

    if (name === "src" || (LINK_ATTRS.has(name) && tag === "img")) {
      // `data:` images are fine (and common); `javascript:` never is.
      if (isJavascriptUrl(value)) el.removeAttribute(attr.name);
      continue;
    }

    if (LINK_ATTRS.has(name)) {
      // Anchor/link hrefs: block both javascript: and data: schemes.
      if (isJavascriptUrl(value) || isDataUrl(value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/** Sanitize article HTML for embedding in an EPUB. Keeps images, tables,
 * pre/code, headings, lists, blockquotes, and links; strips everything with
 * script-execution or external-embed capability, plus tracking pixels.
 * @param {string} contentHtml
 * @param {Document} doc  scratch Document used only as a parser (a real
 *   browser `document`, or a linkedom document in Node) — never mutated by
 *   reference; sanitization happens on a detached element created from it.
 * @returns {string} sanitized HTML (safe to embed as EPUB body content) */
export function sanitizeHtml(contentHtml, doc) {
  if (!contentHtml || !contentHtml.trim()) return "";

  const scratch = doc.createElement("div");
  scratch.innerHTML = contentHtml;

  for (const tag of DISALLOWED_TAGS) {
    for (const el of [...scratch.querySelectorAll(tag)]) {
      el.remove();
    }
  }

  for (const img of [...scratch.querySelectorAll("img")]) {
    if (isTrackingPixel(img)) {
      img.remove();
    }
  }

  for (const el of [...scratch.querySelectorAll("*")]) {
    stripUnsafeAttributes(el);
  }

  return scratch.innerHTML.trim();
}
