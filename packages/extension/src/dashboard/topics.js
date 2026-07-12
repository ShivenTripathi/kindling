// topics.js — pure helpers for the dashboard, kept dependency-free (no DOM,
// no chrome.*) so they're unit-testable in plain Node. dashboard.js (the DOM
// wiring) imports these; test/dashboard.test.js exercises them directly.

/** Aggregate topic tags across every *sent* tab in a ledger. The ledger
 * doesn't store `textContent` (see docs/rework-interfaces.md), so each tab
 * is tagged on title alone — `tagTopics({url, title, textContent:''})`.
 * @param {import('@kindling/core/ledger').Ledger} ledger
 * @param {(article:{url:string,title:string,textContent:string})=>string[]} tagTopics
 * @returns {{topic:string,count:number}[]} sorted desc by count, then alpha
 */
export function aggregateTopics(ledger, tagTopics) {
  const counts = new Map();
  const tabs = ledger?.tabs ?? {};
  for (const [url, record] of Object.entries(tabs)) {
    if (!record?.sentAt) continue;
    const tags = tagTopics({ url, title: record.title ?? "", textContent: "" });
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

/** Format a minute count as "Xh Ym" (or "Ym" under an hour, "0m" for zero).
 * @param {number} minutes @returns {string} */
export function formatReadingTime(minutes) {
  const total = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Named range presets → rangeDays passed to computeInsights.
 * @type {Record<string, number>} */
export const RANGE_PRESETS = {
  week: 7,
  month: 30,
  all: 3650, // "all time" — computeInsights zero-fills volumeByDay for the
  // whole window, so cap it at a decade rather than passing Infinity.
};

/** Collect `{title, summary}` for every sent tab in the ledger whose
 * `sentAt` falls within the last `rangeDays` (relative to `now`) and that has
 * a stored `summary` (only present when an LLM provider was configured at
 * send time — see `runDigest` in packages/core/src/index.js). Feeds the
 * dashboard's "Monthly reading digest" synthesis; tabs without a summary are
 * silently skipped rather than sent to the model empty-handed.
 * @param {import('@kindling/core/ledger').Ledger} ledger
 * @param {{now?:Date, rangeDays?:number}} [opts]
 * @returns {{title:string, summary:string}[]}
 */
export function summarizedItemsInRange(ledger, opts = {}) {
  const { now = new Date(), rangeDays = 30 } = opts;
  const cutoff = now.getTime() - rangeDays * 86_400_000;
  const tabs = ledger?.tabs ?? {};
  const items = [];
  for (const record of Object.values(tabs)) {
    if (!record?.sentAt || !record.summary) continue;
    const sentAt = new Date(record.sentAt).getTime();
    if (Number.isNaN(sentAt) || sentAt < cutoff) continue;
    items.push({ title: record.title || "", summary: record.summary });
  }
  return items;
}

/** Digests in reverse-chronological order (newest first), each annotated
 * with which of its urls were reopened after being sent (per the ledger's
 * tab record `reopenedAt`) — the "the tool worked" signal.
 * @param {import('@kindling/core/ledger').Ledger} ledger
 * @returns {{id:string, sentAt:string, articles:number, sizeBytes:number,
 *            urls:{url:string, reopened:boolean}[]}[]}
 */
export function digestHistory(ledger) {
  const tabs = ledger?.tabs ?? {};
  const digests = ledger?.digests ?? [];
  return [...digests]
    .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
    .map((d) => ({
      ...d,
      urls: (d.urls ?? []).map((url) => ({
        url,
        reopened: (tabs[url]?.reopenedAt?.length ?? 0) > 0,
      })),
    }));
}
