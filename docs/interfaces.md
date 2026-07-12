# Kindling — Module Interface Contracts

Every `src/` module implements exactly the signatures below. These are the seams between independently-built modules. **Do not change a signature without updating this file and flagging the integrator.** All modules are ES modules, Node ≥20, JSDoc-typed.

Shared conventions:
- Timestamps are ISO-8601 strings (`new Date().toISOString()`).
- Functions that depend on "now" accept an optional `now = new Date()` parameter so tests can inject a fake clock.
- No function reads user data outside the paths passed to it. No function performs network I/O except `src/extract/` (fetching pages) and `src/gmail/` (sending).

---

## `src/tabs/snss.js`

Parse a Chrome SNSS session file into the list of **currently-open** tabs.

```js
/**
 * @typedef {Object} OpenTab
 * @property {string} url
 * @property {string} title
 * @property {number} windowId
 * @property {number} tabId
 * @property {number} index   // position within its window
 */

/**
 * Read the currently-open tabs from a single SNSS session file (read-only).
 * Reconstructs live tab state (excludes closed tabs/windows and back/forward history).
 * @param {string} sessionFilePath
 * @returns {Promise<OpenTab[]>}
 */
export async function readOpenTabs(sessionFilePath) {}
```

## `src/tabs/profiles.js`

Discover Chrome profiles and locate the newest session file for ONE explicitly-chosen profile. Never returns tabs for more than the requested profile.

```js
/**
 * @typedef {Object} ChromeProfile
 * @property {string} id            // directory name, e.g. "Default", "Profile 1"
 * @property {string} displayName   // human name from Preferences, e.g. "Personal"
 * @property {string|null} email    // signed-in account email, if any
 * @property {string} path          // absolute path to the profile dir
 */

/** List available Chrome profiles on this machine (macOS paths).
 * @param {string} [chromeRoot] override for testing
 * @returns {Promise<ChromeProfile[]>} */
export async function listProfiles(chromeRoot) {}

/** Absolute path to the newest current-session file for one profile.
 * @param {string} profilePath
 * @returns {Promise<string|null>} */
export async function newestSessionFile(profilePath) {}

/** Convenience: open tabs for exactly one profile (by id).
 * @param {string} profileId
 * @param {string} [chromeRoot]
 * @returns {Promise<import('./snss.js').OpenTab[]>} */
export async function readProfileTabs(profileId, chromeRoot) {}
```

---

## `src/ledger.js`

The memory of the system: per-URL first-seen / sent / reopened tracking, and a digest log. Atomic writes (write temp + rename). Human-readable JSON.

```js
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

/** Load the ledger from disk (creates an empty one if absent).
 * @param {string} ledgerPath
 * @returns {Promise<Ledger>} */
export async function loadLedger(ledgerPath) {}

/**
 * @typedef {Object} Ledger
 * @property {Record<string, TabRecord>} tabs   // keyed by normalized URL
 * @property {DigestRecord[]} digests
 */

/** Reconcile a fresh snapshot of open tabs into the ledger IN MEMORY.
 * Sets firstSeen on new URLs, updates lastSeen, and appends to reopenedAt
 * for any URL seen again after its sentAt. Returns the mutated ledger.
 * @param {Ledger} ledger
 * @param {{url:string,title:string}[]} openTabs
 * @param {Date} [now]
 * @returns {Ledger} */
export function recordSnapshot(ledger, openTabs, now) {}

/** URLs open for >= thresholdHours and not yet sent.
 * @param {Ledger} ledger
 * @param {number} thresholdHours
 * @param {Date} [now]
 * @returns {string[]} */
export function selectStale(ledger, thresholdHours, now) {}

/** Mark a set of URLs as sent in a digest and append the digest record.
 * @param {Ledger} ledger
 * @param {DigestRecord} digest
 * @param {Date} [now]
 * @returns {Ledger} */
export function recordDigest(ledger, digest, now) {}

/** Atomically persist the ledger to disk.
 * @param {string} ledgerPath
 * @param {Ledger} ledger
 * @returns {Promise<void>} */
export async function saveLedger(ledgerPath, ledger) {}
```

