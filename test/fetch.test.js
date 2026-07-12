// fetch.test.js
//
// Direct tests of the fetch layer's SSRF guard, redirect re-validation, and
// response-size cap — this is "the real risk" per docs/interfaces.md's
// Phase-0 bake-off notes, yet had no dedicated test file before this one.
//
// The pure SSRF-rejection assertions target `assertFetchable` directly with
// crafted URLs (localhost, private IPv4, IPv6 loopback/link-local,
// IPv4-mapped IPv6, non-http(s) schemes).
//
// The redirect-revalidation and maxBytes tests need a REAL server, and a
// local `node:http` server bound to 127.0.0.1 is itself a private address —
// exactly what the guard exists to reject. So those tests use the
// `allowPrivateHosts` parameter (see fetch.js's `assertFetchable` JSDoc): an
// explicit, per-call, test-only allowlist of exact `"hostname:port"`
// strings. It is never set by any production call site, has no env-var or
// global-state form, and each test constructs it fresh scoped to its own
// server's port — so it can't accidentally widen the guard for anything
// else, while still letting us prove the guard's actual mechanics (each
// redirect hop re-validated, oversized bodies rejected) against a server we
// control instead of the public internet.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import {
  assertFetchable,
  fetchTier1,
  isForbiddenHost,
  assertHostAllowed,
  startSsrfSafeProxy,
} from "../src/extract/fetch.js";

// ---- assertFetchable: accepts / rejects -----------------------------------

test("assertFetchable accepts a normal public https URL", async () => {
  const parsed = await assertFetchable("https://example.com/articles/one");
  assert.equal(parsed.hostname, "example.com");
});

test("assertFetchable accepts a normal public http URL (not just https)", async () => {
  const parsed = await assertFetchable("http://example.com/");
  assert.equal(parsed.protocol, "http:");
});

test("assertFetchable rejects localhost", async () => {
  await assert.rejects(
    () => assertFetchable("http://localhost/"),
    /local|private/i,
  );
});

test("assertFetchable rejects 127.0.0.1", async () => {
  await assert.rejects(
    () => assertFetchable("http://127.0.0.1/"),
    /local|private/i,
  );
});

test("assertFetchable rejects 0.0.0.0", async () => {
  await assert.rejects(
    () => assertFetchable("http://0.0.0.0/"),
    /local|private/i,
  );
});

test("assertFetchable rejects a 10.x private address", async () => {
  await assert.rejects(
    () => assertFetchable("http://10.1.2.3/"),
    /local|private/i,
  );
});

test("assertFetchable rejects a 172.16-31.x private address", async () => {
  await assert.rejects(
    () => assertFetchable("http://172.20.0.5/"),
    /local|private/i,
  );
});

test("assertFetchable rejects a 192.168.x private address", async () => {
  await assert.rejects(
    () => assertFetchable("http://192.168.1.1/"),
    /local|private/i,
  );
});

test("assertFetchable rejects the cloud metadata address 169.254.169.254", async () => {
  await assert.rejects(
    () => assertFetchable("http://169.254.169.254/latest/meta-data/"),
    /local|private/i,
  );
});

test("assertFetchable rejects bracketed IPv6 loopback [::1]", async () => {
  await assert.rejects(
    () => assertFetchable("http://[::1]/"),
    /local|private/i,
  );
});

test("assertFetchable rejects IPv6 link-local [fe80::1]", async () => {
  await assert.rejects(
    () => assertFetchable("http://[fe80::1]/"),
    /local|private/i,
  );
});

test("assertFetchable rejects IPv4-mapped-IPv6 loopback [::ffff:127.0.0.1]", async () => {
  await assert.rejects(
    () => assertFetchable("http://[::ffff:127.0.0.1]/"),
    /local|private/i,
  );
});

// The confirmed SSRF bypass from the security review: `[::ffff:169.254.169.254]`
// normalizes to the hex form `::ffff:a9fe:a9fe` by the time the hostname
// check sees it — the fix must decode that hex form back to the embedded
// IPv4 (169.254.169.254) to catch it.
test("assertFetchable rejects the IPv4-mapped-IPv6 SSRF bypass [::ffff:169.254.169.254]", async () => {
  await assert.rejects(
    () => assertFetchable("http://[::ffff:169.254.169.254]/latest/meta-data/"),
    /local|private/i,
  );
});

