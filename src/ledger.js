// ledger.js
//
// The memory of the system: per-URL first-seen / sent / reopened tracking,
// plus a log of past digests. Every write to disk is atomic (write to a
// `.tmp` sibling, then `fs.rename` over the target) so a crash mid-write
// never corrupts the ledger — the rename is the only observable state
// transition, and it's atomic at the filesystem level on the same volume.
//
// All "now" logic is passed in via an explicit `now` parameter (defaulting
// to `new Date()`), never read via `Date.now()` internally, so tests can
// drive the clock deterministically.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { normalizeUrl } from "./filter.js";

/**
 * @typedef {Object} TabRecord
 * @property {string} title
 * @property {string} firstSeen   // ISO — when this URL was first observed open
 * @property {string} lastSeen    // ISO — most recent snapshot that saw it open
 * @property {string|null} sentAt // ISO if included in a sent digest, else null
 * @property {string|null} digestId
 * @property {string[]} reopenedAt // ISO times the URL was seen open AFTER being sent
 * @property {boolean} closedByKindling
 */

/**
 * @typedef {Object} DigestRecord
 * @property {string} id          // e.g. "2026-07-08-a"
 * @property {string} sentAt      // ISO
 * @property {number} articles
 * @property {number} sizeBytes
 * @property {string[]} urls
 */

/**
 * @typedef {Object} Ledger
 * @property {Record<string, TabRecord>} tabs   // keyed by normalized URL
 * @property {DigestRecord[]} digests
 */

/** Load the ledger from disk (creates an empty one if absent).
 * @param {string} ledgerPath
 * @returns {Promise<Ledger>} */
export async function loadLedger(ledgerPath) {
  let raw;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { tabs: {}, digests: [] };
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Kindling ledger at ${ledgerPath} is not valid JSON (${err.message}). ` +
        `It may have been edited or truncated. Fix the JSON, or move the file ` +
        `aside to start fresh (history will be lost).`,
    );
  }

  // Backfill a valid shape so a hand-edited or older-format file can't crash
  // recordSnapshot/recordDigest later with a confusing error far from here.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { tabs: {}, digests: [] };
  }
  if (!parsed.tabs || typeof parsed.tabs !== "object") parsed.tabs = {};
  if (!Array.isArray(parsed.digests)) parsed.digests = [];
  return parsed;
}

/** Reconcile a fresh snapshot of open tabs into the ledger IN MEMORY.
 * Sets firstSeen on new URLs, updates lastSeen, and appends to reopenedAt
 * for any URL seen again after its sentAt. Returns the mutated ledger.
 * @param {Ledger} ledger
 * @param {{url:string,title:string}[]} openTabs
 * @param {Date} [now]
 * @returns {Ledger} */
// Object keys that would corrupt the prototype chain if used as a plain-object
// property (a crafted/corrupt Chrome session file could carry a tab "url" of
// "__proto__"). Reject them before any bracket assignment. See ledger.tabs use.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function recordSnapshot(ledger, openTabs, now = new Date()) {
  const nowIso = now.toISOString();

  for (const tab of openTabs) {
    const key = normalizeUrl(tab.url);
    if (UNSAFE_KEYS.has(key)) continue; // never let a URL become a proto-polluting key
    const existing = Object.hasOwn(ledger.tabs, key)
      ? ledger.tabs[key]
      : undefined;

    if (!existing) {
      ledger.tabs[key] = {
        title: tab.title,
        firstSeen: nowIso,
        lastSeen: nowIso,
        sentAt: null,
        digestId: null,
        reopenedAt: [],
        closedByKindling: false,
      };
      continue;
    }

    existing.title = tab.title;
    existing.lastSeen = nowIso;

    if (existing.sentAt) {
      const lastReopen = existing.reopenedAt[existing.reopenedAt.length - 1];
      // Only append once per snapshot: if the most recent reopen entry is
      // already stamped with this exact `now`, a prior tab in this same
      // snapshot call already recorded it (shouldn't normally happen since
      // each URL appears once per snapshot, but this keeps the operation
      // idempotent if recordSnapshot is ever called twice with the same
      // `now` for the same URL).
      if (lastReopen !== nowIso) {
        existing.reopenedAt.push(nowIso);
      }
    }
  }

  return ledger;
}

/** URLs open for >= thresholdHours and not yet sent.
 * @param {Ledger} ledger
 * @param {number} thresholdHours
 * @param {Date} [now]
 * @returns {string[]} */
export function selectStale(ledger, thresholdHours, now = new Date()) {
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const stale = [];

  for (const [url, record] of Object.entries(ledger.tabs)) {
    if (record.sentAt) continue;
    const firstSeenMs = new Date(record.firstSeen).getTime();
    if (nowMs - firstSeenMs >= thresholdMs) {
      stale.push(url);
    }
  }

  return stale;
}

/** Mark a set of URLs as sent in a digest and append the digest record.
 * @param {Ledger} ledger
 * @param {DigestRecord} digest
 * @param {Date} [now]
 * @returns {Ledger} */
export function recordDigest(ledger, digest, now = new Date()) {
  const nowIso = now.toISOString();

  for (const url of digest.urls) {
    const key = normalizeUrl(url);
    if (UNSAFE_KEYS.has(key)) continue;
    const record = Object.hasOwn(ledger.tabs, key)
      ? ledger.tabs[key]
      : undefined;
    if (!record) continue;
    record.sentAt = nowIso;
    record.digestId = digest.id;
  }

  ledger.digests.push(digest);

  return ledger;
}

/** Atomically persist the ledger to disk.
 * @param {string} ledgerPath
 * @param {Ledger} ledger
 * @returns {Promise<void>} */
export async function saveLedger(ledgerPath, ledger) {
  // Owner-only dir + file: the ledger contains the user's browsing history
  // (tab URLs and titles), which must not be world-readable.
  await mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${ledgerPath}.tmp`;
  const json = JSON.stringify(ledger, null, 2);
  // mode 0o600 on the temp file is preserved through the atomic rename.
  await writeFile(tmpPath, json, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, ledgerPath);
}
