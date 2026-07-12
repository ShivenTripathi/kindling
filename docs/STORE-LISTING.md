# Chrome Web Store listing — Kindling

Copy for the store submission, plus the permission justifications reviewers ask
for. Package with `npm run build && node pack.mjs` (in `packages/extension/`).

## Name
Kindling — tabs to Kindle

## Summary (132 char max)
Send tabs you left open too long to your Kindle as a clean, readable EPUB digest. Everything runs locally — nothing leaves your machine.

## Description
You open a lot of tabs you mean to read and never do. Kindling turns the ones
you've left open for a couple of days into a single, beautifully typeset EPUB
and emails it to your Kindle, so you can actually read them — on the device
made for reading.

- **One click.** Pick the tabs, hit send. Or set a schedule and forget it.
- **Reads the real page.** Extraction runs on the page as you see it (logged in,
  fully rendered), so it handles paywalled/JS-heavy sites that plain fetchers
  can't — and nothing gets fetched by any server but your own browser.
- **Private by design.** No account, no server, no analytics. The only thing
  that ever leaves your machine is the one email to your Kindle. The send
  permission is Gmail's **send-only** scope; your token is managed by the
  browser. Sensitive tabs (webmail, banking, etc.) are excluded automatically.
- **Your reading, visualized.** A local dashboard shows your backlog, what
  you've sent, and — the honest metric — how much of it you actually reopened.
- **Optional AI, your key, your choice.** Turn on a **free** Google Gemini key
  for article summaries and a monthly "your reading" digest. It's off by
  default; when on, your key stays on your device and only ever calls the
  provider you pick. No paid service is required or pre-configured.

Free and open source (MIT). github.com/ShivenTripathi/kindling

## Category
Productivity

## Permission justifications (for the review form)
| Permission | Why |
|---|---|
| `tabs` | Read the URLs/titles of your open tabs to know which have been open long enough and to offer them for sending. Metadata only. |
| `scripting` | Injected only on tabs you choose to send, to extract the article's readable content from the live page. Never runs automatically on every page. |
| `storage` | Store your settings and local reading history on your device. |
| `alarms` | Run the optional scheduled send in the background. |
| `identity` | Obtain a Gmail **send-only** token so the digest can be emailed to your Kindle. |
| `offscreen` | Build the EPUB (needs a DOM) during a scheduled send, when no window is open. |
| `optional_host_permissions` (http/https) | Requested at runtime, only to read the content of a tab you explicitly send. Declined by default. |

- **No remote code.** All scripts are bundled locally (esbuild); nothing is
  loaded from a CDN or eval'd.
- **Data handling disclosure:** "This extension does not collect or transmit
  user data to the developer or any third party. Page content is processed
  locally and emailed only to the user's own Kindle address via the user's own
  Google account. An optional user-supplied AI key calls only the endpoint the
  user configures."

## Privacy policy
Link to the repo's `docs/PRIVACY.md` (or host it). It already states the
one-exception data-flow promise and the optional-AI disclosure.

## Restricted-scope note
`gmail.send` is a Google **restricted** scope. For personal/test-user use
(≤100 users) no verification is needed. Wider public distribution would require
Google OAuth verification + a CASA security assessment — intentionally out of
scope (hobby project); users beyond the cap use a bring-your-own OAuth client
(`launchWebAuthFlow`) instead.

## Assets to prepare (manual)
- 128×128 store icon (have it: `public/icons/128.png`).
- 1–3 screenshots (1280×800 or 640×400): the popup send list, the dashboard,
  the options page. Capture from a loaded build.
- A short demo GIF (optional but converts well).
