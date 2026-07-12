// score.js
//
// Quality scoring for a candidate extraction, used to (a) pick the winner
// between engines and (b) optionally gate on `opts.minScore`. The bake-off
// corpus showed the failure mode isn't "no content" so much as "the wrong
// content" — nav/comment/related-links boilerplate that an engine failed to
// strip, which shows up as low word count relative to link count. So the
// formula rewards substance (words, retained images/tables/code — signals
// that the *real* article body survived) and penalizes link density (a
// proxy for boilerplate that leaked through).
//
// The formula is deliberately simple and made of named, documented
// constants rather than a black box, so it's easy to tune against a real
// corpus later without re-deriving intent from the code.
//
// Ported verbatim from src/extract/score.js (see docs/rework-interfaces.md:
// "keep scoring exactly"). Pure string/regex math — no DOM, no I/O —
// already browser-safe as-is.

const WORDS_PER_POINT = 2; // 1 point per 2 words of body text...
const WORD_SCORE_CAP = 1000; // ...up to 1000 points (~2000 words), then diminishing
const LONG_ARTICLE_LOG_WEIGHT = 60; // extra credit for very long pieces, log-scaled so it never dominates

const IMAGE_BONUS = 15; // per retained <img>, small credit — a real article often has a hero/figures
const IMAGE_BONUS_CAP = 90; // cap so an image-gallery page can't out-score a real long-form article

const TABLE_BONUS = 40; // per retained <table> — reference/data articles are legitimately short on prose
const TABLE_BONUS_CAP = 120;

const CODE_BONUS = 20; // per retained <pre>/<code> block — technical articles read short but are dense
const CODE_BONUS_CAP = 100;

const LINK_DENSITY_PENALTY_PER_1000_WORDS = 4; // points lost per link-per-1000-words of link density
const LINK_DENSITY_PENALTY_CAP = 400; // don't let link density alone drive the score deeply negative

function countTag(html, tagName) {
  const re = new RegExp(`<${tagName}[\\s/>]`, "gi");
  return (html.match(re) || []).length;
}

function countWords(textContent) {
  if (!textContent) return 0;
  const trimmed = textContent.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * @typedef {Object} ScorableArticle
 * @property {string} textContent
 * @property {string} contentHtml
 */

/** Score an extraction candidate. Higher is better; can go negative for
 * link-farm-shaped pages, which is intentional (it should lose to any
 * candidate with real prose, and fail an `opts.minScore` gate on its own).
 * @param {ScorableArticle} candidate
 * @returns {number} */
export function scoreArticle({ textContent, contentHtml }) {
  const wordCount = countWords(textContent);
  const html = contentHtml || "";

  const baseWordScore = Math.min(wordCount / WORDS_PER_POINT, WORD_SCORE_CAP);
  const longArticleBonus =
    wordCount > WORD_SCORE_CAP * WORDS_PER_POINT
      ? Math.log2(1 + wordCount / (WORD_SCORE_CAP * WORDS_PER_POINT)) *
        LONG_ARTICLE_LOG_WEIGHT
      : 0;

  const imageScore = Math.min(
    countTag(html, "img") * IMAGE_BONUS,
    IMAGE_BONUS_CAP,
  );
  const tableScore = Math.min(
    countTag(html, "table") * TABLE_BONUS,
    TABLE_BONUS_CAP,
  );
  const codeScore = Math.min(
    (countTag(html, "pre") + countTag(html, "code")) * CODE_BONUS,
    CODE_BONUS_CAP,
  );

  const linkCount = countTag(html, "a");
  const linkDensityPer1000Words =
    wordCount > 0 ? (linkCount / wordCount) * 1000 : linkCount > 0 ? 1000 : 0;
  const linkPenalty = Math.min(
    linkDensityPer1000Words * LINK_DENSITY_PENALTY_PER_1000_WORDS,
    LINK_DENSITY_PENALTY_CAP,
  );

  return (
    baseWordScore +
    longArticleBonus +
    imageScore +
    tableScore +
    codeScore -
    linkPenalty
  );
}
