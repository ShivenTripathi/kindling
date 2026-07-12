// index.js
//
// Orchestrates the extraction chain described in docs/interfaces.md:
//
//   fetch (tier escalation driven by extraction quality)
//     -> run both engines
//     -> score
//     -> pick best
//     -> sanitize
//     -> article gate (minWords / minScore)
//
// Never throws for a bad page — always resolves to an ExtractResult. This is
// the core-quality module in the pipeline (see CLAUDE.md's architecture
// line and invariant 5, "nothing silently dropped": every skip/failure here
// must carry a `reason` a human can act on, since it surfaces verbatim in
// `--dry-run` and `kindling history`).

import { fetchPage, fetchTier2Chrome, fetchTier3Wayback } from "./fetch.js";
import { runEngine, ENGINE_ORDER } from "./engines.js";
import { scoreArticle } from "./score.js";
import { sanitizeHtml } from "./sanitize.js";

const DEFAULT_MIN_WORDS = 300;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * @typedef {Object} Article
 * @property {string} url
 * @property {string} title
 * @property {string} [byline]
 * @property {string} [siteName]
 * @property {string} [publishedTime] // ISO if detected
 * @property {string} contentHtml     // sanitized article HTML (images/tables/code preserved)
 * @property {string} textContent     // plain text (for word-count/gating)
 * @property {number} wordCount
 * @property {string} engine          // which engine won
 * @property {number} score           // extraction quality score
 * @property {string} fetchTier       // 'raw' | 'tier1' | 'tier2' | 'tier3'
 */

/**
 * @typedef {Object} ExtractResult
 * @property {'ok'|'skipped'|'failed'} status
 * @property {Article} [article]      // when ok
 * @property {string} [reason]        // when skipped/failed (surfaced to user)
 */

/**
 * @typedef {Object} ExtractOptions
 * @property {number} [minWords=300]     // article gate threshold
 * @property {number} [minScore]         // quality gate
 * @property {number} [timeoutMs=20000]
 * @property {string} [userAgent]
 * @property {string} [rawHtml]          // bypass fetch (for tests, and Phase 3 extension)
 * @property {boolean} [disableWayback]  // skip the tier-3 archive.org fallback (privacy)
 * @property {string} [chromePath]       // override the headless-Chrome binary path
 */

function countWords(textContent) {
  if (!textContent) return 0;
  const trimmed = textContent.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Run both engines (in bake-off precedence order) against one fetched HTML
// document and return every non-empty candidate, scored, tagged with the
// tier that produced the HTML they were run against.
async function runEnginesAgainst(html, url, tier) {
  const candidates = [];
  for (const engine of ENGINE_ORDER) {
    const result = await runEngine(engine, html, url);
    if (!result) continue;
    const wordCount = countWords(result.textContent);
    const score = scoreArticle({
      textContent: result.textContent,
      contentHtml: result.contentHtml,
    });
    candidates.push({ ...result, engine, score, wordCount, fetchTier: tier });
  }
  return candidates;
}

function pickBest(candidates) {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  );
}

// A candidate is "thin" when it isn't worth stopping at — either nothing
// parsed at all, or word count falls short of the gate we're about to apply.
// This is the "downstream extraction is empty/thin" escalation condition
// from docs/interfaces.md that fetch.js can't evaluate on its own (see the
// module comment in fetch.js).
function isThin(best, minWords) {
  if (!best) return true;
  return best.wordCount < minWords;
}

/** Fetch + extract one URL through the scored engine chain, then apply the
 * article gate (min word count / min score). Never throws for a bad page —
 * returns {status:'failed'|'skipped', reason}.
 * @param {string} url
 * @param {ExtractOptions} [opts]
 * @returns {Promise<ExtractResult>} */
export async function extract(url, opts = {}) {
  const minWords = opts.minWords ?? DEFAULT_MIN_WORDS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchOpts = {
    timeoutMs,
    userAgent: opts.userAgent,
    chromePath: opts.chromePath,
  };

  try {
    let candidates;
    let finalUrl = url;

    if (typeof opts.rawHtml === "string") {
      // Phase 3 extension path: caller already supplied rendered DOM (the
      // premium source — the user's authenticated, JS-executed page).
      // Bypass the fetcher entirely.
      candidates = await runEnginesAgainst(opts.rawHtml, url, "raw");
    } else {
      let fetched;
      try {
        fetched = await fetchPage(url, fetchOpts);
      } catch (err) {
        return {
          status: "failed",
          reason: `could not fetch page: ${err.message}`,
        };
      }
      finalUrl = fetched.finalUrl;
      candidates = await runEnginesAgainst(
        fetched.html,
        finalUrl,
        fetched.tier,
      );

      // Escalate when extraction came back thin, even though the HTTP
      // request itself "succeeded" (e.g. a JS-only SPA shell, or a page
      // that rendered but is still short). `fetchPage()` may have already
      // internally escalated tier1 -> tier2 (see fetch.js: it does that on
      // an HTTP-level failure/challenge, which it CAN detect on its own) and
      // returned `tier: 'tier2'` — so we must not gate the tier3/Wayback
      // escalation on "started at tier1"; that would make Wayback
      // unreachable for exactly the pages tier2 rendered but still came back
      // thin (a Cloudflare challenge that resolves to a real page, which is
      // then too short). Escalate to whichever further tiers we haven't
      // tried yet, in order, keeping every non-empty candidate set seen
      // along the way so pickBest() at the end chooses the best result
      // across ALL tiers attempted, not just the last one tried.
      if (isThin(pickBest(candidates), minWords)) {
        if (fetched.tier !== "tier2") {
          const tier2 = await fetchTier2Chrome(url, fetchOpts).catch(
            () => null,
          );
          if (tier2) {
            const tier2Candidates = await runEnginesAgainst(
              tier2.html,
              tier2.finalUrl,
              "tier2",
            );
            if (tier2Candidates.length > 0) {
              finalUrl = tier2.finalUrl;
              candidates = [...candidates, ...tier2Candidates];
            }
          }
        }

        // fetchPage() never returns tier: 'tier3' itself (that's only
        // reachable through this explicit escalation path), so there's no
        // equivalent "already tried tier3" case to guard against here.
        // Wayback discloses the URL to a third party (archive.org), so it can
        // be turned off entirely via opts.disableWayback (config.disableWayback).
        if (!opts.disableWayback && isThin(pickBest(candidates), minWords)) {
          const tier3 = await fetchTier3Wayback(url, fetchOpts);
          if (tier3) {
            const tier3Candidates = await runEnginesAgainst(
              tier3.html,
              tier3.finalUrl,
              "tier3",
            );
            if (tier3Candidates.length > 0) {
              finalUrl = tier3.finalUrl;
              candidates = [...candidates, ...tier3Candidates];
            }
          }
        }
      }
    }

    const best = pickBest(candidates);
    if (!best) {
      return {
        status: "failed",
        reason: "no engine could extract content from this page",
      };
    }

    const sanitized = sanitizeHtml(best.contentHtml);
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

    /** @type {Article} */
    const article = {
      url: finalUrl,
      title: best.title || "",
      byline: best.byline,
      siteName: best.siteName,
      publishedTime: best.publishedTime,
      contentHtml: sanitized,
      textContent: best.textContent,
      wordCount,
      engine: best.engine,
      score: best.score,
      fetchTier: best.fetchTier,
    };

    return { status: "ok", article };
  } catch (err) {
    return {
      status: "failed",
      reason: `unexpected extraction error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
