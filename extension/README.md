# Kindling — Chrome Extension

The premium front-end to the same local pipeline the CLI uses
(`extract → epub → send → ledger`, all in `../src/`). It tracks how long
your tabs have been open, badges the toolbar icon when tabs go stale, and
sends them to your Kindle — optionally capturing the *already-rendered,
authenticated* page from the live tab, which the CLI's own fetcher can't do.

Nothing here talks to a server. See `CLAUDE.md` at the repo root for the
project's invariants (local-only, zero telemetry, profile isolation,
least-privilege secrets) — this extension is built to the same bar.

## Load it (development / personal use)

1. Install the native-messaging host first (it's what actually runs the
   pipeline — the extension alone can't extract/build/send anything):
   ```
   node native-host/install.js
   ```
   This writes a manifest to
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kindling.host.json`
   with a placeholder extension ID, since Chrome only assigns a real one
   once the extension is loaded (step 2).

2. Open `chrome://extensions`, enable **Developer mode** (top-right toggle),
   click **Load unpacked**, and select this `extension/` directory.

3. Copy the extension ID shown on Kindling's card (a 32-character string),
   then re-run the installer with it so Chrome will actually accept
   connections from this specific extension:
   ```
   node native-host/install.js <EXTENSION_ID>
   ```

4. Reload the extension (the circular-arrow icon on its card in
   `chrome://extensions`) so it picks up the freshly-written native host
   manifest, then click the toolbar icon.

You'll also need `kindling init` run at least once from the repo root
(same config/Keychain setup the CLI uses — profile, Kindle address, Gmail
auth) since the native host reads `~/.config/kindling/config.json` and the
Keychain secrets it points to.

To remove the native-messaging host: `node native-host/install.js --uninstall`.
The extension itself is removed from `chrome://extensions` directly.

## How the DOM-capture path works

By default the extension has **zero host permissions** — nothing beyond
`tabs`/`storage`/`alarms`/`nativeMessaging`/`scripting`, none of which grant
access to page *content*. The first time you try to capture a rendered page,
the popup asks (via `chrome.permissions.request`, a runtime, revocable grant
— never something bundled into the install-time permission list) for
`http://*/*` and `https://*/*` so `chrome.scripting.executeScript` is allowed
to run on an arbitrary background tab you've selected. If you decline, or
never enable it, Kindling still works — the native host just fetches each
URL itself with the CLI's own tiered fetcher (plain HTTP → headless Chrome →
Wayback Machine) instead of using the live tab's DOM.

When enabled, sending a tab calls `chrome.scripting.executeScript` to read
`document.documentElement.outerHTML` from that live tab and passes it to the
native host as `rawHtml`, which flows straight into `extract(url, { rawHtml })`
(see `docs/interfaces.md`) — bypassing the fetcher entirely. This is the
extension's actual value proposition: it captures the page *as your browser
already rendered it*, logged in, JS executed, paywall/bot-challenge already
resolved — something no server-side or CLI fetch can replicate.

## What needs the real extension ID to finalize

- `native-host/com.kindling.host.json`'s `allowed_origins` (handled for you
  by `install.js <EXTENSION_ID>` in step 3 above — Chrome will silently
  refuse to connect to the native host until this matches).
- Nothing else. The extension has no hardcoded ID of its own to update.

Note the extension ID changes if you re-load the unpacked folder from a
different path, or once you package/sign it for the Web Store — re-run the
installer whenever that happens.

## Permissions requested, and why

| Permission | Why | Scope |
|---|---|---|
| `tabs` | Read each open tab's `url`/`title` to track age and detect reopens. | Metadata only — never page content. |
| `storage` | Persist tab-age tracking and send history in `chrome.storage.local`. | Local to this browser profile; never synced. |
| `alarms` | Periodically recompute staleness/badge without an always-on background page. | No data access. |
| `nativeMessaging` | Talk to the local `com.kindling.host` process that runs the real pipeline. | Local IPC only — this is the one and only channel data leaves the extension through, and it stays on-machine. |
| `scripting` | Read the rendered DOM of a tab **the user explicitly chose to send**, on click only. No `content_scripts` are declared — nothing runs on page load or on any page the user hasn't acted on. | Requires the tab already be one the extension knows about (an open, tracked tab); combined with the host permission below. |
| `http://*/*`, `https://*/*` (**optional**, requested at runtime) | Lets `scripting.executeScript` target an arbitrary *background* tab (not just the foreground one), which is required because sending typically means several stale tabs at once, not the one tab currently in focus. `activeTab` alone only ever covers the single active tab of the current window and can't satisfy that. | Declared as `optional_host_permissions`, **not** granted at install. Requested via a runtime `chrome.permissions.request()` prompt, only the first time DOM-capture is used, and revocable at any time from `chrome://extensions` → Kindling → Site access. Declining it doesn't break the extension — see "DOM-capture path" above. |

No `<all_urls>` host permission is declared at install time, no
`content_scripts` run automatically anywhere, and there is no permission
this extension requests that it doesn't have an immediate, visible use for
in the popup UI.

## No remote code / Web Store compliance

- All JavaScript is plain ES modules shipped in this directory — no bundler,
  no CDN `<script src>` tags, no `eval`/`new Function` on fetched strings,
  no remotely-hosted code of any kind. Every file Chrome loads is one you
  can read in this repo.
- The only network call the extension itself makes is none — all HTTP
  (page fetches, Gmail API) happens in the native host process (`../src/`),
  which is a separate local process the extension talks to over
  `nativeMessaging`, not over the network.
- `manifest.json` declares no `content_security_policy` override beyond
  MV3's already-strict default, since nothing here needs relaxed CSP.

## Privacy

Kindling doesn't collect, transmit, or store your browsing data anywhere
but your own machine (`chrome.storage.local` for tab/history tracking, and
`~/.local/share/kindling/ledger.json` + `~/.config/kindling/config.json` for
the shared pipeline state — see `../CLAUDE.md`). The only data that ever
leaves your machine is the single EPUB email sent to your own
`@kindle.com` address via your own authenticated Gmail account. See
`../SECURITY.md` for the fuller security/privacy writeup this extension
inherits unchanged.

## Files

```
extension/
  manifest.json        MV3 manifest — minimal permissions, no remote code
  background.js         service worker: tab-age tracking, badge, native messaging
  common.js              shared pure helpers (URL normalization, formatting)
  popup/                 "N stale tabs → Send to Kindle" UI
  history/                reverse-chronological digest + reopen history UI
  icons/                  toolbar icon (SVG source + generated PNGs)

native-host/
  host.js                the native-messaging host: extract → epub → send → ledger
  framing.js              Chrome's length-prefixed JSON wire protocol (unit-tested)
  com.kindling.host.json  native host manifest template
  install.js              installs/uninstalls the manifest for macOS Chrome
```
