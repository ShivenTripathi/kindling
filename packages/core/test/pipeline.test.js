// Integration test for the shared runDigest orchestrator, driven entirely
// through fake ports (no network, no fs, no chrome.*). Proves the one pipeline
// both the extension and CLI call: reconcile → select → screen → extract →
// build EPUB → send → record.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { JSDOM } from "jsdom";

import { runDigest } from "../src/index.js";

// buildEpub uses the DOMParser/XMLSerializer globals when present (browser);
// here we supply jsdom's, exactly like a Node adapter would.
const { window } = new JSDOM("");
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;

function fakeArticle(url, words = 400) {
  return {
    status: "ok",
    article: {
      url,
      title: `Article for ${url}`,
      contentHtml: `<p>${"word ".repeat(words)}</p>`,
      textContent: "word ".repeat(words),
      wordCount: words,
      engine: "fake",
      score: 100,
    },
  };
}

function makePorts({ articleFor, now } = {}) {
  const store = {};
  const sent = [];
  return {
    sent,
    store,
    content: {
      async getArticle(url) {
        return articleFor ? articleFor(url) : fakeArticle(url);
      },
    },
    sender: {
      async send(mail) {
        sent.push(mail);
        return { id: `msg-${sent.length}` };
      },
    },
    storage: {
      async get(k) {
        return store[k];
      },
      async set(k, v) {
        store[k] = v;
      },
      async remove(k) {
        delete store[k];
      },
    },
    clock: { now: () => now ?? new Date("2026-07-12T12:00:00.000Z") },
  };
}

const CONFIG = {
  kindleEmail: "reader@kindle.com",
  senderEmail: "me@gmail.com",
  title: "Tab Digest",
};

describe("runDigest — explicit urls (send now)", () => {
  test("builds an EPUB, sends it, and records the digest", async () => {
    const ports = makePorts();
    const report = await runDigest({
      urls: ["https://example.com/a", "https://example.com/b"],
      ports,
      config: CONFIG,
    });

    assert.equal(report.sent.length, 2);
    assert.equal(report.failed.length, 0);
    assert.equal(report.digests.length, 1);
    assert.equal(ports.sent.length, 1, "exactly one email sent");

    const mail = ports.sent[0];
    assert.equal(mail.to, "reader@kindle.com");
    assert.equal(mail.from, "me@gmail.com");
    assert.match(mail.attachmentName, /\.epub$/);
    // The attachment is a real EPUB (mimetype first + stored).
    const zip = unzipSync(mail.attachment);
    assert.ok("mimetype" in zip);
    assert.equal(new TextDecoder().decode(zip["mimetype"]), "application/epub+zip");

    // Ledger recorded the send.
    const ledger = ports.store["ledger"];
    assert.equal(ledger.digests.length, 1);
    assert.equal(ledger.digests[0].articles, 2);
  });

  test("excluded and unextractable urls are reported, not sent", async () => {
    const ports = makePorts({
      articleFor: (url) =>
        url.includes("thin") ? { status: "skipped", reason: "too short" } : fakeArticle(url),
    });
    const report = await runDigest({
      urls: [
        "https://mail.google.com/inbox", // excluded by the shipped list
        "https://example.com/thin", // extraction skipped
        "https://example.com/good",
      ],
      ports,
      config: CONFIG,
    });

    assert.deepEqual(report.sent, ["https://example.com/good"]);
    assert.ok(report.skipped.some((s) => s.url.includes("mail.google.com")));
    assert.ok(report.failed.some((f) => f.url.includes("thin")));
  });
});

describe("runDigest — scheduled path (staleness gate)", () => {
  test("sends nothing on a fresh ledger (48h clock just started)", async () => {
    const ports = makePorts();
    const report = await runDigest({
      openTabs: [{ url: "https://example.com/a", title: "A" }],
      ports,
      config: { ...CONFIG, staleHours: 48 },
    });
    assert.equal(report.sent.length, 0);
    assert.equal(ports.sent.length, 0);
    // But the tab is now tracked for next time.
    assert.ok(ports.store["ledger"].tabs["https://example.com/a"]);
  });

  test("sends a tab once it has been open >= 48h", async () => {
    const ports = makePorts();
    // First snapshot 3 days ago.
    await runDigest({
      openTabs: [{ url: "https://example.com/a", title: "A" }],
      ports,
      config: { ...CONFIG, staleHours: 48 },
      // override clock for the first pass
    });
    // Backdate firstSeen to 3 days before "now".
    ports.store["ledger"].tabs["https://example.com/a"].firstSeen =
      "2026-07-09T12:00:00.000Z";

    const report = await runDigest({
      openTabs: [{ url: "https://example.com/a", title: "A" }],
      ports,
      config: { ...CONFIG, staleHours: 48 },
    });
    assert.deepEqual(report.sent, ["https://example.com/a"]);
    assert.equal(ports.sent.length, 1);
  });
});
