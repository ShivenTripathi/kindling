// Regression tests for the security findings fixed after adversarial review:
// OAuth state validation, Kindle-address CRLF, plist XML-escaping, and
// header/SMTP-command injection in the send path.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateConfig, defaultConfig, saveConfig } from "../src/config.js";
import { renderPlist } from "../src/agent.js";
import { buildMimeMessage } from "../src/gmail/send.js";
import { authorize } from "../src/gmail/oauth.js";
import { recordSnapshot } from "../src/ledger.js";
import { saveLedger } from "../src/ledger.js";
import { sanitizeHtml } from "../src/extract/sanitize.js";
import { isSendableUrl } from "../extension/common.js";

describe("config: Kindle address rejects CRLF (header/SMTP injection)", () => {
  test("a CRLF-bearing kindleEmail is rejected", () => {
    const cfg = {
      ...defaultConfig(),
      kindleEmail: "reader\r\nBcc: attacker@evil.com@kindle.com",
      senderEmail: "me@gmail.com",
    };
    assert.throws(() => validateConfig(cfg), /kindleEmail/);
  });
  test("a normal Kindle address still validates", () => {
    const cfg = {
      ...defaultConfig(),
      kindleEmail: "reader_ABC123@kindle.com",
      senderEmail: "me@gmail.com",
    };
    assert.doesNotThrow(() => validateConfig(cfg));
  });
});

describe("agent: plist XML-escaping", () => {
  test("& and < in a path are escaped, no injected keys", () => {
    const xml = renderPlist({
      nodePath: "/usr/bin/node",
      script: "/Users/O'Brien & Co/kindling/src/cli.js",
      intervalSec: 3600,
      logPath: "/tmp/a<b>&c.log",
    });
    assert.ok(xml.includes("&amp; Co"), "ampersand escaped");
    assert.ok(
      xml.includes("&lt;b&gt;&amp;c.log"),
      "angle brackets & ampersand escaped",
    );
    assert.ok(!/[^&](& )/.test(xml), "no bare ampersands remain");
    // The escaped payload must not have introduced an extra <key> element.
    // The template has exactly 7 keys (Label, ProgramArguments, StartInterval,
    // RunAtLoad, StandardOutPath, StandardErrorPath, ProcessType).
    assert.equal((xml.match(/<key>/g) || []).length, 7);
  });
  test("interval is coerced to an integer", () => {
    const xml = renderPlist({
      nodePath: "n",
      script: "s",
      intervalSec: 3600.9,
      logPath: "l",
    });
    assert.match(xml, /<integer>3600<\/integer>/);
  });
});

describe("send: buildMimeMessage rejects CRLF in from/to/filename", () => {
  const base = {
    from: "a@b.com",
    to: "x@kindle.com",
    subject: "s",
    attachmentBuffer: Buffer.from("x"),
    attachmentName: "d.epub",
  };
  test('CRLF in "to" is rejected', () => {
    assert.throws(
      () =>
        buildMimeMessage({ ...base, to: "x@kindle.com\r\nBcc: e@evil.com" }),
      /control characters/,
    );
  });
  test('CRLF in "from" is rejected', () => {
    assert.throws(
      () => buildMimeMessage({ ...base, from: "a@b.com\r\nX: y" }),
      /control characters/,
    );
  });
  test("CRLF in attachmentName is rejected", () => {
    assert.throws(
      () => buildMimeMessage({ ...base, attachmentName: "d.epub\r\nX: y" }),
      /control characters/,
    );
  });
  test("a clean message builds", () => {
    const mime = buildMimeMessage(base);
    assert.match(mime, /To: x@kindle\.com/);
  });
});

