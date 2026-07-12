# Privacy

Kindling is built so that **your browsing data never leaves your machine** — with exactly one exception, which is the whole point of the tool: the digest email you send to your own Amazon Send-to-Kindle address.

## What Kindling reads

- The list of open tabs in **one Chrome profile you explicitly select** during `kindling init`. No other profile is ever read. Your work profile, if separate, is untouchable by construction.
- Chrome's session files are read **read-only**. Kindling never writes to, modifies, or deletes anything in your Chrome data directory.

## What Kindling stores, and where

Everything stays in local files under your home directory:

| Data | Location | Contents |
|---|---|---|
| Config | `~/.config/kindling/config.json` | Your chosen profile, Kindle address, sender address, thresholds. No secrets. |
| Ledger | `~/.local/share/kindling/ledger.json` | Per-URL first-seen / sent / reopened history. Plain, human-readable JSON you can inspect or delete at any time. |
| Send credential | **macOS Keychain** | A revocable, send-only Gmail OAuth refresh token (scope `gmail.send`) — never a password, never in a file. |

## What leaves your machine

1. **Fetching article content.** To build the digest, Kindling downloads the pages you left open — the same requests your browser already made. These go directly to those sites, over HTTPS, from your machine. Nothing is proxied through us (there is no "us" — there is no server).
2. **Last-resort archive fallback.** If a page can't be fetched directly (bot-challenge or a JavaScript-only site) and can't be rendered by your local headless Chrome either, Kindling makes a final attempt via the **Internet Archive's Wayback Machine** (`web.archive.org`). This means that *one specific tab URL* (only when both earlier tiers fail) is sent to archive.org, a third party. This is the sole third-party any tab URL is ever disclosed to, and it happens only as a last resort. To turn it off entirely, set `"disableWayback": true` in `~/.config/kindling/config.json` — Kindling will then simply skip any page it can't fetch itself rather than consult the archive.
3. **The digest email.** The finished EPUB is emailed from your Gmail to your `@kindle.com` address via Google's API. That is the only outbound transmission of your content, and it goes to your own devices.

There is **no telemetry, no analytics, no crash reporting, no phone-home, no remote server of any kind.** You can verify this: the source is small, MIT-licensed, and dependency-audited. Grep for network calls — you will find only the article fetcher and the Gmail send.

## Your controls

- `kindling history` — see exactly what was sent and when.
- Delete `ledger.json` to forget all history. Delete the Keychain item (or revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions)) to cut off sending instantly.
- `kindling block <domain>` — never send a domain. Sensitive sites (banking, checkout, mail, internal hosts) are excluded by default.
