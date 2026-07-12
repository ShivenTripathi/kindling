// insights/index.js
//
// Pure, deterministic analytics over a Ledger (see ../ledger.js). No I/O, no
// network, no `node:*` imports, no DOM. Every function here takes its
// "current time" as an explicit `now` parameter (never `Date.now()`
// internally) so callers — and tests — can drive the clock.
//
// Two independent pieces live in this module:
//   computeInsights — ledger-wide stats for a dashboard/sparkline view.
//   tagTopics       — on-device topic tagging for a single Article, using a
//                      small editable domain table plus a keyword pass. No
//                      network call is ever made; this is intentionally dumb
//                      compared to an LLM classifier (see ../llm/index.js for
//                      the opt-in, bring-your-own-key alternative).

/**
 * @typedef {Object} Insights
 * @property {number} backlog          // urls open >= staleHours, not yet sent
 * @property {number} sentInRange
 * @property {number} reopenRate       // fraction of sent urls reopened after send (0..1)
 * @property {{domain:string,count:number}[]} topSources
 * @property {{date:string,count:number}[]} volumeByDay
 * @property {number} readingMinutes   // estimated, from wordCount totals
 * @property {number} streakDays       // consecutive days up to `now` with >=1 send
 * @property {number} totalTracked
 * @property {number} totalSent
 */

// Fallback average word count per article, used only when the caller doesn't
// supply `wordCountByUrl` for a given URL. The ledger itself never stores
// wordCount (see docs/rework-interfaces.md) — Article.wordCount lives on the
// transient extraction result, not in the durable ledger record. Callers that
// want an accurate readingMinutes figure should pass a `wordCountByUrl` map
// built from their own history of built digests/articles; this constant is a
// deliberately conservative middle-of-the-road estimate (roughly a 5-6
// paragraph blog post) so the sparkline/stat still renders something
// reasonable with zero extra plumbing.
const AVG_WORDS_PER_ARTICLE = 800;

/** Turn a Date into a 'YYYY-MM-DD' key, using UTC calendar days so the
 * function stays pure/deterministic regardless of host timezone.
 * @param {Date} date @returns {string} */
function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/** Strip a leading "www." from a hostname so "www.example.com" and
 * "example.com" count as the same source.
 * @param {string} hostname @returns {string} */