describe("oauth: loopback callback validates state (login-CSRF)", () => {
  test("a callback with the wrong state is rejected without storing a token", async () => {
    const failIfCalled = () => {
      throw new Error("must not be reached on a state mismatch");
    };
    const keychain = {
      setSecret: failIfCalled,
      getSecret: async () => null,
      deleteSecret: async () => {},
    };
    // The "opener" simulates a malicious page hitting the loopback server with
    // its own code and a bogus state instead of Google's real redirect.
    const opener = async (authUrl) => {
      const redirect = new URL(authUrl).searchParams.get("redirect_uri");
      await fetch(
        `${redirect}/?code=attacker_code&state=not-the-real-state`,
      ).catch(() => {});
    };
    let threw = null;
    try {
      await authorize(
        { clientId: "id", clientSecret: "secret" },
        { opener, keychain, fetchImpl: failIfCalled, port: 0 },
      );
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, "authorize must reject on a state mismatch");
    assert.equal(threw.code, "oauth_state_mismatch");
    assert.match(threw.message, /state mismatch/i);
  });
});

describe("send: attachment filename cannot break out of Content-Disposition quotes", () => {
  const base = {
    from: "a@b.com",
    to: "x@kindle.com",
    subject: "s",
    attachmentBuffer: Buffer.from("x"),
  };
  test("a filename with a double-quote is rejected", () => {
    assert.throws(
      () =>
        buildMimeMessage({
          ...base,
          attachmentName: 'evil".epub"; filename="pwned.exe',
        }),
      /attachmentName/,
    );
  });
  test("a normal .epub filename is accepted", () => {
    assert.doesNotThrow(() =>
      buildMimeMessage({ ...base, attachmentName: "2026-07-11-a.epub" }),
    );
  });
});

describe("ledger: prototype-pollution keys are rejected", () => {
  test('a tab url of "__proto__" does not pollute Object.prototype', () => {
    const ledger = { tabs: {}, digests: [] };
    recordSnapshot(
      ledger,
      [{ url: "__proto__", title: "pwned" }],
      new Date("2026-07-01T00:00:00Z"),
    );
    assert.equal({}.title, undefined, "Object.prototype must be untouched");
    assert.ok(!Object.hasOwn(ledger.tabs, "__proto__"));
  });
  test("normal urls are still recorded", () => {
    const ledger = { tabs: {}, digests: [] };
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      new Date("2026-07-01T00:00:00Z"),
    );
    assert.ok(ledger.tabs["https://example.com/a"]);
  });
});

describe("sanitizer: SVG SMIL animation elements are stripped", () => {
  test("<animate> that would rewrite href to javascript: is removed", () => {
    const out = sanitizeHtml(
      '<a href="https://x.com"><svg><animate attributeName="href" values="javascript:alert(1)"/></svg>a</a>',
    );
    assert.ok(!/animate/i.test(out), "<animate> must be stripped");
    assert.ok(!/javascript:/i.test(out));
  });
});

describe("files: config and ledger are written owner-only (0600)", () => {
  test("saveConfig writes mode 0600", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kindling-perm-"));
    const p = path.join(dir, "config.json");
    await saveConfig(
      {
        ...defaultConfig(),
        kindleEmail: "x@kindle.com",
        senderEmail: "me@gmail.com",
      },
      p,
    );
    assert.equal((await stat(p)).mode & 0o777, 0o600);
  });
  test("saveLedger writes mode 0600", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kindling-perm-"));
    const p = path.join(dir, "ledger.json");
    await saveLedger(p, { tabs: {}, digests: [] });
    assert.equal((await stat(p)).mode & 0o777, 0o600);
  });
});

describe("extension: isSendableUrl mirrors the CLI exclusion gate", () => {
  test("sensitive/app domains and local addresses are excluded", () => {
    for (const u of [
      "https://mail.google.com/mail",
      "https://checkout.stripe.com/pay/x",
      "https://chase.com/",
      "https://onlinebanking.foo.com/",
      "http://localhost:8765/",
      "http://169.254.169.254/latest",
      "https://github.com/user/repo",
    ])
      assert.equal(isSendableUrl(u), false, `${u} should be excluded`);
  });
  test("real articles are sendable", () => {
    for (const u of [
      "https://www.biorxiv.org/content/x",
      "https://jvns.ca/blog/post/",
    ])
      assert.equal(isSendableUrl(u), true, `${u} should be sendable`);
  });
});
