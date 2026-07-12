// engines.js
//
// Thin, uniform wrapper around the two engines the Phase-0 bake-off kept:
// Defuddle (primary) and Readability (fallback). Postlight is excluded —
// see docs/interfaces.md for why (dormant, crashes on some pages, and makes
// silent live network fetches during parse, which is unacceptable for a
// fetch-once/parse-offline pipeline).
//
// Both engines need a DOM, not a raw string, so we build a fresh DOM per
// engine call rather than sharing one document between them: both engines
// mutate/strip the document as part of parsing (Readability's parse() is
// documented as destructive), so reusing a document across two engine calls
// would make the second call see whatever the first one left behind.
//
// Defuddle runs against a linkedom document, NOT jsdom. jsdom's CSS selector
// engine (nwsapi) doesn't support `:has()`, and Defuddle's own extraction
// logic uses `:has()` selectors internally — on jsdom that throws
// `SyntaxError: ':has(...)' is not a valid selector` on essentially every
// real page, silently breaking the primary engine and pushing every article
// onto the Readability fallback. linkedom's selector engine supports
// `:has()`, which is exactly what the Phase-0 bake-off ran Defuddle against
// (see docs/interfaces.md). Readability stays on jsdom, its native/tested
// environment.

import { JSDOM } from "jsdom";
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { Readability } from "@mozilla/readability";

/**
 * @typedef {Object} EngineResult
 * @property {string} title
 * @property {string} [byline]
 * @property {string} [siteName]
 * @property {string} [publishedTime] // ISO, only set if parseable
 * @property {string} contentHtml
 * @property {string} textContent
 */

// A handful of formats sites actually emit in <meta> / schema.org date
// fields that `new Date()` parses fine, plus plain "YYYY-MM-DD". We only
// promote a date to `publishedTime` when it round-trips through `Date`
// cleanly — a garbled/partial date is worse than omitting the field.
function toIsoOrUndefined(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

// Neither engine hands back plain text alongside HTML in the same shape
// (Readability does; Defuddle only returns content HTML + a metadata word
// count), so we derive text content uniformly from the winning HTML rather
// than trusting two different code paths to agree on whitespace handling.
function htmlToText(html) {
  if (!html) return "";
  const dom = new JSDOM(`<body>${html}</body>`);
  return (dom.window.document.body.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Defuddle logs internally (console.error) on some parse failures even
// though it also rejects/returns falsy — we don't want that spamming stderr
// during normal operation (a page Defuddle can't handle is an expected,
// routine fallback-to-Readability case, not an operational error). Swallow
// console.error for the duration of the call and always resolve to `null`
// on any failure, same contract as runEngine's outer try/catch.
async function runDefuddle(document, url) {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await Defuddle(document, url, { markdown: false });
    if (!result || !result.content || !result.content.trim()) return null;
    return {
      title: result.title || "",
      byline: result.author || undefined,
      siteName: result.site || undefined,
      publishedTime: toIsoOrUndefined(result.published),
      contentHtml: result.content,
      textContent: htmlToText(result.content),
    };
  } catch {
    return null;
  } finally {
    console.error = originalConsoleError;
  }
}

function runReadability(document) {
  const reader = new Readability(document);
  const article = reader.parse();
  if (!article || !article.content || !article.content.trim()) return null;
  return {
    title: article.title || "",
    byline: article.byline || undefined,
    siteName: article.siteName || undefined,
    publishedTime: toIsoOrUndefined(article.publishedTime),
    contentHtml: article.content,
    textContent: (article.textContent || "").replace(/\s+/g, " ").trim(),
  };
}

/** Run one named engine ('defuddle' | 'readability') against `html`.
 * Never throws — a parse failure or a page the engine can't handle both
 * resolve to `null` so the caller can just try the next engine.
 * @param {'defuddle'|'readability'} name
 * @param {string} html
 * @param {string} url
 * @returns {Promise<EngineResult|null>} */
export async function runEngine(name, html, url) {
  try {
    if (name === "defuddle") {
      // linkedom, not jsdom — see the module comment: jsdom's nwsapi
      // selector engine can't evaluate `:has()`, which Defuddle relies on.
      // Mirrors Defuddle's own (deprecated) string-input path
      // (defuddle/dist/utils/linkedom-compat.js): linkedom doesn't implement
      // styleSheets/getComputedStyle, which Defuddle's internals probe, and
      // document.URL needs to be set explicitly for relative-URL resolution
      // and extractor host-matching (linkedom allows mutating the
      // spec-read-only URL property; jsdom does not, which is why this
      // can't just be bolted onto the jsdom path instead).
      // linkedom's documents are plain mutable objects, but TS types them as
      // the spec DOM (read-only styleSheets/URL). Treat as `any` so the
      // compat shims below typecheck; they're valid at runtime on linkedom.
      const { document } = /** @type {any} */ (parseHTML(html));
      if (!document.styleSheets) document.styleSheets = [];
      if (document.defaultView && !document.defaultView.getComputedStyle) {
        document.defaultView.getComputedStyle = () => ({ display: "" });
      }
      if (url) document.URL = url;
      return await runDefuddle(document, url);
    }
    if (name === "readability") {
      const dom = new JSDOM(html, { url, pretendToBeVisual: true });
      return runReadability(dom.window.document);
    }
    throw new Error(`unknown engine: ${name}`);
  } catch {
    return null;
  }
}

/** Engine names in the locked bake-off precedence order (primary first).
 * @type {Array<'defuddle'|'readability'>} */
export const ENGINE_ORDER = ["defuddle", "readability"];