function stripWww(hostname) {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

/** Best-effort domain extraction from a URL string. Never throws — an
 * unparseable URL falls back to the raw string so a malformed ledger entry
 * can't crash the whole insights computation.
 * @param {string} url @returns {string} */
function domainOf(url) {
  try {
    return stripWww(new URL(url).hostname.toLowerCase());
  } catch {
    return url;
  }
}

/**
 * Compute dashboard-ready stats over a Ledger.
 * @param {import('../ledger.js').Ledger} ledger
 * @param {{now?:Date, rangeDays?:number, staleHours?:number,
 *          wordsPerMinute?:number, wordCountByUrl?:Record<string,number>}} [opts]
 * @returns {Insights}
 */
export function computeInsights(ledger, opts = {}) {
  const {
    now = new Date(),
    rangeDays = 30,
    staleHours = 48,
    wordsPerMinute = 220,
    wordCountByUrl = {},
  } = opts;

  const nowMs = now.getTime();
  const staleThresholdMs = staleHours * 60 * 60 * 1000;
  const rangeStartMs = nowMs - rangeDays * 24 * 60 * 60 * 1000;

  const tabs = ledger.tabs ?? {};
  const entries = Object.entries(tabs);

  let backlog = 0;
  let sentInRange = 0;
  let reopenedAfterSend = 0;
  let sentTotal = 0;
  let readingWords = 0;
  const sourceCounts = new Map(); // domain -> count
  const sendsByDay = new Map(); // 'YYYY-MM-DD' -> count

  for (const [url, record] of entries) {
    // --- backlog: open (unsent) long enough ---
    if (!record.sentAt) {
      const firstSeenMs = new Date(record.firstSeen).getTime();
      if (nowMs - firstSeenMs >= staleThresholdMs) backlog++;
      continue;
    }

    // From here down, record.sentAt is set — this URL was sent at some point.
    sentTotal++;
    const sentAtMs = new Date(record.sentAt).getTime();

    // reopenRate is computed over ALL sent urls (not just those in range),
    // per the interface doc ("of sent urls, the fraction ... reopened").
    const reopenedAfter = (record.reopenedAt ?? []).some(
      (iso) => new Date(iso).getTime() > sentAtMs,
    );
    if (reopenedAfter) reopenedAfterSend++;

    if (sentAtMs < rangeStartMs || sentAtMs > nowMs) continue; // outside the reporting range

    sentInRange++;

    const domain = domainOf(url);
    sourceCounts.set(domain, (sourceCounts.get(domain) ?? 0) + 1);

    const key = dayKey(new Date(sentAtMs));
    sendsByDay.set(key, (sendsByDay.get(key) ?? 0) + 1);

    readingWords += wordCountByUrl[url] ?? AVG_WORDS_PER_ARTICLE;
  }

  const topSources = [...sourceCounts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, 8);

  // volumeByDay: one entry per calendar day in [rangeStart, now], oldest
  // first, zero-filled — a sparkline needs a fixed-length series, not just
  // the days that happen to have sends.
  const volumeByDay = [];
  const startDate = new Date(rangeStartMs);
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    volumeByDay.push({ date: key, count: sendsByDay.get(key) ?? 0 });
  }
  // Always include "today" as the final point even if rangeDays rounding
  // put the last generated key one short of `now`'s calendar day.
  const todayKey = dayKey(now);
  if (
    volumeByDay.length === 0 ||
    volumeByDay[volumeByDay.length - 1].date !== todayKey
  ) {
    volumeByDay.push({ date: todayKey, count: sendsByDay.get(todayKey) ?? 0 });
  }

  // streakDays: walk backward from today, counting consecutive days with
  // >=1 send, stopping at the first gap.
  let streakDays = 0;
  for (let i = 0; ; i++) {
    const d = new Date(nowMs - i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    if ((sendsByDay.get(key) ?? 0) > 0) {
      streakDays++;
    } else {
      break;
    }
  }

  const reopenRate = sentTotal === 0 ? 0 : reopenedAfterSend / sentTotal;
  const readingMinutes = Math.round(readingWords / wordsPerMinute);

  return {
    backlog,
    sentInRange,
    reopenRate,
    topSources,
    volumeByDay,
    readingMinutes,
    streakDays,
    totalTracked: entries.length,
    totalSent: sentTotal,
  };
}

// ---- tagTopics --------------------------------------------------------
//
// On-device, no-network topic tagging. Two passes, in order:
//   1. domain table  — a hostname (registrable-ish; www stripped) maps
//      straight to a category. This is fast and precise for well-known
//      sources, and it's exported so a UI (or a user's config) can extend
//      it without touching this file's logic.
//   2. keyword pass  — a handful of theme keyword lists scanned over
//      title + textContent, for sources not in the table (personal sites,
//      long-tail blogs, etc).
// Domain hits are pushed before keyword hits; the result is deduped and
// capped at 3 tags, in that priority order.

/** Editable domain (host, www-stripped) -> category table. Extend this to
 * teach tagTopics about more sources; no code changes needed.
 * @type {Record<string,string>} */
export const DOMAIN_CATEGORIES = {
  // science
  "biorxiv.org": "science",
  "arxiv.org": "science",
  "nature.com": "science",
  "cell.com": "science",
  "science.org": "science",
  "pubmed.ncbi.nlm.nih.gov": "science",
  // dev
  "github.com": "dev",
  "stackoverflow.com": "dev",
  "gitlab.com": "dev",
  "news.ycombinator.com": "dev",
  "dev.to": "dev",
  // news
  "nytimes.com": "news",
  "theverge.com": "news",
  "wired.com": "news",
  "arstechnica.com": "news",
  "bbc.com": "news",
  "reuters.com": "news",
  "apnews.com": "news",
  // essay / long-form personal writing
  "substack.com": "essay",
  "medium.com": "essay",
  // finance
  "bloomberg.com": "finance",
  "wsj.com": "finance",
  "ft.com": "finance",
};

/** Keyword themes scanned over title + textContent (case-insensitive, whole
 * lowercased text so no per-word regex boundaries are needed). Order matters
 * only for readability; matches are independent.
 * @type {[string, string[]][]} */
const KEYWORD_THEMES = [
  [
    "ai/ml",
    [
      "artificial intelligence",
      "machine learning",
      "neural network",
      "llm",
      "gpt",
      "transformer model",
    ],
  ],
  [
    "health",
    [
      "health",
      "medicine",
      "medical",
      "disease",
      "clinical trial",
      "vaccine",
      "diagnosis",
    ],
  ],
  [
    "finance",
    [
      "stock market",
      "inflation",
      "interest rate",
      "earnings report",
      "venture capital",
      "ipo",
    ],
  ],
  [
    "politics",
    [
      "election",
      "senate",
      "congress",
      "president",
      "legislation",
      "policy debate",
    ],
  ],
  [
    "product",
    [
      "product launch",
      "roadmap",
      "user research",
      "feature release",
      "beta release",
    ],
  ],
];

/**
 * On-device topic tags for an article. Domain table first, then a keyword
 * pass over title+textContent for anything the table missed. Never calls
 * out to the network. Returns 0-3 deduped tags, domain-derived first.
 * @param {import('../ports.js').Article} article
 * @returns {string[]}
 */
export function tagTopics(article) {
  const tags = [];

  const domain = domainOf(article?.url ?? "");
  const domainTag = DOMAIN_CATEGORIES[domain];
  if (domainTag) tags.push(domainTag);

  const haystack =
    `${article?.title ?? ""} ${article?.textContent ?? ""}`.toLowerCase();
  for (const [tag, keywords] of KEYWORD_THEMES) {
    if (tags.includes(tag)) continue;
    if (keywords.some((kw) => haystack.includes(kw))) {
      tags.push(tag);
      if (tags.length >= 3) break;
    }
  }

  return tags.slice(0, 3);
}