---

## `src/filter.js`

URL normalization, dedupe, and the shipped exclusion list + user rules. Pure functions (no I/O except reading the config object passed in).

```js
/** Canonical form for ledger keys & dedupe: lowercased host, strip fragment,
 * strip common tracking params (utm_*, fbclid, gclid…), strip trailing slash.
 * @param {string} url
 * @returns {string} */
export function normalizeUrl(url) {}

/** The shipped default exclusion list (app-like domains that are never articles). */
export const DEFAULT_EXCLUSIONS; // string[] of domains

/**
 * @typedef {Object} FilterRules
 * @property {string[]} [block]  // extra domains to exclude
 * @property {string[]} [allow]  // domains to force-include even if in defaults
 */

/** Should this URL be considered for sending (pre-extraction gate)?
 * Excludes non-http(s), localhost/private IPs, and blocked domains.
 * @param {string} url
 * @param {FilterRules} [rules]
 * @returns {{include:boolean, reason:string}} */
export function screenUrl(url, rules) {}

/** Dedupe a list of URLs by normalized form, preserving first occurrence.
 * @param {string[]} urls
 * @returns {string[]} */
export function dedupe(urls) {}
```

---

## `src/extract/index.js`

The extraction chain: fetch a URL, run engines in scored order, return the best clean-HTML article, and gate on "is this actually an article?". **This is the core-quality module.**

