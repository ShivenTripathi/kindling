# @kindling/core — module interface contracts (rework)

Every module in `packages/core/src/` implements exactly the signatures below.
These are the seams between independently-built modules. **Do not change a
signature without updating this file.** All ESM JS with JSDoc types, **browser-
safe** (no `node:*` imports, no `chrome.*`, no DOM globals assumed at import
time). Platform capabilities come in through the ports in `src/ports.js`.

Shared types (`Article`, `ContentSource`, `Sender`, `OutgoingMail`, `Storage`,
`Secrets`, `Scheduler`, `Clock`) are defined in **`packages/core/src/ports.js`**
— import them via `@type {import('../ports.js').Article}` etc. Reuse the audited
logic from the existing `src/` modules; this is a re-home, not a rewrite.

---

## `src/filter.js`
Move `/Users/shiventripathi/dev/kindling/src/filter.js` **verbatim** (already
pure, browser-safe). Exports unchanged: `normalizeUrl`, `DEFAULT_EXCLUSIONS`,
`screenUrl`, `dedupe`. Keep all SSRF/exclusion hardening and its tests.

## `src/ledger.js`
Port the **pure** ledger ops from `src/ledger.js`: `recordSnapshot`,
`selectStale`, `recordDigest`, and the `UNSAFE_KEYS` prototype-pollution guard.
Keep the `Ledger`/`TabRecord`/`DigestRecord` typedefs. **Remove the fs-based
`loadLedger`/`saveLedger`** — persistence is now via the Storage port:
```js
/** @param {import('./ports.js').Storage} storage @returns {Promise<Ledger>} */
export async function loadLedger(storage) {}          // reads key 'ledger', backfills {tabs:{},digests:[]}
/** @param {import('./ports.js').Storage} storage @param {Ledger} ledger */
export async function saveLedger(storage, ledger) {}  // writes key 'ledger'
```
Time logic keeps taking an injected `now`.

## `src/epub/index.js`
Port `src/epub.js`. Keep the templates, Kindle CSS, cover/nav/NCX, splitting,
XML escaping (incl. C0-control stripping), and the deterministic book id.
**Swap the zip backend** `node:zlib` → **`fflate`** (`zipSync` with per-entry
`level`, `mimetype` stored `level:0` and FIRST). buildEpub returns **bytes**,
not a file (writing is a platform concern):
```js
/** @param {import('../ports.js').Article[]} articles @param {EpubOptions} opts
 *  @returns {Promise<{bytes: Uint8Array, sizeBytes: number, articleCount: number}>} */
export async function buildEpub(articles, opts) {}
export function splitForSizeLimit(articles, maxBytes) {}  // unchanged
/**
 * @typedef {Object} EpubOptions
 * @property {string} title
 * @property {Date} [date]
 * @property {string[]} [failedUrls]
 * @property {(url:string)=>Promise<{bytes:Uint8Array,contentType:string}|null>} [fetchImage]
 *   // injected image fetcher; if absent, images are dropped (browser-safe default).
 *   // cli/desktop pass an SSRF-guarded impl; the extension passes one that pulls
 *   // from the already-rendered page. NEVER call a bare fetch() in core.
 */
```
Determinism: pin fflate options; add a golden-file test (byte-stable output for
fixed input + date). Verify a produced EPUB unzips with `mimetype` first/stored.

## `src/extract/index.js`
Port the engine chain + scoring + sanitizer from `src/extract/`. Make it
**DOM-driven** (works in a browser and Node) — the DOM comes in, never fetched
here:
```js
/** Run the engine chain on an already-parsed Document, score, sanitize, gate.
 *  Never throws.
 *  @param {Document} doc  @param {string} url  @param {ExtractOptions} [opts]
 *  @returns {import('../ports.js').ContentResult} */
export function extractFromDocument(doc, url, opts) {}

/** Convenience: parse HTML into a Document via an injected parser, then extract.
 *  @param {string} html @param {string} url
 *  @param {{parseHtml:(html:string,url:string)=>Document} & ExtractOptions} opts
 *  @returns {import('../ports.js').ContentResult} */
export function extractFromHtml(html, url, opts) {}
```
Keep the sanitizer (script/style/iframe/SVG-SMIL/`javascript:`/`data:`-on-href/
control-char guards) and scoring exactly. `Defuddle` runs on a linkedom doc in
Node; in the browser it runs on the real `document` — so `extractFromDocument`
must accept whatever `Document` it's handed and not assume jsdom. `ExtractOptions`:
`{minWords=300, minScore, disableWayback?}` (disableWayback is a fetch-tier
concern, ignored here). Reuse `test/extract.test.js` cases via the injected
parser (linkedom) so they run in Node.