test("assertFetchable rejects IPv4-mapped-IPv6 given directly in hex form", async () => {
  // ::ffff:a9fe:a9fe is 169.254.169.254 in the hex-pair form Node/the URL
  // parser normalizes the dotted form to.
  await assert.rejects(
    () => assertFetchable("http://[::ffff:a9fe:a9fe]/"),
    /local|private/i,
  );
});

test("assertFetchable rejects file: scheme", async () => {
  await assert.rejects(
    () => assertFetchable("file:///etc/passwd"),
    /non-http/i,
  );
});

test("assertFetchable rejects ftp: scheme", async () => {
  await assert.rejects(
    () => assertFetchable("ftp://example.com/"),
    /non-http/i,
  );
});

// ---- test server helper -----------------------------------------------

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ---- Redirect re-validation: each hop is independently checked -----------

test("fetchTier1 follows a redirect when the target is allowlisted too", async () => {
  const target = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>final content</body></html>");
  });
  const origin = await startServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.port}/` });
    res.end();
  });

  try {
    const allowPrivateHosts = new Set([
      `127.0.0.1:${origin.port}`,
      `127.0.0.1:${target.port}`,
    ]);
    const result = await fetchTier1(`http://127.0.0.1:${origin.port}/`, {
      allowPrivateHosts,
    });
    assert.match(result.html, /final content/);
    assert.equal(result.finalUrl, `http://127.0.0.1:${target.port}/`);
  } finally {
    await origin.close();
    await target.close();
  }
});

test("fetchTier1 rejects a redirect whose target is NOT allowlisted, even when the origin is", async () => {
  // This is the crux of "each hop is re-checked": the origin is explicitly
  // allowed (so the request itself gets underway), but the redirect target
  // is a real private/loopback address that was never allowlisted — proving
  // the guard runs again on the Location header, not just once up front.
  const origin = await startServer((req, res) => {
    res.writeHead(302, {
      location: "http://169.254.169.254/latest/meta-data/",
    });
    res.end();
  });

  try {
    const allowPrivateHosts = new Set([`127.0.0.1:${origin.port}`]);
    await assert.rejects(
      () =>
        fetchTier1(`http://127.0.0.1:${origin.port}/`, { allowPrivateHosts }),
      /local|private/i,
    );
  } finally {
    await origin.close();
  }
});

test("fetchTier1 rejects a plain (non-allowlisted) private-address URL outright", async () => {
  const { port, close } = await startServer((req, res) => {
    res.writeHead(200);
    res.end("should never be reached");
  });
  try {
    await assert.rejects(
      () => fetchTier1(`http://127.0.0.1:${port}/`),
      /local|private/i,
    );
  } finally {
    await close();
  }
});

// fetchPage() escalates past a tier-1 rejection to tier 2 (headless Chrome,
// skipped when unavailable) and then tier 3 (a REAL network call to the
// Wayback Machine) — so we don't assert on fetchPage here for the
// non-allowlisted case; that would make this suite's runtime and pass/fail
// depend on outbound network access, which the rest of the suite
// deliberately avoids (see extract.test.js's KINDLING_NET_TEST-gated test).
// fetchTier1's own rejection above is what actually proves the guard.

// ---- maxBytes cap ----------------------------------------------------------

test("fetchTier1 rejects (does not silently truncate) a response body over maxBytes", async () => {
  const CHUNK = Buffer.alloc(4096, "x");
  const { port, close } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    // Stream well past the small, test-only cap below.
    let sent = 0;
    const interval = setInterval(() => {
      sent += CHUNK.length;
      res.write(CHUNK);
      if (sent > 200_000) {
        clearInterval(interval);
        res.end();
      }
    }, 1);
    res.on("close", () => clearInterval(interval));
  });

  try {
    const allowPrivateHosts = new Set([`127.0.0.1:${port}`]);
    await assert.rejects(
      () =>
        fetchTier1(`http://127.0.0.1:${port}/`, {
          allowPrivateHosts,
          maxBytes: 10_000,
        }),
      /exceeded/i,
    );
  } finally {
    await close();
  }
});

test("fetchTier1 succeeds for a body comfortably under maxBytes", async () => {
  const { port, close } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>small</body></html>");
  });

  try {
    const allowPrivateHosts = new Set([`127.0.0.1:${port}`]);
    const result = await fetchTier1(`http://127.0.0.1:${port}/`, {
      allowPrivateHosts,
      maxBytes: 10_000,
    });
    assert.match(result.html, /small/);
  } finally {
    await close();
  }
});