**Phase-0 bake-off decisions (locked):**
- **Engine order: Defuddle (primary) → Readability (fallback).** Defuddle matched or beat Readability on every real-world page in the corpus and clearly won on Q&A (Stack Overflow) and forum (Reddit) structure. **Postlight is excluded** — dormant, crashes on some pages, and makes silent live network fetches during parse (unacceptable for a fetch-once/parse-offline pipeline).
- **The fetch layer is the real risk, not the engine.** 3/9 corpus URLs blocked plain fetch (Cloudflare/WAF bot challenges); 1 was a JS-only SPA (0 words from every engine). So `fetchPage` is a **tiered fetcher**:
  1. Plain HTTP GET with realistic desktop headers (fast path, most pages).
  2. If it fails (403/challenge) or extraction is thin/empty → **render via headless Chrome** (drive the user's already-installed Chrome through the DevTools Protocol; no bundled Chromium). This defeats SPAs and most challenges.
  3. Last resort → Wayback Machine snapshot (`http://web.archive.org/web/2/<url>`).
- **Extension path (Phase 3) supplies pre-rendered DOM directly**, bypassing the fetcher entirely — the premium source, since it's the user's authenticated, JS-executed page. `extract()` therefore accepts an optional `rawHtml` to consume caller-supplied DOM.
- Fetch tier used and any fallback taken is recorded on the `Article` (`fetchTier`) and surfaced in `--dry-run`/history.

```js
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
 */

/**
 * @typedef {Object} ExtractResult
 * @property {'ok'|'skipped'|'failed'} status
 * @property {Article} [article]      // when ok
 * @property {string} [reason]        // when skipped/failed (surfaced to user)
 */

/** Fetch + extract one URL through the scored engine chain, then apply the
 * article gate (min word count / min score). Never throws for a bad page —
 * returns {status:'failed'|'skipped', reason}.
 * @param {string} url
 * @param {ExtractOptions} [opts]
 * @returns {Promise<ExtractResult>} */
export async function extract(url, opts) {}

/**
 * @typedef {Object} ExtractOptions
 * @property {number} [minWords=300]     // article gate threshold
 * @property {number} [minScore]         // quality gate
 * @property {number} [timeoutMs=20000]
 * @property {string} [userAgent]
 * @property {string} [rawHtml]          // bypass fetch (for tests)
 */
```

---

## `src/epub.js`

Assemble one digest EPUB from extracted articles: cover page, TOC, per-article source/date header, page breaks, Kindle-tuned CSS. Enforces the 50 MB cap (caller splits across multiple digests if needed — see below).

```js
/** Build a single EPUB file from articles.
 * @param {import('./extract/index.js').Article[]} articles
 * @param {EpubOptions} opts
 * @returns {Promise<{path:string, sizeBytes:number, articleCount:number}>} */
export async function buildEpub(articles, opts) {}

/**
 * @typedef {Object} EpubOptions
 * @property {string} outPath        // where to write the .epub
 * @property {string} title          // e.g. "Tab Digest"
 * @property {Date} [date]
 * @property {string[]} [failedUrls] // listed on a "couldn't fetch" end page
 */

/** Split articles into groups that each fit under maxBytes when built.
 * @param {import('./extract/index.js').Article[]} articles
 * @param {number} [maxBytes=52428800]
 * @returns {import('./extract/index.js').Article[][]} */
export function splitForSizeLimit(articles, maxBytes) {}
```

---

## `src/gmail/oauth.js` and `src/gmail/send.js`

Least-privilege sending: OAuth2 loopback+PKCE for the `gmail.send` scope, refresh token in macOS Keychain, send a MIME email with the EPUB attached via the Gmail API. App-password SMTP is a separate documented fallback (`src/gmail/smtp.js`), not the default.

```js
// src/gmail/keychain.js — thin wrappers over the macOS `security` CLI.
/** @param {string} account @param {string} secret @returns {Promise<void>} */
export async function setSecret(account, secret) {}
/** @param {string} account @returns {Promise<string|null>} */
export async function getSecret(account) {}
/** @param {string} account @returns {Promise<void>} */
export async function deleteSecret(account) {}

// src/gmail/oauth.js
/** Run the one-time loopback+PKCE consent flow, store the refresh token in
 * Keychain, and return the granted account email. Opens the browser.
 * @param {{clientId:string, clientSecret:string}} client
 * @returns {Promise<{email:string}>} */
export async function authorize(client) {}

/** Get a valid access token (refresh silently using the stored token).
 * @param {{clientId:string, clientSecret:string}} client
 * @returns {Promise<string>} */
export async function getAccessToken(client) {}

// src/gmail/send.js
/** Send an email with one attachment via the Gmail API.
 * @param {SendOptions} opts
 * @returns {Promise<{id:string}>} */
export async function sendMail(opts) {}
/**
 * @typedef {Object} SendOptions
 * @property {string} accessToken
 * @property {string} to        // the @kindle.com address
 * @property {string} from      // approved sender
 * @property {string} subject
 * @property {string} attachmentPath
 * @property {string} [attachmentName]
 */
```

---

## `src/config.js`

Load/validate `~/.config/kindling/config.json`. Documented defaults; unknown keys rejected with a helpful message.

```js
/**
 * @typedef {Object} Config
 * @property {string} profileId          // Chrome profile dir name
 * @property {string} kindleEmail        // @kindle.com address
 * @property {string} senderEmail        // approved Gmail sender
 * @property {number} staleHours         // default 48
 * @property {'oauth'|'smtp'} authMethod // default 'oauth'
 * @property {{block:string[], allow:string[]}} filters
 * @property {number} minWords           // article gate, default 300
 * @property {boolean} closeAfterSend    // default false
 * @property {number} scheduleHours      // launchd interval, default 6
 */

/** @param {string} [configPath] @returns {Promise<Config>} */
export async function loadConfig(configPath) {}
/** @param {Config} config @param {string} [configPath] @returns {Promise<void>} */
export async function saveConfig(config, configPath) {}
/** Default config + platform paths (XDG-style). @returns {Config} */
export function defaultConfig() {}
/** Resolve standard paths. @returns {{configPath:string, ledgerPath:string, dataDir:string}} */
export function paths() {}
```

---

## `src/cli.js`

Commander-based entry point wiring the above together. Commands:
`init` (interactive setup + OAuth), `run [--dry-run]`, `snapshot`, `status`, `history`, `send <url...>`, `block <domain>`, `allow <domain>`, `agent install|uninstall`. The `run` pipeline is: snapshot → ledger reconcile → selectStale → screen/dedupe → extract each → gate → buildEpub (split if needed) → sendMail → recordDigest → save. `--dry-run` stops before send and prints exactly what would be sent, skipped, and why.
