// fetch.js
//
// The tiered fetcher. Phase-0 bake-off found the fetch layer, not the engine,
// is the real risk: 3/9 corpus URLs blocked a plain GET (Cloudflare/WAF bot
// challenges) and 1 was a JS-only SPA that no engine could parse from raw
// HTML. So we escalate through three tiers, each strictly more expensive
// than the last:
//
//   Tier 1: plain HTTPS GET with realistic desktop headers.      (fast path)
//   Tier 2: render via the user's installed Chrome (DevTools     (defeats
//           Protocol `--dump-dom`); no bundled Chromium.          SPAs/challenges)
//   Tier 3: Wayback Machine "closest snapshot" redirect.          (last resort)
//
// `fetchPage()` is the single entry point most callers want: it tries tier 1
// and auto-escalates to tier 2 / tier 3 when tier 1 itself signals failure
// (HTTP error, or a response that looks like a bot challenge). The OTHER
// escalation condition described in docs/interfaces.md — "downstream
// extraction is empty/thin" — can only be known after running the engines,
// so `src/extract/index.js` drives that escalation itself by calling
// `fetchTier2Chrome` / `fetchTier3Wayback` directly when the tier-1 result
// parses thin. Both call sites end up exercising the same tiers; this file
// just owns the mechanics of each tier plus the fast-fail auto-escalation.

import { request, Agent } from "undici";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import dns from "node:dns";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024; // 15MB — refuse huge bodies early
const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---- SSRF guard -------------------------------------------------------
//
// This tool fetches whatever URL happens to be sitting in an open tab, so a
// malicious or compromised page could point us at localhost or an internal
// service (e.g. a cloud metadata endpoint) hoping we'll fetch it on its
// behalf. We refuse anything that isn't plain http(s), and refuse hosts that
// are localhost or resolve to a private/link-local address — checked on the
// LITERAL hostname (catches "http://127.0.0.1/...") and again on the
// resolved IP after DNS (catches "http://attacker-controlled-dns-name/...").

function isIpv4PrivateOrLoopback(hostname) {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true;
  return false;
}

