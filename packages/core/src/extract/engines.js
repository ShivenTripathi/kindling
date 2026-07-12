// engines.js
//
// Thin, uniform wrapper around the two engines the Phase-0 bake-off kept:
// Defuddle (primary) and Readability (fallback). Postlight is excluded —
// see docs/interfaces.md for why (dormant, crashes on some pages, and makes
// silent live network fetches during parse, which is unacceptable for a
// fetch-once/parse-offline pipeline).
//
// DOM-driven, not fetch-driven (docs/rework-interfaces.md): both engines run
// against a `Document` the caller already has — a real browser `document`,
// or a linkedom/jsdom-style document a Node caller parsed — never one this
// module builds by fetching or by parsing an HTML string itself. That's also
// why this file must not import `jsdom`: it's Node-only and far too heavy to
// ship in a browser bundle. `defuddle` and `@mozilla/readability` are both
// browser-capable, so those stay real dependencies; the Node-only DOM
// implementation (linkedom, or jsdom) is entirely the CALLER's choice, made
// once, before extraction ever starts (see extract/index.js's
// `extractFromHtml`, which takes an injected `parseHtml`).
//
// Both engines still get their OWN, independent copy of the document rather
// than sharing the one the caller handed in: both engines mutate/strip the
// document as part of parsing (Readability's parse() is documented as
// destructive), so (a) reusing one document across two engine calls would
// make the second call see whatever the first left behind, and (b) the
// caller's document must never be mutated out from under it — in the
// browser that document IS the live page. So every call below runs against
// a fresh `doc.cloneNode(true)` of the ORIGINAL document, not of whatever a
// previous engine call may have mutated.
//
// A cloned Document is a detached document (no associated window), so a
// couple of environment features a live document normally has for free —
// `styleSheets`, `defaultView.getComputedStyle` — may be missing after the
// clone, in a real browser as well as in linkedom. Defuddle already treats
// both as optional (it falls back to `null`/skips style-based heuristics
// when they're unavailable — see its `utils.getComputedStyle`), so this is
// a best-effort, try/catch-guarded shim, matching the graceful-degradation
// contract `runEngine` already promises callers (never throws; a page an
// engine can't fully handle just falls back to the next engine).

import Defuddle from "defuddle";
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
// Uses the same scratch-element trick as sanitize.js — no extra parser dep.
function htmlToText(html, doc) {
  if (!html) return "";
  const scratch = doc.createElement("div");
  scratch.innerHTML = html;
  return (scratch.textContent || "").replace(/\s+/g, " ").trim();
}

// Best-effort shims for the environment features a *detached* clone may be
// missing (see module comment). Every step is independently guarded: on a
// real, still-attached document every one of these is already true and each
// try just no-ops.
function shimDetachedDocument(doc, url) {
  try {
    if (!doc.styleSheets) doc.styleSheets = [];
  } catch {
    /* read-only on this implementation; fine to skip */
  }
  try {
    if (!doc.defaultView) {
      doc.defaultView = { getComputedStyle: () => ({ display: "" }) };
    } else if (!doc.defaultView.getComputedStyle) {
      doc.defaultView.getComputedStyle = () => ({ display: "" });
    }
  } catch {
    /* defaultView not assignable here; Defuddle tolerates its absence */
  }
  try {
    if (url) doc.URL = url;
  } catch {
    /* read-only `URL` on this implementation (e.g. a real Document) */
  }
  // Readability resolves relative URLs off `doc.baseURI`/`doc.documentURI`,
  // neither of which a bare document clone derives from `doc.URL` on every
  // DOM implementation (linkedom notably doesn't). A <base href> is the one
  // standard, spec-respected way to set baseURI that works identically
  // everywhere, and is a no-op if the document already has one.
  try {
    if (url && doc.querySelector && !doc.querySelector("base[href]")) {
      const head =
        doc.head || (doc.querySelector && doc.querySelector("head"));
      if (head && doc.createElement) {
        const base = doc.createElement("base");
        base.setAttribute("href", url);
        head.insertBefore(base, head.firstChild);
      }
    }
  } catch {
    /* best-effort only */
  }
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
    // `defuddle`'s published .d.ts declares a real ESM `export default`, but
    // the package ships CJS with no `esModuleInterop`/`allowSyntheticDefaultImports`
    // configured for this project's tsc invocation, so tsc can't see through
    // to the constructable class here even though the runtime import (proven
    // by the extract test suite) is exactly right. Narrow, local `any` cast
    // rather than changing the project's global module-interop settings.
    const DefuddleCtor = /** @type {any} */ (Defuddle);
    const defuddle = new DefuddleCtor(document, { url, markdown: false });
    const result = await defuddle.parseAsync();
    if (!result || !result.content || !result.content.trim()) return null;
    return {
      title: result.title || "",
      byline: result.author || undefined,
      siteName: result.site || undefined,
      publishedTime: toIsoOrUndefined(result.published),
      contentHtml: result.content,
      textContent: htmlToText(result.content, document),
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

/** Run one named engine ('defuddle' | 'readability') against a clone of
 * `doc`. Never throws — a parse failure or a page the engine can't handle
 * both resolve to `null` so the caller can just try the next engine.
 * @param {'defuddle'|'readability'} name
 * @param {Document} doc  the caller's Document — never mutated; each call
 *   works against its own `doc.cloneNode(true)`.
 * @param {string} url
 * @returns {Promise<EngineResult|null>} */
export async function runEngine(name, doc, url) {
  try {
    const clone = /** @type {any} */ (doc.cloneNode(true));
    shimDetachedDocument(clone, url);
    if (name === "defuddle") {
      return await runDefuddle(clone, url);
    }
    if (name === "readability") {
      return runReadability(clone);
    }
    throw new Error(`unknown engine: ${name}`);
  } catch {
    return null;
  }
}

/** Engine names in the locked bake-off precedence order (primary first).
 * @type {Array<'defuddle'|'readability'>} */
export const ENGINE_ORDER = ["defuddle", "readability"];
