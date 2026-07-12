# Security audit — 2026-07-11

A full adversarial audit was run before the tool was first used with real
credentials: three parallel review passes (extension + native host; secret
lifecycle + data leakage; a re-probe of every prior fix plus new attack
classes), plus a dependency scan. Every finding below was fixed and covered by
a regression test. `npm audit`: 0 vulnerabilities.

This complements `REWORK-REPORT.md` (which covers the earlier extraction-layer
review). Together they are the record of what was checked and hardened.

## Fixed

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | Critical | `security` keychain call passed the secret in argv, so a failure (locked keychain / SSH / disk-full) echoed the credential into an error message printed to stdout | `setSecret` now passes the secret over **stdin** (`-w` with no value); it never appears in argv, and error messages are constructed by us with no argv/stdin content (`src/gmail/keychain.js`) |
| 2 | Blocker | EPUB image embedder fetched every `<img src>` with a raw `fetch()` — an attacker page's `<img src="http://169.254.169.254/…">` was downloaded and embedded into the digest | Image fetches routed through the shared SSRF-guarded `fetchBytesSafe` (private/loopback/link-local + DNS-pin + per-redirect-hop revalidation) (`src/epub.js`, `src/extract/fetch.js`) |
| 3 | Blocker | Tier-2 headless Chrome followed redirects / JS navigation to internal IPs (outside the undici guard) | All Chrome traffic routed through a local validating forward proxy that refuses forbidden hosts on every CONNECT/request; shared `isForbiddenHost`/`assertHostAllowed` classifier (`src/extract/fetch.js`) |
| 4 | Major | The browser extension tracked and could send sensitive tabs (webmail, banking, Stripe) — capturing authenticated DOM — because it never applied the exclusion list | Extension filters via a mirrored `isSendableUrl`; the native host **re-screens authoritatively** with `screenUrl` before extracting (`extension/common.js`, `extension/background.js`, `native-host/host.js`) |
| 5 | Major | Prototype pollution: a crafted tab URL of `__proto__` became a ledger object key | Reject `__proto__`/`constructor`/`prototype` keys; use `Object.hasOwn` (`src/ledger.js`) |
| 6 | Major | SVG SMIL `<animate attributeName="href" values="javascript:…">` survived the sanitizer (mutation-XSS) | `animate`/`set`/`animate{Motion,Color,Transform}` added to the disallowed tags (`src/extract/sanitize.js`) |
| 7 | Major | Native-messaging host had no message-size cap — a ~4GB length prefix could exhaust memory | `MAX_MESSAGE_BYTES` (64MB) cap; oversized frame disconnects cleanly (`native-host/framing.js`, `host.js`) |
| 8 | Medium | Config and browsing-history ledger were created world-readable (`0644`) | Written `0600` in `0700` directories; EPUB output too (`src/config.js`, `src/ledger.js`, `src/epub.js`) |
| 9 | Medium | Secret prompts in `init` echoed to the terminal | Masked, no-echo input for the client secret / app password (`src/cli.js`) |
| 10 | Minor | Attachment filename could break out of the `Content-Disposition` quotes | Reject `"`, `\`, `;` in the filename (`src/gmail/send.js`) |
| 11 | Minor | C0 control chars in a page title could produce a non-well-formed EPUB | Stripped before XML-escaping (`src/epub.js`) |

## Verified already-solid (no change needed)

- OAuth uses loopback + PKCE (S256), the `state` parameter is validated (login-CSRF defense), scope is `gmail.send` + read-only `email` only.
- Tokens transit only over HTTPS to Google; access tokens are never logged; the refresh token lives only in the Keychain.
- DNS-rebind TOCTOU is closed on the undici tiers via a connect-time custom `lookup`, and on tier-2 via resolve-then-check in the proxy.
- No telemetry, analytics, or remote logging anywhere; the only outbound traffic is the article fetch, the last-resort Wayback fallback (disclosed in `PRIVACY.md`), and the Gmail send.
- `to`/`from` addresses are re-validated at send time; MIME/SMTP inputs reject CR/LF.
- All keychain calls use `execFile`/`spawn` with an argv array (no shell); the launchd plist is XML-escaped.

## Residual limitations (documented, not fully solved)

See `REWORK-REPORT.md` "Residual limitations": a sufficiently adversarial DNS
resolver remains out of scope everywhere (narrow-TTL rebind between guard lookup
and connect), and the tier-2 proxy only covers http(s)/ws (the only schemes
Chrome is ever handed). Both are bounded and acknowledged in code comments.
