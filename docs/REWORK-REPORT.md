# Extract module — rework report

The `src/extract/` module was reworked after an adversarial review + a real-page
integration test surfaced one functional bug and several security findings.
Each fix and its verification is below.

## 1. Defuddle ran on jsdom → primary engine silently broken (functional)

Defuddle uses the `:has()` CSS selector, which jsdom's selector engine (nwsapi)
rejects with `SyntaxError: ':has(source)' is not a valid selector`. Every page
threw, so extraction silently fell back to Readability — defeating the Phase-0
bake-off decision.

**Fix:** build Defuddle's input document with **linkedom** (which supports
`:has()` — the environment the bake-off actually used); Readability stays on
jsdom. `linkedom` added to `dependencies`. Engine failures are caught and return
`null` without spamming stderr.

**Verified:** `runEngine('defuddle', …)` returns clean content (420 words,
correct title) on a fixture, no selector error.

## 2. IPv4-mapped IPv6 SSRF bypass (blocker)

`http://[::ffff:169.254.169.254]/…` (normalized to `::ffff:a9fe:a9fe`) reached
the cloud-metadata endpoint — the IPv6 guard didn't decode mapped IPv4.

**Fix:** detect `::ffff:w.x.y.z` and `::ffff:a:b` forms, extract the embedded
IPv4, and run the existing private/loopback check. Also covers `0.0.0.0`.

**Verified:** `assertFetchable` now blocks `[::ffff:169.254.169.254]`,
`[::ffff:127.0.0.1]`, `0.0.0.0`, `[::1]`, `169.254.169.254`; a normal public
URL still passes.

## 3. Sanitizer bypasses (blocker — the digest is a file the user opens)

Three confirmed bypasses in `sanitize.js`: `style="…url(javascript:…)/expression(…)"`
survived; `<a href="data:text/html,<script>…">` survived; whitespace-obfuscated
`java\tscript:` / `java\nscript:` survived.

**Fix:** strip all `style` attributes (we apply our own EPUB CSS); strip C0
control characters before scheme-matching; block `data:` on link `href` (kept on
`<img src>`, where data-URIs are legitimate); sanitize `srcset` too.

**Verified:** regression tests for each bypass class in the sanitize tests.

## 4. Headless-Chrome tier hardening (major)

Tier-2 spawned Chrome without an isolated profile and buffered stdout unbounded.

**Fix:** per-invocation ephemeral `--user-data-dir` (never touches the user's
real profile/cookies, avoids the singleton-lock collision), stdout capped to the
same byte limit as the other tiers (kill + fail on exceed), args passed as an
array (no shell), URL re-validated through the SSRF guard before spawn.

## 5. Tier-3 (Wayback) was unreachable (major, correctness)

Escalation to Wayback only fired when the fetch started at tier-1, but
`fetchPage()` can internally escalate to tier-2 and return `tier:'tier2'`, which
foreclosed the documented last-resort tier.

**Fix:** escalate to Wayback whenever extraction is still thin after whichever
tier `fetchPage()` returned, without re-running a tier already attempted.

## 6. Added `test/fetch.test.js` (major, coverage)

The fetch layer — the module its own comments call "the real risk" — had no
direct tests. Added coverage for the SSRF guard (all vectors above), per-hop
redirect re-checking, and the streaming byte cap.

## 7. Tier-2 redirect/JS-navigation SSRF (blocker)

`fetchTier2Chrome` only validated the INITIAL url via `assertFetchable`, then
handed it to a real, spawned Chrome (`--dump-dom`). Chrome does its own
navigation after that: an HTTP redirect, a JS `location.href = …`, a
`fetch()` inside the page, or a `<meta refresh>` could all send it to
`http://169.254.169.254/latest/meta-data/…` or an internal LAN service, and
`--dump-dom` would return that internal content as "the article" — which
could end up embedded in the digest emailed to the user. None of that
navigation happens through undici, so `ssrfSafeDispatcher` (tiers 1/3) never
saw it.

