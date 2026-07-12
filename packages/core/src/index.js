// @kindling/core — public barrel + the shared digest orchestrator.
//
// `runDigest` is the one pipeline both the extension and the CLI/desktop call.
// It contains ZERO platform I/O: every side effect goes through a port
// (content source, sender, storage, clock), so the same tested flow runs in a
// browser service worker and in Node.

import { screenUrl, dedupe, normalizeUrl } from './filter.js';
import { loadLedger, saveLedger, recordSnapshot, selectStale, recordDigest } from './ledger.js';
import { buildEpub, splitForSizeLimit } from './epub/index.js';
import { systemClock } from './ports.js';

export * from './filter.js';
export * from './ledger.js';
export { buildEpub, splitForSizeLimit } from './epub/index.js';
export { extractFromDocument, extractFromHtml } from './extract/index.js';
export { createGmailApiSender, buildMimeMessage } from './send/index.js';
export { computeInsights, tagTopics } from './insights/index.js';
export { createProvider } from './llm/index.js';
export { systemClock } from './ports.js';

/** A short, human digest id like "2026-07-12-a". */
function digestId(date, suffixIndex) {
  const d = date.toISOString().slice(0, 10);
  return `${d}-${String.fromCharCode(97 + suffixIndex)}`;
}

/**
 * @typedef {Object} DigestReport
 * @property {string[]} sent
 * @property {{url:string,reason:string}[]} skipped
 * @property {{url:string,reason:string}[]} failed
 * @property {{id:string,articles:number,sizeBytes:number,epubBytes:Uint8Array}[]} digests
 */

/**
 * Snapshot → reconcile → select → screen/dedupe → get article (per url) →
 * build EPUB(s) (split for the 50MB cap) → send → record → save.
 *
 * Two entry modes:
 *  - pass `urls` for an explicit "send now" list (bypasses the staleness gate)
 *  - pass `openTabs` for the scheduled path (reconciles the ledger, then only
 *    urls open >= staleHours & unsent are sent)
 *
 * @param {{
 *   urls?: string[],
 *   openTabs?: {url:string,title:string}[],
 *   ports: {
 *     content: import('./ports.js').ContentSource,
 *     sender: import('./ports.js').Sender,
 *     storage: import('./ports.js').Storage,
 *     clock?: import('./ports.js').Clock,
 *     dom?: {parseHtml:(html:string)=>any, serialize:(node:any)=>string},
 *     fetchImage?: (url:string)=>Promise<{bytes:Uint8Array,contentType:string}|null>,
 *   },
 *   config: {
 *     kindleEmail: string, senderEmail: string,
 *     staleHours?: number, minWords?: number,
 *     filters?: {block?:string[],allow?:string[]},
 *     title?: string, disableWayback?: boolean,
 *   },
 * }} args
 * @returns {Promise<DigestReport>}
 */
export async function runDigest(args) {
  const { ports, config } = args;
  const clock = ports.clock ?? systemClock;
  const now = clock.now();
  const title = config.title ?? 'Tab Digest';
  const staleHours = config.staleHours ?? 48;
  const filters = config.filters ?? {};

  /** @type {DigestReport} */
  const report = { sent: [], skipped: [], failed: [], digests: [] };

  let ledger = await loadLedger(ports.storage);

  // Decide the candidate url list.
  let candidateUrls;
  if (Array.isArray(args.urls) && args.urls.length > 0) {
    candidateUrls = args.urls; // explicit "send now"
  } else {
    // Scheduled path: reconcile the fresh tab snapshot, then select stale.
    ledger = recordSnapshot(ledger, args.openTabs ?? [], now);
    await saveLedger(ports.storage, ledger);
    candidateUrls = selectStale(ledger, staleHours, now);
  }

  // Screen (exclusion list / SSRF / local) + dedupe.
  const screened = [];
  for (const url of dedupe(candidateUrls)) {
    const { include, reason } = screenUrl(url, filters);
    if (include) screened.push(url);
    else report.skipped.push({ url, reason });
  }
  if (screened.length === 0) return report;

  // Extract each candidate through the content source (DOM capture or fetch).
  const articles = [];
  const failedUrls = [];
  for (const url of screened) {
    let result;
    try {
      result = await ports.content.getArticle(url, {
        minWords: config.minWords,
        disableWayback: config.disableWayback,
      });
    } catch (err) {
      result = { status: 'failed', reason: `content source error: ${err.message}` };
    }
    if (result && result.status === 'ok' && result.article) {
      articles.push(result.article);
    } else {
      const reason = (result && result.reason) || 'could not extract';
      failedUrls.push(url);
      report.failed.push({ url, reason });
    }
  }
  if (articles.length === 0) return report;

  // Build EPUB(s), respecting the 50MB Kindle email cap.
  const groups = splitForSizeLimit(articles);
  for (let i = 0; i < groups.length; i++) {
    const id = digestId(now, i);
    const built = await buildEpub(groups[i], {
      title,
      date: now,
      failedUrls: i === 0 ? failedUrls : [],
      dom: ports.dom, // browser: undefined → uses globals; Node: jsdom-backed provider
      fetchImage: ports.fetchImage,
    });

    await ports.sender.send({
      to: config.kindleEmail,
      from: config.senderEmail,
      subject: groups.length > 1 ? `${title} ${id}` : title,
      attachment: built.bytes,
      attachmentName: `${id}.epub`,
    });

    const urls = groups[i].map((a) => a.url);
    ledger = recordDigest(
      ledger,
      { id, sentAt: now.toISOString(), articles: built.articleCount, sizeBytes: built.sizeBytes, urls },
      now,
    );
    report.sent.push(...urls);
    report.digests.push({ id, articles: built.articleCount, sizeBytes: built.sizeBytes, epubBytes: built.bytes });
  }

  await saveLedger(ports.storage, ledger);
  return report;
}

export { normalizeUrl };