// ---- isForbiddenHost / assertHostAllowed: the reusable host-classifier ---
//
// This is the exact logic `assertFetchable` (tiers 1/3) AND the tier-2
// SSRF-safe proxy both delegate to. Testing it directly here proves there is
// one shared classifier — not two copies that could silently drift — and
// gives full coverage of the forbidden-host list without needing a live
// server for each case.

test("isForbiddenHost rejects the full forbidden-host list", () => {
  const forbidden = [
    "localhost",
    "foo.localhost",
    "foo.local",
    "127.0.0.1",
    "127.5.5.5",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata endpoint
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
  ];
  for (const host of forbidden) {
    assert.equal(
      isForbiddenHost(host),
      true,
      `expected ${host} to be forbidden`,
    );
  }
});

test("isForbiddenHost accepts a public host", () => {
  assert.equal(isForbiddenHost("example.com"), false);
  assert.equal(isForbiddenHost("8.8.8.8"), false);
});

test("assertHostAllowed rejects every forbidden host", async () => {
  const forbidden = [
    "localhost",
    "127.0.0.1",
    "169.254.169.254",
    "::1",
    "fe80::1",
  ];
  for (const host of forbidden) {
    await assert.rejects(() => assertHostAllowed(host), /local|private/i);
  }
});

test("assertHostAllowed accepts a normal public hostname", async () => {
  // Should not throw. example.com resolves publicly, so the resolve-then-
  // check half of assertHostAllowed passes it through.
  await assertHostAllowed("example.com");
});

// ---- Tier-2 SSRF-safe proxy: drive it directly with raw sockets ----------
//
// `fetchTier2Chrome` routes headless Chrome's traffic (initial nav,
// redirects, JS navigation — all of which happen outside our Node process)
// through `startSsrfSafeProxy()`. We can't spin up a real Chrome in this
// suite, but the proxy itself is a plain Node http server + CONNECT handler,
// so we drive it exactly the way Chrome would: a raw TCP client sending
// either a proxy-style absolute-URI GET or an HTTPS CONNECT request.

function proxyRequestRaw(proxyPort, requestLine, extraHeaders = "") {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`${requestLine}\r\nHost: proxy\r\n${extraHeaders}\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf-8");
      // We only need the status line for these tests.
      if (data.includes("\r\n")) {
        socket.end();
      }
    });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 3000);
  });
}

test("SSRF-safe proxy refuses a CONNECT tunnel to 127.0.0.1", async () => {
  const proxy = await startSsrfSafeProxy();
  try {
    const response = await proxyRequestRaw(
      proxy.port,
      "CONNECT 127.0.0.1:9999 HTTP/1.1",
    );
    assert.match(response, /403/);
  } finally {
    await proxy.close();
  }
});

test("SSRF-safe proxy refuses a CONNECT tunnel to the cloud metadata address", async () => {
  const proxy = await startSsrfSafeProxy();
  try {
    const response = await proxyRequestRaw(
      proxy.port,
      "CONNECT 169.254.169.254:443 HTTP/1.1",
    );
    assert.match(response, /403/);
  } finally {
    await proxy.close();
  }
});

test("SSRF-safe proxy refuses a plain GET whose target is a private address", async () => {
  const proxy = await startSsrfSafeProxy();
  try {
    const response = await proxyRequestRaw(
      proxy.port,
      "GET http://192.168.1.1/secret HTTP/1.1",
    );
    assert.match(response, /403/);
  } finally {
    await proxy.close();
  }
});

test("SSRF-safe proxy refuses a CONNECT to a hostname that resolves to loopback", async () => {
  // localhost resolves to 127.0.0.1/::1 — the literal-hostname check catches
  // it before DNS even runs, same as assertHostAllowed.
  const proxy = await startSsrfSafeProxy();
  try {
    const response = await proxyRequestRaw(
      proxy.port,
      "CONNECT localhost:443 HTTP/1.1",
    );
    assert.match(response, /403/);
  } finally {
    await proxy.close();
  }
});

// We deliberately do NOT add a "proxy forwards an allowed target" test that
// hits the real network here — this suite avoids outbound network calls
// (see the fetchPage() note above). `isForbiddenHost`/`assertHostAllowed`
// already prove `example.com`-shaped hosts are classified as allowed; the
// proxy's plain-GET and CONNECT handlers both call that same function
// before doing anything else (see `handleProxyHttpRequest`/`handleConnect`
// in fetch.js), so there is no separate forward-path logic left to test in
// isolation without an upstream server.