## `src/send/index.js`
Sender interface + Gmail API implementation. Port the MIME builder from
`src/gmail/send.js` (keep `assertNoCrlf`, the filename quote/`;`/`\` guard,
base64url, RFC-2047 subject, retry/backoff).
```js
/** @param {{getToken:()=>Promise<string>, fetchImpl?:typeof fetch, maxAttempts?:number}} deps
 *  @returns {import('../ports.js').Sender} */
export function createGmailApiSender(deps) {}
export function buildMimeMessage(params) {}      // reused, unchanged shape
export function encodeMessageBase64Url(mime) {}
```
`getToken()` returns a fresh access token (chrome.identity in the extension; an
OAuth refresh in cli/desktop). `send(mail)` builds MIME from `mail` and POSTs to
the Gmail API with `Authorization: Bearer <token>`. Uses only `fetch` (browser +
Node 20+). SMTP stays out of core (it's node:tls; lives in cli/desktop).

## `src/insights/index.js`  (NEW)
Pure functions over a `Ledger` (no I/O, no network):
```js
/** @param {import('../ledger.js').Ledger} ledger
 *  @param {{now?:Date, rangeDays?:number, wordsPerMinute?:number}} [opts]
 *  @returns {Insights} */
export function computeInsights(ledger, opts) {}
/**
 * @typedef {Object} Insights
 * @property {number} backlog          // urls open >= 48h, not yet sent
 * @property {number} sentInRange
 * @property {number} reopenRate        // fraction of sent urls reopened after send (0..1)
 * @property {{domain:string,count:number}[]} topSources
 * @property {{date:string,count:number}[]} volumeByDay
 * @property {number} readingMinutes    // estimated, from wordCount totals
 * @property {number} streakDays        // consecutive days with >=1 send
 * @property {number} totalTracked
 * @property {number} totalSent
 */

/** On-device topic tags (no network): domain-category map + keyword heuristics.
 *  @param {import('../ports.js').Article} article @returns {string[]} */
export function tagTopics(article) {}
```
Ship a small, editable domain→category table (e.g. biorxiv/nature→"science",
github/stackoverflow→"dev", nytimes/theverge→"news") + a keyword pass for a
handful of themes. Deterministic, unit-tested with synthetic ledgers/articles.

## `src/llm/index.js`  (NEW)
Swappable provider router. **Bring-your-own-key; the only outbound bytes go to
the endpoint in `config`. No Kindling server, ever.**
```js
/** @param {LlmConfig} config @param {{fetchImpl?:typeof fetch}} [deps]
 *  @returns {LlmProvider|null}  // null when no key/endpoint configured */
export function createProvider(config, deps) {}
/**
 * @typedef {Object} LlmConfig
 * @property {'anthropic'|'openai-compatible'} provider
 * @property {string} apiKey
 * @property {string} [baseUrl]   // openai-compatible: OpenAI/OpenRouter/Ollama/LM Studio
 * @property {string} [model]
 * @property {boolean} [browserDirect]  // set the Anthropic browser-access header
 */
/**
 * @typedef {Object} LlmProvider
 * @property {(text:string, opts?:object)=>Promise<string>} summarize
 * @property {(text:string, opts?:object)=>Promise<string[]>} classify
 * @property {(items:{title:string,summary:string}[], opts?:object)=>Promise<string>} synthesize
 * @property {{provider:string, model:string, browserUsable:boolean}} info
 */
```
- `AnthropicProvider` → `POST {baseUrl||'https://api.anthropic.com'}/v1/messages`,
  headers `x-api-key`, `anthropic-version`; when `browserDirect`, also
  `anthropic-dangerous-direct-browser-access: true`. `info.browserUsable=true`.
- `OpenAiCompatProvider` → `POST {baseUrl}/chat/completions`, `Authorization:
  Bearer`. `info.browserUsable` = true only for localhost/OpenRouter-style hosts
  (document the heuristic; `api.openai.com` → false so the UI can steer that to
  the desktop tier).
- Inject `fetchImpl` for tests (never hit a real API in tests). Handle non-2xx +
  network errors by throwing a clear, key-free error. Keep prompts small and in
  one place; make model defaults overridable.

## `src/index.js`  (barrel + pipeline)
Re-export the public surface, and provide the shared orchestrator both the
extension and CLI call:
```js
/** Snapshot→reconcile→selectStale→screen/dedupe→getArticle(each)→buildEpub
 *  (split)→sender.send→recordDigest→save. Ports supply all platform I/O.
 *  @param {{
 *    urls?: string[],                 // explicit send list (bypasses staleness) — for "send now"
 *    openTabs?: {url:string,title:string}[], // for the scheduled path: reconcile + selectStale
 *    ports: { content: ContentSource, sender: Sender, storage: Storage, clock?: Clock },
 *    config: { kindleEmail:string, senderEmail:string, staleHours?:number,
 *              minWords?:number, filters?:object, title?:string }
 *  }} args
 *  @returns {Promise<DigestReport>} */
export async function runDigest(args) {}
```
`DigestReport`: `{ sent: string[], skipped: {url,reason}[], failed: {url,reason}[],
digests: {id,articles,sizeBytes,epubBytes:Uint8Array}[] }`. The caller decides
what to do with `epubBytes` (write to disk / hand to Sender already done inside).
Keep it dependency-injected and unit-testable with fake ports.
```
```
