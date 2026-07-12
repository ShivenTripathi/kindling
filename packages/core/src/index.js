// @kindling/core — public barrel + the shared digest orchestrator.
//
// `runDigest` is the one pipeline both the extension and the CLI/desktop call.
// It contains ZERO platform I/O: every side effect goes through a port
// (content source, sender, storage, clock), so the same tested flow runs in a
// browser service worker and in Node.

import { screenUrl, dedupe, normalizeUrl } from "./filter.js";
import {
  loadLedger,
  saveLedger,
  recordSnapshot,
  selectStale,
  recordDigest,
} from "./ledger.js";
import { buildEpub, splitForSizeLimit } from "./epub/index.js";
import { systemClock } from "./ports.js";

export * from "./filter.js";
export * from "./ledger.js";
export { buildEpub, splitForSizeLimit } from "./epub/index.js";
export { extractFromDocument, extractFromHtml } from "./extract/index.js";
export { createGmailApiSender, buildMimeMessage } from "./send/index.js";
export { computeInsights, tagTopics } from "./insights/index.js";
export { createProvider } from "./llm/index.js";
export { systemClock } from "./ports.js";

/** A short, human digest id like "2026-07-12-a". */
function digestId(date, suffixIndex) {
  const d = date.toISOString().slice(0, 10);
  return `${d}-${String.fromCharCode(97 + suffixIndex)}`;
}

/** Reject if `promise` doesn't settle within `ms`. Used to bound best-effort
 * LLM calls so a never-resolving endpoint can't stall the whole pipeline. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
 *     llm?: import('./llm/index.js').LlmProvider,
 *   },
 *   config: {
 *     kindleEmail: string, senderEmail: string,
 *     staleHours?: number, minWords?: number,
 *     filters?: {block?:string[],allow?:string[]},
 *     title?: string, disableWayback?: boolean, summaryTimeoutMs?: number,
 *   },
 * }} args
 * @returns {Promise<DigestReport>}
 */
export async function runDigest(args) {
  const { ports, config } = args;
  const clock = ports.clock ?? systemClock;
  const now = clock.now();
  const title = config.title ?? "Tab Digest";
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

  // Screen (exclusion list / SSRF / local) + dedupe. Surface dropped duplicates
  // so nothing vanishes silently (invariant: nothing silently dropped).
  const deduped = dedupe(candidateUrls);
  const keptRaw = new Set(deduped); // dedupe keeps the first raw url per normalized form
  for (const url of candidateUrls) {
    if (!keptRaw.has(url)) {
      report.skipped.push({
        url,
        reason: "duplicate of an already-included URL",
      });
    }
  }
  const screened = [];
  for (const url of deduped) {
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
      result = {
        status: "failed",
        reason: `content source error: ${err.message}`,
      };
    }
    if (result && result.status === "ok" && result.article) {
      articles.push(result.article);
    } else {
      const reason = (result && result.reason) || "could not extract";
      failedUrls.push(url);
      report.failed.push({ url, reason });
    }
  }
  if (articles.length === 0) return report;

  // Optional AI (Tier 3): if an LLM provider is supplied, summarize each article
  // now — this is the only moment we have the full text. Stored on the ledger so
  // the dashboard can show summaries + a monthly synthesis. Bring-your-own-key,
  // local-only; a summarization failure never blocks the send.
  if (ports.llm && typeof ports.llm.summarize === "function") {
    const summaryTimeoutMs = config.summaryTimeoutMs ?? 20000;
    for (const article of articles) {
      try {
        // Bounded: a hung/slow LLM endpoint (e.g. a stalled local Ollama)
        // must never block the send. try/catch alone can't rescue a promise
        // that simply never settles, so race it against a timeout.
        article.summary = await withTimeout(
          ports.llm.summarize(article.textContent || article.contentHtml || ""),
          summaryTimeoutMs,
        );
      } catch {
        /* summaries are best-effort; keep sending */
      }
    }
  }

  // Ensure a ledger tab record exists for every article being sent (the
  // explicit-urls "send now" path may not have snapshotted them), so sentAt,
  // summaries, and later reopen-tracking all have somewhere to attach.
  ledger = recordSnapshot(
    ledger,
    articles.map((a) => ({ url: a.url, title: a.title })),
    now,
  );

  // Build EPUB(s), respecting the Kindle/Gmail size cap.
  const groups = splitForSizeLimit(articles);
  for (let i = 0; i < groups.length; i++) {
    const id = digestId(now, i);
    let built;
    try {
      built = await buildEpub(groups[i], {
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
    } catch (err) {
      // This group's build/send failed. Record the failure and STOP — but the
      // ledger for any earlier group that DID send is already persisted below
      // (per-group save), so those won't be re-sent on the next run.
      for (const a of groups[i])
        report.failed.push({
          url: a.url,
          reason: `send failed: ${err.message}`,
        });
      break;
    }

    const urls = groups[i].map((a) => a.url);
    ledger = recordDigest(
      ledger,
      {
        id,
        sentAt: now.toISOString(),
        articles: built.articleCount,
        sizeBytes: built.sizeBytes,
        urls,
      },
      now,
    );
    // Persist per-article summaries + word counts onto the ledger records so
    // the dashboard (local, and the monthly AI synthesis) can use them.
    for (const a of groups[i]) {
      const rec = ledger.tabs[normalizeUrl(a.url)];
      if (rec) {
        if (typeof a.wordCount === "number") rec.wordCount = a.wordCount;
        if (a.summary) rec.summary = a.summary;
      }
    }
    // Persist INCREMENTALLY, right after each group's send succeeds — so a
    // later group's failure can never lose an already-delivered group's record
    // (which would cause a duplicate re-send on the next run).
    await saveLedger(ports.storage, ledger);
    report.sent.push(...urls);
    report.digests.push({
      id,
      articles: built.articleCount,
      sizeBytes: built.sizeBytes,
      epubBytes: built.bytes,
    });
  }

  return report;
}

export { normalizeUrl };