function isIpv6PrivateOrLoopback(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1") return true; // loopback
  if (/^fe80:/.test(h)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local

  // IPv4-mapped IPv6 (::ffff:w.x.y.z or the hex form the URL parser/Node
  // canonicalizes it to, ::ffff:a:b) can smuggle a loopback/link-local/
  // private v4 address past a check that only ever looked at IPv6-shaped
  // patterns — e.g. `[::ffff:169.254.169.254]` normalizes to
  // `::ffff:a9fe:a9fe` and would otherwise sail through as "not IPv6
  // private" AND "not IPv4" (it doesn't match the dotted-quad regex).
  // Extract the embedded IPv4 and run it back through the real IPv4 check.
  const mappedDotted = h.match(
    /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (mappedDotted) {
    return isIpv4PrivateOrLoopback(mappedDotted.slice(1).join("."));
  }
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = [
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    ].join(".");
    return isIpv4PrivateOrLoopback(dotted);
  }
  return false;
}

function isLocalHostname(hostname) {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local");
}

/** True if `hostname` (a literal IP, IPv6 literal, or hostname like
 * `localhost`/`*.local`) must never be connected to — the single source of
 * truth for "is this a loopback/private/link-local target", reused by
 * `assertFetchable` (undici tiers 1/3), `makeGuardedDnsLookup` (the
 * connect-time re-check), and the tier-2 SSRF-safe proxy below so there is
 * exactly one place that knows the IP-range rules.
 * @param {string} hostname
 * @returns {boolean} */
export function isForbiddenHost(hostname) {
  return (
    isLocalHostname(hostname) ||
    isIpv4PrivateOrLoopback(hostname) ||
    isIpv6PrivateOrLoopback(hostname)
  );
}

/** Throws if `hostname` is forbidden outright, or (for non-literal-IP
 * hostnames) resolves to a forbidden address. This is the resolve-then-check
 * half of the guard, factored out so both `assertFetchable` and the tier-2
 * proxy's CONNECT/request handlers run the identical check instead of two
 * copies drifting apart.
 * @param {string} hostname
 * @returns {Promise<void>} */
export async function assertHostAllowed(hostname) {
  if (isForbiddenHost(hostname)) {
    throw new Error(`refusing local/private address: ${hostname}`);
  }
  // Literal-IP hosts are already covered by isForbiddenHost above; only
  // resolve DNS for hostnames, so we also catch DNS pointing a public-looking
  // name at an internal address.
  const looksLikeLiteralIp =
    /^[\d.]+$/.test(hostname) || hostname.includes(":");
  if (looksLikeLiteralIp) return;
  try {
    const { address } = await lookup(hostname);
    if (isForbiddenHost(address)) {
      throw new Error(
        `refusing hostname that resolves to a private address: ${hostname}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("refusing")) throw err;
    // DNS lookup failure (ENOTFOUND etc) — let the actual request surface
    // that error naturally rather than masking it as an SSRF refusal.
  }
}

/** Throws if `url` is not safe to fetch (wrong scheme, or resolves to a
 * localhost/private address). Exported so other tiers (Chrome, Wayback) can
 * reuse the same guard on redirect targets / rewritten URLs.
 * @param {string} url
 * @param {{allowPrivateHosts?: Set<string>}} [opts] `allowPrivateHosts` is a
 *   test-only escape hatch (never set by any real call site): an explicit,
 *   per-call set of exact `"hostname:port"` strings allowed to bypass the
 *   private-address check, so test/fetch.test.js can point tier1 at its own
 *   `127.0.0.1` server without weakening the guard for everything else —
 *   there is no env var / ambient global toggle, so nothing outside a test
 *   that deliberately constructs and passes this set can loosen the guard.
 * @returns {Promise<URL>} the parsed URL, for convenience */
export async function assertFetchable(url, opts = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a fetchable URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`refusing non-http(s) URL: ${url}`);
  }
  const allowPrivateHosts = opts.allowPrivateHosts;
  const hostPort = `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  const isAllowlisted =
    allowPrivateHosts instanceof Set && allowPrivateHosts.has(hostPort);
  if (isAllowlisted) return parsed;
  await assertHostAllowed(parsed.hostname);
  return parsed;
}

// ---- DNS-rebind TOCTOU mitigation --------------------------------------
//
// `assertFetchable` resolves the hostname once, up front, to catch a
// public-looking DNS name that points at a private address. That is a
// classic TOCTOU: undici resolves the hostname AGAIN, independently, when it
// actually opens the connection, so a DNS-rebinding attacker who controls
// the name's records can serve a public IP for our check and then a private
// one (with a very short TTL) by the time the real connection happens
// (and, since our nameserver's cache/answer could differ per-query for
// other reasons too, this isn't even exotic-attacker-only). We do not
// pretend to have closed this window completely — a sufficiently
// adversarial resolver/network path is out of scope here — but we do close
// almost all of it: `ssrfSafeDispatcher` below installs a custom `lookup`
// on the undici Agent actually used to connect, so the SAME resolution that
// opens the TCP socket is re-validated against the private/loopback guard
// at connect time, rather than trusting the separate, earlier lookup in
// `assertFetchable`. That collapses the gap from "time between our check
// and undici's own later, unrelated lookup" down to "undici's own connect
// path", which is as tight as we can get without vendoring our own raw
// socket layer.
function makeGuardedDnsLookup(allowHostnames) {
  return function guardedDnsLookup(hostname, options, callback) {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (allowHostnames instanceof Set && allowHostnames.has(hostname)) {
        callback(null, address, family);
        return;
      }
      const addresses = Array.isArray(address)
        ? address
        : [{ address, family }];
      const bad = addresses.find((a) => isForbiddenHost(a.address));
      if (bad) {
        callback(
          new Error(
            `refusing hostname that resolves to a private address: ${hostname}`,
          ),
        );
        return;
      }
      callback(null, address, family);
    });
  };
}

const ssrfSafeDispatcher = new Agent({
  connect: { lookup: makeGuardedDnsLookup() },
});

// Only built when a call site explicitly passes the test-only
// `allowPrivateHosts` escape hatch (see assertFetchable's JSDoc) — normal
// production calls always reuse the single `ssrfSafeDispatcher` above.
function dispatcherFor(opts) {
  if (
    !(opts.allowPrivateHosts instanceof Set) ||
    opts.allowPrivateHosts.size === 0
  ) {
    return ssrfSafeDispatcher;
  }
  const allowHostnames = new Set(
    [...opts.allowPrivateHosts].map((hostPort) => hostPort.split(":")[0]),
  );
  return new Agent({
    connect: { lookup: makeGuardedDnsLookup(allowHostnames) },
  });
}

// ---- Bot-challenge detection -------------------------------------------

const CHALLENGE_MARKERS = [
  "cf-browser-verification",
  "cf-chl",
  "just a moment",
  "attention required! | cloudflare",
  "checking your browser before accessing",
  "perimeterx",
  "captcha-delivery.com",
  "access denied",
  "sorry, you have been blocked",
];

function looksLikeChallenge(status, html) {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!html) return false;
  const head = html.slice(0, 4000).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

// ---- Tier 1: plain HTTPS GET --------------------------------------------

/** Read a response body up to `maxBytes`, rejecting (not silently
 * truncating) if it's exceeded — a truncated article would silently corrupt
 * extraction, so we'd rather fail loudly and let a later tier try.
 * @param {import('undici').Dispatcher.ResponseData} response
 * @param {number} maxBytes
 * @returns {Promise<string>} */
async function readBodyCapped(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      // Same rationale as the redirect path above: swallow the async
      // 'error' destroy() emits so it can't surface as an uncaught
      // exception after we've already thrown our own, more useful error.
      response.body.on("error", () => {});
      response.body.destroy();
      throw new Error(`response body exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Plain HTTPS GET with realistic desktop headers and manual redirect
 * handling (each hop is re-validated by the SSRF guard, and capped at
 * `maxRedirects`).
 * @param {string} url
 * @param {{timeoutMs?:number, userAgent?:string, maxRedirects?:number, maxBytes?:number, allowPrivateHosts?:Set<string>}} [opts]
 *   `allowPrivateHosts` is test-only — see assertFetchable's JSDoc.
 * @returns {Promise<{html:string, finalUrl:string, status:number}>} */
export async function fetchTier1(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let current = await assertFetchable(url, opts);
  for (let redirectCount = 0; ; redirectCount++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await request(current.toString(), {
        method: "GET",
        dispatcher: dispatcherFor(opts),
        maxRedirections: 0, // we handle redirects ourselves so each hop gets the SSRF guard
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.location;
    const locationHeader = Array.isArray(location) ? location[0] : location;
    if (
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      locationHeader
    ) {
      // We're intentionally discarding this body (a redirect response) —
      // attach a no-op error listener before destroying it, since
      // `destroy()` on an undici response body emits an async 'error'
      // (AbortError: "Request aborted") that otherwise has no listener and
      // surfaces as an uncaught exception well after this function has
      // already moved on to the next hop.
      response.body.on("error", () => {});
      response.body.destroy();
      if (redirectCount >= maxRedirects) {
        throw new Error(
          `too many redirects (>${maxRedirects}) fetching ${url}`,
        );
      }
      const next = new URL(locationHeader, current);
      current = await assertFetchable(next.toString(), opts);
      continue;
    }

    const html = await readBodyCapped(response, maxBytes);
    if (response.statusCode >= 400) {
      throw new Error(
        `HTTP ${response.statusCode} fetching ${current.toString()}`,
      );
    }
    return { html, finalUrl: current.toString(), status: response.statusCode };
  }
}

/**
 * SSRF-guarded binary fetch, reusing the same private/loopback/link-local
 * guard, DNS-pinned dispatcher, and per-hop redirect revalidation as
 * `fetchTier1`. Used to embed remote `<img>` assets into EPUBs safely.
 * Returns null on any error/timeout/over-cap (caller drops the asset).
 * @param {string} url
 * @param {{maxBytes?:number, timeoutMs?:number, userAgent?:string, maxRedirects?:number, allowPrivateHosts?:Set<string>}} [opts]
 * @returns {Promise<{bytes:Buffer, contentType:string}|null>}
 */
export async function fetchBytesSafe(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  try {
    let current = await assertFetchable(url, opts);
    for (let redirectCount = 0; ; redirectCount++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await request(current.toString(), {
          method: "GET",
          dispatcher: dispatcherFor(opts),
          maxRedirections: 0, // manual, so every hop is SSRF-revalidated
          signal: controller.signal,
          headers: { "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT },
        });
      } finally {
        clearTimeout(timer);
      }
      const location = response.headers.location;
      const locationHeader = Array.isArray(location) ? location[0] : location;
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        locationHeader
      ) {
        response.body.on("error", () => {});
        response.body.destroy();
        if (redirectCount >= maxRedirects) return null;
        current = await assertFetchable(
          new URL(locationHeader, current).toString(),
          opts,
        );
        continue;
      }
      if (response.statusCode >= 400) {
        response.body.on("error", () => {});
        response.body.destroy();
        return null;
      }
      const contentType = String(response.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) {
          response.body.destroy();
          return null;
        }
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), contentType };
    }
  } catch {
    return null; // SSRF rejection, network error, timeout, bad host — drop it
  }
}

// ---- Tier 2: headless Chrome (DevTools Protocol via --dump-dom) ---------

/** Locate the user's installed Chrome. Never bundles/downloads a browser —
 * if it's not at the expected path (or `KINDLING_CHROME_PATH`/`opts.chromePath`
 * override), tier 2 is skipped entirely.
 * @param {{chromePath?:string}} [opts]
 * @returns {string|null} */
export function findChromeBinary(opts = {}) {
  const candidate =
    opts.chromePath ?? process.env.KINDLING_CHROME_PATH ?? DEFAULT_CHROME_PATH;
  return existsSync(candidate) ? candidate : null;
}

// ---- Tier-2 SSRF-safe forward proxy -------------------------------------
//
// Tier 1/3 SSRF is closed by `assertFetchable` + `ssrfSafeDispatcher`
// (undici's connect-time DNS re-check) — but both only guard requests undici
// itself makes. Tier 2 hands a URL to a REAL Chrome process and lets it do
// its own navigation: an HTTP redirect, a JS `location.href = …`, a
// `fetch()` inside the page, or a `<meta refresh>` all happen entirely
// inside Chrome, using Chrome's own DNS resolution — none of which our
// Node-side guard ever sees. `assertFetchable(url)` below only validates the
// URL we HAND to Chrome; it can't validate where Chrome goes next.
//
// The fix: force ALL of Chrome's traffic (initial navigation, every
// redirect hop, every JS-initiated request) through a local proxy we start
// fresh for this one invocation and tear down afterward. The proxy is the
// single choke point that sees every host Chrome ever tries to reach, so it
// re-runs the exact same `assertHostAllowed` check `assertFetchable` uses —
// on the literal host AND (for hostnames) the resolved address, closing the
// DNS-rebind gap for tier 2 the same way `ssrfSafeDispatcher` does for
// tiers 1/3 — and refuses (403 for plain HTTP, connection close for
// CONNECT) anything that resolves to loopback/private/link-local.
//
// `--proxy-bypass-list=<-loopback>` is required alongside `--proxy-server`:
// Chrome has a hardcoded implicit rule that sends requests to
// localhost/127.0.0.1/[::1] DIRECT, bypassing any configured proxy — which
// would otherwise let exactly the loopback SSRF target we're guarding
// against sail past the proxy entirely. `<-loopback>` removes that implicit
// rule so loopback targets are proxied (and therefore checked) too.

/** Proxy `CONNECT host:port` (used for HTTPS tunnels): validate the target,
 * then either refuse or splice a raw TCP tunnel to it.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} clientSocket
 * @param {Buffer} head
 * @returns {Promise<void>} */
async function handleConnect(req, clientSocket, head) {
  clientSocket.on("error", () => {}); // client may hang up mid-tunnel; not our failure
  let hostname, port;
  try {
    const target = new URL(`http://${req.url}`);
    hostname = target.hostname;
    port = Number(target.port) || 443;
  } catch {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  try {
    await assertHostAllowed(hostname);
  } catch {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  const serverSocket = net.connect(port, hostname, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on("error", () => {
    try {
      clientSocket.end();
    } catch {
      /* already closed */
    }
  });
}

/** Proxy a plain HTTP request (Chrome sends these for `http://` navigations
 * with an absolute-URI request line, per the proxy protocol — `https://` is
 * always tunneled via CONNECT above and never reaches this handler, so this
 * only needs to speak plaintext HTTP onward).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>} */
async function handleProxyHttpRequest(req, res) {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end("Bad Request");
    return;
  }

  try {
    await assertHostAllowed(target.hostname);
  } catch {
    res.writeHead(403).end("Forbidden");
    return;
  }

  const proxyReq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    try {
      res.writeHead(502).end("Bad Gateway");
    } catch {
      /* headers already sent */
    }
  });
  req.pipe(proxyReq);
}

/** Start a local, loopback-bound forward proxy that validates every target
 * (CONNECT tunnels and plain HTTP requests alike) through the same SSRF
 * guard as the rest of the fetch layer, before forwarding. Callers must
 * `close()` it when done — see `fetchTier2Chrome`'s `finally`.
 * @returns {Promise<{port:number, close: () => Promise<void>}>} */
export function startSsrfSafeProxy() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleProxyHttpRequest(req, res).catch(() => {
        try {
          res.writeHead(502).end();
        } catch {
          /* headers already sent */
        }
      });
    });
    server.on("connect", (req, clientSocket, head) => {
      handleConnect(req, clientSocket, head).catch(() => {
        try {
          clientSocket.destroy();
        } catch {
          /* already closed */
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = /** @type {import('node:net').AddressInfo} */ (
        server.address()
      );
      resolve({
        port: address.port,
        close: () =>
          new Promise((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

/** Render `url` in the user's already-installed headless Chrome and capture
 * the post-JS DOM. Returns `null` (not a throw) when Chrome isn't installed,
 * so callers can gracefully skip this tier. Kills the child process on
 * timeout so a hung page never leaks a process.
 * @param {string} url
 * @param {{timeoutMs?:number, chromePath?:string, maxBytes?:number}} [opts]
 * @returns {Promise<{html:string, finalUrl:string}|null>} */
export async function fetchTier2Chrome(url, opts = {}) {
  // Re-validated here (not just trusted from the caller): must be a real
  // http(s) URL. This also means a string like "--evil-flag" can never reach
  // spawn() below as the URL argument — `new URL()` inside assertFetchable
  // rejects anything without a valid http(s) origin before we ever build the
  // argv array, so there's nothing for Chrome to misparse as an option. This
  // only validates the STARTING url, though — see the proxy comment above
  // for how everything Chrome does after that (redirects, JS navigation) is
  // covered too.
  const parsed = await assertFetchable(url);
  const chromePath = findChromeBinary(opts);
  if (!chromePath) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // Ephemeral, per-invocation --user-data-dir. Without this, headless Chrome
  // either (a) defaults to the user's real profile directory — reading their
  // actual cookies/history/logins into a fetch we do purely to render a
  // public page, a privacy violation — or (b) collides with a
  // ALREADY-RUNNING Chrome's singleton lock on that same default profile dir
  // and silently fails/hangs. A fresh temp dir per call sidesteps both.
  const userDataDir = await mkdtemp(path.join(tmpdir(), "kindling-chrome-"));
  const proxy = await startSsrfSafeProxy();

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        chromePath,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--disable-extensions",
          `--user-data-dir=${userDataDir}`,
          "--virtual-time-budget=6000",
          `--proxy-server=http://127.0.0.1:${proxy.port}`,
          "--proxy-bypass-list=<-loopback>",
          "--dump-dom",
          parsed.toString(),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let settled = false;
      let timedOut = false;
      let overCap = false;

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBytes) {
          overCap = true;
          child.kill("SIGKILL");
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

      child.on("error", (err) => {
        finish(() =>
          reject(new Error(`failed to launch Chrome: ${err.message}`)),
        );
      });

      child.on("close", (code) => {
        finish(() => {
          if (overCap) {
            reject(
              new Error(
                `headless Chrome output exceeded ${maxBytes} bytes rendering ${url}`,
              ),
            );
            return;
          }
          if (timedOut) {
            reject(
              new Error(
                `headless Chrome timed out after ${timeoutMs}ms rendering ${url}`,
              ),
            );
            return;
          }
          const html = Buffer.concat(stdoutChunks).toString("utf-8");
          if (code !== 0 || !html.trim()) {
            const stderr = Buffer.concat(stderrChunks)
              .toString("utf-8")
              .slice(0, 500);
            reject(
              new Error(
                `headless Chrome exited ${code} rendering ${url}${stderr ? `: ${stderr}` : ""}`,
              ),
            );
            return;
          }
          // --dump-dom doesn't report the post-redirect URL, so we report the
          // requested URL; relative links in the captured DOM are still
          // resolved against it correctly since Chrome already resolved them
          // at render time.
          resolve({ html, finalUrl: url });
        });
      });
    });
  } finally {
    // Both cleanups must run even if Chrome timed out / was SIGKILLed / threw
    // on launch — leaked ephemeral profile dirs and leaked proxy sockets are
    // exactly the same class of bug, so both live in this one finally.
    await Promise.allSettled([
      rm(userDataDir, { recursive: true, force: true }),
      proxy.close(),
    ]);
  }
}

// ---- Tier 3: Wayback Machine closest snapshot ---------------------------

/** Fetch the closest archived snapshot from the Wayback Machine. `/web/2/`
 * is the Wayback "closest capture" redirect form: it 302s to the actual
 * snapshot, which tier 1 follows normally.
 * @param {string} url
 * @param {{timeoutMs?:number, userAgent?:string}} [opts]
 * @returns {Promise<{html:string, finalUrl:string}|null>} */
export async function fetchTier3Wayback(url, opts = {}) {
  const snapshotUrl = `http://web.archive.org/web/2/${url}`;
  try {
    const { html, finalUrl } = await fetchTier1(snapshotUrl, opts);
    return { html, finalUrl };
  } catch {
    return null;
  }
}

// ---- Combined tiered fetch -----------------------------------------------

/** Fetch a page, escalating tiers on HTTP-level failure (error status or a
 * detected bot challenge). Does NOT know about downstream extraction
 * quality — see the module comment for why that escalation lives in
 * `src/extract/index.js` instead.
 * @param {string} url
 * @param {{timeoutMs?:number, userAgent?:string, maxRedirects?:number, maxBytes?:number, chromePath?:string}} [opts]
 * @returns {Promise<{html:string, tier:'tier1'|'tier2'|'tier3', finalUrl:string}>} */
export async function fetchPage(url, opts = {}) {
  let tier1Error;
  try {
    const result = await fetchTier1(url, opts);
    if (!looksLikeChallenge(result.status, result.html)) {
      return { html: result.html, tier: "tier1", finalUrl: result.finalUrl };
    }
    tier1Error = new Error(
      `tier 1 response looks like a bot challenge for ${url}`,
    );
  } catch (err) {
    tier1Error = err;
  }

  const tier2 = await fetchTier2Chrome(url, opts).catch(() => null);
  if (tier2) {
    return { html: tier2.html, tier: "tier2", finalUrl: tier2.finalUrl };
  }

  const tier3 = await fetchTier3Wayback(url, opts);
  if (tier3) {
    return { html: tier3.html, tier: "tier3", finalUrl: tier3.finalUrl };
  }

  throw tier1Error ?? new Error(`all fetch tiers failed for ${url}`);
}
