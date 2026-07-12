# @kindling/desktop — Tauri app contract

A desktop app whose distinct value is **running the digest even when the
browser is closed** — it reads Chrome's on-disk **session files** (which persist
when Chrome isn't running), reuses `@kindling/core` in the webview, and adds a
Rust backend for file access + SMTP. **SMTP (app password) is the primary send
here** (no OAuth dance); Gmail-API can come later.

Layout:
```
packages/desktop/
├── package.json                 (done)
├── build.mjs                    esbuild: bundle src/main.js → dist/ + copy public/
├── public/index.html            the app window
├── src/                         frontend JS (webview) — uses @kindling/core
│   ├── main.js                  UI + runDigest wiring
│   └── adapters.js              core ports over Tauri APIs
└── src-tauri/                   Rust backend (tauri init baseline + our commands)
    ├── Cargo.toml  tauri.conf.json  build.rs  capabilities/default.json  icons/
    └── src/main.rs (+ lib.rs)
```

## Rust commands (invoke from JS via `@tauri-apps/api/core` `invoke`)

- `list_chrome_profiles() -> Vec<{ id: String, name: String, email: Option<String> }>`
  Read `~/Library/Application Support/Google/Chrome/Local State` (JSON,
  `profile.info_cache`) + each profile's `Preferences`. macOS path; keep a
  `chromeRoot` override via env for tests.
- `newest_session_bytes(profile_id: String) -> Vec<u8>`
  Find the newest `Session_*` file in `<chromeRoot>/<profile_id>/Sessions/`,
  return its raw bytes. Errors if the profile/dir is missing.
- `send_smtp(opts) -> Result<(), String>` where opts =
  `{ host, port, username, password, from, to, subject, body_text,
     attachment_b64, attachment_name }`. Build a `lettre` message with the
  base64-decoded EPUB as an `application/epub+zip` attachment and send over
  implicit-TLS SMTP (e.g. smtp.gmail.com:465). Never log the password.
- `app_data_dir() -> String` — absolute path to the app's data dir (for
  config.json + ledger.json). Create it if missing.

Use the **Tauri fs plugin** (or simple `read_text_file`/`write_text_file`
commands) for config/ledger JSON, and the **Tauri http plugin**
(`@tauri-apps/plugin-http`) for article fetching (native requests, no CORS).
Register the http + fs plugins in `main.rs` and grant them in
`capabilities/default.json` (allow http to https/http, fs to the app data dir).

`cargo check` (with `PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`)
must pass. A full `tauri build` needs signing/bundling; `cargo check` +
`tauri dev` compiling is the bar for this MVP.

## `packages/core/src/snss.js`  (NEW — browser-safe SNSS parser)
Port the pure parser from the old `/Users/shiventripathi/dev/kindling/src/tabs/snss.js`,
but **browser-safe**: rewrite the `Cursor` to use `DataView` + `TextDecoder`
instead of Node `Buffer` methods (`readUInt8/16/32LE`, `readBigUInt64LE`,
`toString('utf8'|'utf16le')`). Keep the format logic, `SnssParseError`, and
truncation tolerance identical. Export:
```js
export function parseSnssBuffer(bytes) {}          // Uint8Array → richer per-tab objects
export function openTabsFromBytes(bytes) {}        // → {url,title,windowId,tabId,index}[]
export class SnssParseError extends Error {}
```
Add `@kindling/core` subpath export `"./snss": "./src/snss.js"`. Port the
existing snss tests (`test/tabs.test.js` parsing cases) to
`packages/core/test/snss.test.js`, feeding `Uint8Array` fixtures. No `node:*`.

## `packages/desktop/src/adapters.js`  (core ports over Tauri)
- `tabsAdapter.readOpenTabs(profileId)` → `invoke('newest_session_bytes')` →
  `openTabsFromBytes` (from `@kindling/core/snss`).
- `contentSource` → `getArticle(url)`: screen via core `screenUrl`; fetch HTML
  via `@tauri-apps/plugin-http` `fetch`; `new DOMParser().parseFromString(html,
  'text/html')`; `extractFromDocument(doc, url, {minWords})`. Never throws.
- `smtpSender` → `send(mail: OutgoingMail)`: base64 the `mail.attachment`,
  `invoke('send_smtp', {...})` with the configured SMTP settings.
- `storage` → read/write `config.json`/`ledger.json` under `app_data_dir()`
  via the fs plugin (Storage port: get/set/remove keyed to those two files, or
  a single store file with keys `config`/`ledger`).
- `dom` is unnecessary (webview has DOMParser/XMLSerializer globals → buildEpub
  uses them automatically).

## `packages/desktop/src/main.js`  (UI)
A single-window UI: pick profile; show stale tabs (read via the tabs adapter +
ledger `selectStale`); a "Send to Kindle" button running `runDigest({ openTabs,
ports:{content, sender:smtp, storage}, config })`; a settings panel (Kindle
address, SMTP host/port/user/app-password, staleHours, profile). A "Run now"
plus a simple interval timer while open; document autostart/tray as the
background mechanism (a nice-to-have if time permits via the autostart plugin).
Clean, minimal, light/dark, vanilla JS. Reuse the ember look.
