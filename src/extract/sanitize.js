// sanitize.js
//
// Sanitize the winning engine's contentHtml before it goes anywhere near an
// EPUB. Both engines already strip most chrome/boilerplate, but their output
// is still attacker-influenced HTML (it came from an arbitrary web page), so
// we don't trust it as-is: EPUB readers (including Kindle's) render HTML/CSS
// and some support embedded JS-adjacent features, so leftover <script>,
// event handlers, or javascript: URLs are a real risk, not a theoretical one.
//
// Dependency choice: jsdom is already a hard dependency (both engines need
// it), so we sanitize by parsing into a jsdom document and removing/cleaning
// nodes directly rather than adding DOMPurify. DOMPurify is the more
// battle-tested choice for sanitizing HTML that will be rendered in a full
// browser with live JS — but our threat model here is narrower (static EPUB
// content, no script execution environment at render time), and the set of
// things we must strip is small and enumerable. Revisit if EPUB readers turn
// out to execute more than we assume.

import { JSDOM } from "jsdom";

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
 * @returns {string} sanitized HTML (safe to embed as EPUB body content) */
export function sanitizeHtml(contentHtml) {
  if (!contentHtml || !contentHtml.trim()) return "";

  const dom = new JSDOM(`<!doctype html><body>${contentHtml}</body>`);
  const { document } = dom.window;

  for (const tag of DISALLOWED_TAGS) {
    for (const el of [...document.querySelectorAll(tag)]) {
      el.remove();
    }
  }

  for (const img of [...document.querySelectorAll("img")]) {
    if (isTrackingPixel(img)) {
      img.remove();
    }
  }

  for (const el of [...document.body.querySelectorAll("*")]) {
    stripUnsafeAttributes(el);
  }

  return document.body.innerHTML.trim();
}
