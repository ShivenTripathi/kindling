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
    assert.equal(
      new TextDecoder().decode(zip["mimetype"]),
      "application/epub+zip",
    );

    // Ledger recorded the send.
    const ledger = ports.store["ledger"];
    assert.equal(ledger.digests.length, 1);
    assert.equal(ledger.digests[0].articles, 2);
  });

  test("excluded and unextractable urls are reported, not sent", async () => {
    const ports = makePorts({
      articleFor: (url) =>
        url.includes("thin")
          ? { status: "skipped", reason: "too short" }
          : fakeArticle(url),
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

describe("runDigest — hardening regressions", () => {
  test("a mid-run send failure persists the already-sent group (no duplicate re-send)", async () => {
    const ports = makePorts();
    // Two ~13MB articles → two separate digest groups (24MB cap). Repeated-char
    // HTML compresses instantly so this stays fast despite the size.
    const big = (u) => ({
      status: "ok",
      article: {
        url: u,
        title: "Big " + u,
        contentHtml: "<p>" + "x".repeat(13_000_000) + "</p>",
        textContent: "x",
        wordCount: 5,
      },
    });
    ports.content.getArticle = async (u) => big(u);
    let sendCalls = 0;
    ports.sender.send = async (mail) => {
      sendCalls += 1;
      if (sendCalls === 2) throw new Error("network blip");
      return { id: "ok" };
    };
    const report = await runDigest({
      urls: ["https://example.com/a", "https://example.com/b"],
      ports,
      config: CONFIG,
    });
    assert.equal(sendCalls, 2, "attempted both groups");
    assert.equal(report.sent.length, 1, "only the first group counts as sent");
    assert.ok(report.failed.length >= 1, "the failed group is reported");
    // The successfully-sent url must be persisted with sentAt so it is NOT
    // re-selected/re-sent next time.
    const ledger = ports.store["ledger"];
    const sentUrl = report.sent[0];
    assert.ok(ledger.tabs[sentUrl].sentAt, "sent group's sentAt is persisted");
  });

  test("a hung LLM summarize() does not block the send (bounded by timeout)", async () => {
    const ports = makePorts();
    ports.llm = { summarize: () => new Promise(() => {}) }; // never resolves
    const started = Date.now();
    const report = await runDigest({
      urls: ["https://example.com/a"],
      ports,
      config: { ...CONFIG, summaryTimeoutMs: 50 },
    });
    assert.equal(
      report.sent.length,
      1,
      "the digest still sends despite the hung LLM",
    );
    assert.ok(Date.now() - started < 5000, "did not hang");
  });

  test("dedupe-dropped duplicate urls are reported, not silently dropped", async () => {
    const ports = makePorts();
    const report = await runDigest({
      // same normalized url, different tracking param → one is a duplicate
      urls: ["https://example.com/x?utm_source=a", "https://example.com/x"],
      ports,
      config: CONFIG,
    });
    assert.ok(
      report.skipped.some((s) => /duplicate/i.test(s.reason)),
      "the duplicate is surfaced in report.skipped",
    );
  });
});