**Fix:** route every byte of headless Chrome's traffic through a local
validating forward proxy (`startSsrfSafeProxy` in `fetch.js`) started fresh
per `fetchTier2Chrome` invocation and torn down in the same `finally` as the
ephemeral `--user-data-dir`. Chrome is launched with
`--proxy-server=http://127.0.0.1:<port>` and
`--proxy-bypass-list=<-loopback>` (Chrome has a hardcoded implicit rule that
sends loopback targets DIRECT, bypassing any configured proxy, unless this
flag removes it — without it, `127.0.0.1`/`169.254.169.254`-shaped targets
would sail straight past the proxy). The proxy handles both plain HTTP
(absolute-URI GET forwarding) and HTTPS (`CONNECT` tunneling), and for every
target runs the same host check as tier 1/3 through a newly-extracted
`assertHostAllowed`/`isForbiddenHost` pair (refactored out of
`assertFetchable` so there is exactly one place that knows the private/
loopback/link-local IP-range rules) — refusing with 403 (plain HTTP) or a
closed CONNECT (HTTPS) before ever opening a socket to the forbidden target.
This covers the initial navigation, every redirect hop, and any JS-initiated
request/navigation in one choke point, since all of it has to go through
this one proxy process to leave the sandboxed Chrome instance at all.

**Verified:** `test/fetch.test.js` drives the proxy directly with raw TCP
sockets (no real Chrome needed) — `CONNECT 127.0.0.1:9999`,
`CONNECT 169.254.169.254:443`, `CONNECT localhost:443`, and
`GET http://192.168.1.1/secret` are all refused with 403/connection-close.
`isForbiddenHost`/`assertHostAllowed` are also tested directly against the
full forbidden-host list (loopback, 10/8, 172.16/12, 192.168/16, 169.254/16,
0.0.0.0, `::1`, `fe80::/10`, `fc00::/7`, IPv4-mapped IPv6) plus a public host,
proving tiers 1/3 and the tier-2 proxy share one classifier rather than two
that could drift apart.

**Chrome-flag caveat:** `--proxy-server` is a well-supported, stable Chrome
flag, but it only covers HTTP/HTTPS/WS — Chrome can still resolve/attempt
other schemes (e.g. `file://`, `chrome://`) directly. That's out of scope
here: `assertFetchable` already restricts the URL handed to Chrome to
`http(s):`, and `--dump-dom` doesn't follow non-http(s) redirects from a
page's normal navigation APIs. `--proxy-bypass-list=<-loopback>` syntax is
Chromium's own (not a standard proxy-PAC syntax); it has been stable across
recent Chrome versions but is unofficial/undocumented in the public flag
reference, so it's worth re-verifying if `KINDLING_CHROME_PATH` is ever
pointed at a very old or very new Chrome build.

## Residual limitations (documented, not fully solved)

- **DNS-rebinding TOCTOU — tiers 1/3:** `assertFetchable` resolves and checks
  once, but `ssrfSafeDispatcher` installs a custom DNS `lookup` on undici's
  connect path, so the SAME resolution that opens the TCP socket is
  re-validated — this closes the gap down to "undici's own connect path",
  which is as tight as achievable without vendoring a raw socket layer.
  Acknowledged in the `fetch.js` module comment.
- **DNS-rebinding TOCTOU — tier 2:** closed the same way, but in the proxy
  instead of undici: `assertHostAllowed` (used by both the CONNECT and plain-
  HTTP handlers) does its own resolve-then-check for hostnames, and, because
  the proxy's own subsequent `net.connect`/`http.request` calls to the target
  resolve DNS independently again, a narrow-TTL rebind between the guard's
  lookup and the forward connection's lookup is the same residual window as
  tiers 1/3 — not further closed to a single shared resolution the way
  `ssrfSafeDispatcher`'s custom `lookup` does. A sufficiently adversarial
  resolver/network path remains out of scope everywhere in this codebase.
- **Non-http(s) schemes inside Chrome:** the proxy only intercepts
  HTTP/HTTPS/WS traffic (everything `--proxy-server` covers); Chrome's
  handling of exotic schemes it might attempt on its own (e.g. `file://`)
  is not routed through the guard. `assertFetchable` already restricts the
  url handed to Chrome to `http(s):`, which bounds this in practice.
