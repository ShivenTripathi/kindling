# Security

## Threat model & design choices

Kindling handles two sensitive things: **access to your open tabs** and **the ability to send email as you**. Both are minimized by design.

### Sending: least-privilege OAuth, not a password

The default sending method is **OAuth2 with the `gmail.send` scope** (plus the read-only `email` scope, used only to label the stored token with the account it belongs to). What Kindling stores is a *refresh token that can do exactly one thing — send mail* — not your password and not full-account access. Concretely this means:

- Kindling **cannot read your inbox**, cannot access Drive, contacts, or anything else. The Google consent screen shows exactly two lines: `Send email on your behalf` and `See your primary Google Account email address`. The second grants no data access beyond the address itself; if you prefer to avoid even that, the app-password fallback keys its credential locally and requests no scopes at all.
- The token is **revocable at any time** at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) — independent of your password.
- The token lives in the **macOS Keychain**, encrypted at rest by the OS, gated by your login. It is never written to a config file, never logged, never committed.
- The OAuth flow uses the **loopback redirect with PKCE** (Google's recommended flow for installed apps), so the authorization code cannot be intercepted by another local process.

An **app-password + SMTP** method is offered as a documented fallback for users who prefer a 2-minute setup over creating an OAuth client. It is strictly opt-in; the app password also lives only in the Keychain. We recommend OAuth.

> Why is anything stored locally at all? Unattended sending (the cron/launchd flow) requires *some* durable credential on the machine. The security question is not "file vs. nothing" but "*what* is stored and *how*." Kindling stores the least-powerful credential available (send-only, revocable) in the OS's dedicated secret vault.

### Reading tabs: one profile, read-only

- Only the single Chrome profile chosen at setup is read. There is no code path that enumerates-and-reads all profiles.
- Session files are opened read-only. Kindling never writes to your Chrome data.
- Closing tabs after sending is **only** possible via the optional browser extension, using Chrome's own `chrome.tabs` API, and is **off by default**.

### Fetching pages: SSRF-aware

The article fetcher only follows `http(s)` URLs, refuses `localhost`/private-IP/link-local targets, caps redirects, and sets a timeout. HTML is sanitized before it is placed into the EPUB (no scripts, no remote-loading tags beyond bundled images).

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or email the maintainer. Do not file public issues for exploitable vulnerabilities. We aim to acknowledge within a few days.

## Auditing it yourself

The codebase is intentionally small and dependency-light. To confirm the privacy claims:

```sh
# every place Kindling touches the network:
grep -rn "fetch\|request\|https\?:" src/ | grep -v "test"
# should be only: src/extract/ (article fetch) and src/gmail/ (send)
```
