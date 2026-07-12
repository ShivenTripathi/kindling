# Kindling — browser extension

The one-click front end: it finds tabs you've left open for 48h+, extracts each
from the **live, logged-in page**, builds a clean EPUB digest, and emails it to
your Kindle — all in the browser, nothing to a server.

## Build

```sh
npm install                              # from the repo root (workspaces)
npm run build --workspace @kindling/extension
```

Output lands in `packages/extension/dist/`. For iterating: `npm run watch --workspace @kindling/extension`.

## Load it (Chrome / Edge / Brave)

1. Go to `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select `packages/extension/dist`.
3. Copy the extension's **ID** (shown on its card) — you need it for OAuth.

## One-time: the Google OAuth client (for sending)

Sending uses Gmail's send-only scope via `chrome.identity`. You register one
OAuth client; end users never touch the Console.

1. [console.cloud.google.com](https://console.cloud.google.com) → a project → **Enable the Gmail API**.
2. **OAuth consent screen**: External; add yourself as a **test user** (this
   avoids Google's verification/CASA review — fine for ≤100 users, which is our
   deliberate hobby-scale ceiling; see `docs/SECURITY-AUDIT.md`/the direction plan).
3. **Credentials → Create credentials → OAuth client ID → Application type:
   "Chrome App"** (a.k.a. Chrome Extension). Paste the extension **ID** from
   the step above as the Application ID.
4. Copy the generated **Client ID**.
5. Put it in `packages/extension/public/manifest.json` under
   `oauth2.client_id`, then **rebuild** and reload the unpacked extension.

> Stable ID note: an unpacked extension's ID changes if the path/key changes.
> To pin it (so the OAuth client keeps matching), add a `"key"` to the manifest
> (`chrome.google.com/webstore/devconsole` or the packed-crx public key). For a
> quick test, just re-copy the ID and update the client if it changes.

## Use it

1. Click the toolbar icon → onboarding: enter your **Send-to-Kindle address**
   and click **Connect Google (send-only)** (one "Allow").
2. The popup lists tabs open long enough, already filtered of anything
   sensitive (webmail, banking, etc. — the shipped exclusion list). Pick some,
   hit **Send to Kindle**.
3. **Options** (right-click the icon → Options, or the popup's Settings link):
   staleness threshold, a schedule (background sends via `chrome.alarms`),
   exclusion lists, the archive.org-fallback toggle, and the optional,
   local-only **AI insights** key.
4. **Your reading** (dashboard, linked from the popup): backlog, what you've
   sent, and how much of it you actually reopened — all computed locally.

## Cross-browser note

`chrome.identity.getAuthToken` is Chrome-only. Edge/Brave work with the same
client; Firefox (and a "bring-your-own client" path with no user cap) will use
`chrome.identity.launchWebAuthFlow` instead — planned in Phase E.

## Privacy

Nothing leaves your machine except (a) the pages Kindling fetches to build the
digest — the same requests your browser already makes — and (b) the one email
to your Kindle. The send token is managed by the browser; the optional AI key
is stored locally and only ever used to call the endpoint you configure. See
the repo's `docs/PRIVACY.md` and `SECURITY.md`.
