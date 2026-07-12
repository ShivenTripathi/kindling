// index.js
//
// Orchestrates the extraction chain described in docs/rework-interfaces.md
// (`src/extract/index.js` section):
//
//   Document (already parsed, already fetched — never fetched here)
//     -> run both engines
//     -> score
//     -> pick best
//     -> sanitize
//     -> article gate (minWords / minScore)
//
// Never throws for a bad page — always resolves to a
// `import('../ports.js').ContentResult`. This is the core-quality module in
// the pipeline (see CLAUDE.md's architecture line and invariant 5, "nothing
// silently dropped": every skip/failure here must carry a `reason` a human
// can act on, since it surfaces verbatim in `--dry-run` and
// `kindling history`).
//
// DOM-driven, not fetch-driven: `fetch.js` (the tiered, SSRF-guarded
// network fetcher) intentionally did NOT move into core — it's a
// platform/network concern that stays in the cli/desktop surface (core never
// fetches; see ports.js's `ContentSource`). What moved is everything
// downstream of "I already have a Document": the engine chain, scoring, and
// sanitizer, unchanged from src/extract/{engines,score,sanitize}.js.

import { runEngine, ENGINE_ORDER } from "./engines.js";
import { scoreArticle } from "./score.js";
import { sanitizeHtml } from "./sanitize.js";

const DEFAULT_MIN_WORDS = 300;

/**
 * @typedef {Object} ExtractOptions
 * @property {number} [minWords=300]     // article gate threshold
 * @property {number} [minScore]         // quality gate
 * @property {boolean} [disableWayback]  // fetch-tier concern; accepted and ignored here
 * @property {string} [source]           // passed through onto article.source (default 'dom')
 */

function countWords(textContent) {
  if (!textContent) return 0;
  const trimmed = textContent.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Run every engine (in bake-off precedence order) against the same source
// Document and return every non-empty candidate, scored. Each `runEngine`
// call gets its own clone of `doc` internally (see engines.js) — this
// function never mutates the Document the caller handed in.
async function runEnginesAgainst(doc, url) {
  const candidates = [];
  for (const engine of ENGINE_ORDER) {
    const result = await runEngine(engine, doc, url);
    if (!result) continue;
    const wordCount = countWords(result.textContent);
    const score = scoreArticle({
      textContent: result.textContent,
      contentHtml: result.contentHtml,
    });
    candidates.push({ ...result, engine, score, wordCount });
  }
  return candidates;
}

function pickBest(candidates) {
  if (candidates.length === 0) return null;
  // Strict `>` (not `>=`) so a tie keeps the earlier candidate — combined
  // with ENGINE_ORDER listing Defuddle first, that's the locked tie-break:
  // Defuddle wins ties over Readability.
  return candidates.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  );
}

/** Run the engine chain on an already-parsed Document, score, sanitize,
 * gate. Never throws.
 * @param {Document} doc
 * @param {string} url
 * @param {ExtractOptions} [opts]
 * @returns {Promise<import('../ports.js').ContentResult>} */
export async function extractFromDocument(doc, url, opts = {}) {
  const minWords = opts.minWords ?? DEFAULT_MIN_WORDS;

  try {
    const candidates = await runEnginesAgainst(doc, url);
    const best = pickBest(candidates);
    if (!best) {
      return {
        status: "failed",
        reason: "no engine could extract content from this page",
      };
    }

    const sanitized = sanitizeHtml(best.contentHtml, doc);
    const wordCount = countWords(best.textContent);

    if (wordCount < minWords) {
      return {
        status: "skipped",
        reason: `too short: ${wordCount} words (minimum ${minWords})`,
      };
    }
    if (typeof opts.minScore === "number" && best.score < opts.minScore) {
      return {
        status: "skipped",
        reason: `quality score ${best.score.toFixed(1)} below minimum ${opts.minScore}`,
      };
    }

    /** @type {import('../ports.js').Article} */
    const article = {
      url,
      title: best.title || "",
      byline: best.byline,
      siteName: best.siteName,
      publishedTime: best.publishedTime,
      contentHtml: sanitized,
      textContent: best.textContent,
      wordCount,
      engine: best.engine,
      score: best.score,
      source: opts.source || "dom",
    };

    return { status: "ok", article };
  } catch (err) {
    return {
      status: "failed",
      reason: `unexpected extraction error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Convenience: parse HTML into a Document via an injected parser, then
 * extract. This is how Node code (and tests) drive extraction — pass
 * linkedom's `parseHTML` (or jsdom's, in a caller that already depends on
 * it) as `opts.parseHtml`. Never throws: a parser that itself throws on
 * malformed input is treated the same as "no engine could extract content".
 * @param {string} html
 * @param {string} url
 * @param {{parseHtml:(html:string,url:string)=>Document} & ExtractOptions} opts
 * @returns {Promise<import('../ports.js').ContentResult>} */
export async function extractFromHtml(html, url, opts) {
  const { parseHtml, ...extractOpts } = opts || {};
  if (typeof parseHtml !== "function") {
    return {
      status: "failed",
      reason: "extractFromHtml requires opts.parseHtml(html, url) => Document",
    };
  }
  let doc;
  try {
    doc = parseHtml(html, url);
  } catch (err) {
    return {
      status: "failed",
      reason: `could not parse html: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!doc) {
    return { status: "failed", reason: "parseHtml returned no document" };
  }
  return extractFromDocument(doc, url, extractOpts);
}
