// content-extract.js — injected into a page's live DOM via chrome.scripting.
//
// Self-contained classic script (bundled as an IIFE). On load it defines
// `window.__kindlingExtract`, which runs the shared extraction engine
// against the real, already-rendered/authenticated `document` and returns a
// plain, structurable ContentResult (Article is JSON-safe — no DOM nodes).
//
// The caller (adapters.js `makeContentSource`) injects this file once via
// `chrome.scripting.executeScript({files:['content-extract.js']})`, then a
// second `executeScript` with a tiny `func` reads `window.__kindlingExtract()`
// so the return value crosses back through the scripting API's structured
// clone. This file itself performs no messaging — it just exposes the hook.

import { extractFromDocument } from "@kindling/core/extract";

const DEFAULT_MIN_WORDS = 300;

window.__kindlingExtract = async function () {
  const minWords =
    typeof window.__kindlingMinWords === "number"
      ? window.__kindlingMinWords
      : DEFAULT_MIN_WORDS;

  try {
    // extractFromDocument is async (the engine chain awaits internally,
    // e.g. Defuddle) despite the interface doc's shorthand return type —
    // chrome.scripting.executeScript awaits a Promise return value from an
    // injected function, so this resolves cleanly across the bridge either
    // way, but callers of window.__kindlingExtract() directly must await it.
    return await extractFromDocument(document, location.href, { minWords });
  } catch (err) {
    // extractFromDocument is documented as "never throws", but this is the
    // one place a bug there would otherwise break chrome.scripting's return
    // value entirely (an uncaught exception in an injected function surfaces
    // as an executeScript error, losing the reason). Fail closed instead.
    return { status: "failed", reason: `extract threw: ${err && err.message}` };
  }
};
