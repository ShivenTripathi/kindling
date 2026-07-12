# @kindling/extension — architecture & internal contracts

MV3 extension that runs the `@kindling/core` pipeline entirely in the browser.
Bundled with esbuild (`build.mjs`) — every entry bundles core; no remote code.

## What runs where (the MV3 constraint)

A service worker has **no DOM** (`DOMParser`/`XMLSerializer`/`document` are
absent), but `buildEpub` and extraction need a DOM. So work is split:

| Context | Has | Runs |
|---|---|---|
| `background.js` (service worker, ES module) | chrome.*, fetch; **no DOM** | tab-age tracking, badge, `chrome.alarms`, config storage, message router, and the **scheduled** send (delegated to an offscreen doc) |
| `popup/` (extension page) | DOM + full chrome.* | onboarding + the **send-now** flow: runs `runDigest` directly |
| `offscreen/` (offscreen document) | DOM + fetch, limited chrome.* | runs `runDigest` for the scheduled path (created by the SW on alarm) |
| `content-extract.js` (injected via `chrome.scripting`) | the page's live DOM | runs `extractFromDocument` on the real, logged-in page |

## `src/content-extract.js`  (IIFE, injected into pages)
Self-contained classic script (bundled IIFE). On load it defines
`window.__kindlingExtract = () => ContentResult` which calls
`extractFromDocument(document, location.href, {minWords})` from `@kindling/core/extract`
and returns a **structurable** result (plain object — Article is JSON-safe).
The caller injects this file then `executeScript`s a tiny func that returns
`window.__kindlingExtract()`.

## `src/adapters.js`  (shared by popup + offscreen)
Implements the core ports with chrome APIs. Exports:
```js
export const chromeStorage;             // Storage port over chrome.storage.local (get/set/remove)
export function makeContentSource();    // ContentSource: getArticle(url) finds the tab, injects
                                        //   content-extract.js via chrome.scripting, returns its result.
                                        //   If no open tab matches the url (scheduled path), returns
                                        //   {status:'skipped', reason:'tab not open'} for the MVP.
export function makeGmailSender();      // createGmailApiSender({ getToken: getAuthToken })
export async function getAuthToken(interactive=true); // chrome.identity.getAuthToken → access token
export async function getAuthEmail();   // userinfo email (for senderEmail / display)
export async function loadConfig();     // reads 'config' from chromeStorage, applies DEFAULT_CONFIG
export async function saveConfig(cfg);
export const DEFAULT_CONFIG;            // { kindleEmail:'', senderEmail:'', staleHours:48, minWords:300,
                                        //   filters:{block:[],allow:[]}, disableWayback:false, llm:null }
```
The popup builds ports as `{ content: makeContentSource(), sender: makeGmailSender(),
storage: chromeStorage }` and calls `runDigest({ urls, ports, config })`. `dom`
is omitted — the popup/offscreen have DOMParser/XMLSerializer globals.

## `src/background.js`  (service worker)
- **Tab tracking:** on `tabs.onCreated/onUpdated/onRemoved` and an `alarms`
  recompute (every ~30 min), maintain a per-URL `{firstSeen}` map in
  chrome.storage (key `tabAges`). A tab is "stale" when
  `now - firstSeen >= config.staleHours`. Only track http(s) urls that pass
  `screenUrl` (import from `@kindling/core/filter`) — sensitive/app tabs are
  never tracked or offered.
- **Badge:** `chrome.action.setBadgeText` with the stale count.
- **Message router** (`chrome.runtime.onMessage`), sender must be the
  extension itself (no `externally_connectable`):
  - `GET_STATE` → `{ config, tabs: [{url,title,ageMs,stale}] }` (current stale-eligible tabs).
  - `SET_CONFIG` → persists, returns `{ok:true}`.
  - `SCHEDULE_INSTALL {everyMinutes}` / `SCHEDULE_UNINSTALL` → chrome.alarms.
- **Scheduled send:** on the send alarm, if a Kindle address is configured,
  ensure an offscreen document exists (`chrome.offscreen.createDocument`,
  reason `DOM_PARSER`, justification "build the EPUB digest"), and post it a
  `RUN_SCHEDULED` message; tear it down after. (MVP may stub this with a clear
  TODO if offscreen wiring runs long — but tab-tracking + badge + the popup
  send-now path must fully work.)

## `src/offscreen/offscreen.js`
On `RUN_SCHEDULED`: build ports (same adapters), gather open tabs from the SW,
call `runDigest({ openTabs, ports, config })`, post the report back to the SW.
(Content extraction still needs the tab open + scripting, which only the SW can
do — so the offscreen's ContentSource proxies extraction requests to the SW via
messages. For the MVP, if a scheduled tab isn't open, it's skipped with a
reason; document this.)

## `src/popup/`  (popup.html + popup.js + popup.css)
The primary UX. On open:
1. If no `kindleEmail` configured → show a short onboarding (enter Kindle
   address; a "Connect Google" button that calls `getAuthToken(true)` to grant
   send + capture the sender email). Link to options for details.
2. Else → `GET_STATE`, render the stale-tab list: each row a checkbox (checked),
   title, domain, age ("3d"); a primary **"Send N to Kindle"** button; a
   "close tabs after sending" toggle; a link to the dashboard/options.
3. On send: build ports, `runDigest({ urls: selectedUrls, ports, config })`,
   show per-tab progress and a final success/error state. If `closeAfterSend`,
   `chrome.tabs.remove` the sent tabs.
Design it cleanly (light+dark, keyboard-accessible) — this is a product surface.

## `src/options/`  (options.html + options.js + options.css)
Settings: Kindle address, sender (from Google), staleHours, schedule on/off +
interval, exclusion block/allow lists, `disableWayback`, and the LLM section
(provider + key + baseUrl + model) stored in `config.llm` — the AI layer is
wired in Phase D, but the fields live here now, clearly "optional, local-only".

## Build & load
`npm run build --workspace @kindling/extension` → `dist/`. Load unpacked from
`packages/extension/dist`. The `oauth2.client_id` in the manifest is a
placeholder — the shared client is created once (SETUP); until then, testers can
paste their own client id. Keep permissions minimal; justify each in the store
listing later.
