import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadLedger,
  saveLedger,
  recordSnapshot,
  selectStale,
  recordDigest,
} from "../src/ledger.js";

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), "kindling-ledger-test-"));
}

describe("loadLedger", () => {
  test("creates an empty ledger if the file is absent", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");
    const ledger = await loadLedger(ledgerPath);
    assert.deepEqual(ledger, { tabs: {}, digests: [] });
  });

  test("tolerates a missing parent directory", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "nested", "deeper", "ledger.json");
    const ledger = await loadLedger(ledgerPath);
    assert.deepEqual(ledger, { tabs: {}, digests: [] });
  });

  test("loads an existing ledger file", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");
    const seed = {
      tabs: {
        "https://example.com/a": {
          title: "A",
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-01-01T00:00:00.000Z",
          sentAt: null,
          digestId: null,
          reopenedAt: [],
          closedByKindling: false,
        },
      },
      digests: [],
    };
    await writeFile(ledgerPath, JSON.stringify(seed, null, 2));
    const ledger = await loadLedger(ledgerPath);
    assert.deepEqual(ledger, seed);
  });
});

describe("recordSnapshot", () => {
  test("sets firstSeen and lastSeen for a new URL", () => {
    const ledger = { tabs: {}, digests: [] };
    const now = new Date("2026-07-01T12:00:00.000Z");
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "Article A" }],
      now,
    );

    const record = ledger.tabs["https://example.com/a"];
    assert.equal(record.firstSeen, "2026-07-01T12:00:00.000Z");
    assert.equal(record.lastSeen, "2026-07-01T12:00:00.000Z");
    assert.equal(record.title, "Article A");
    assert.equal(record.sentAt, null);
    assert.equal(record.digestId, null);
    assert.deepEqual(record.reopenedAt, []);
    assert.equal(record.closedByKindling, false);
  });

  test("updates lastSeen and title but keeps firstSeen on a repeat snapshot", () => {
    const ledger = { tabs: {}, digests: [] };
    const t1 = new Date("2026-07-01T12:00:00.000Z");
    const t2 = new Date("2026-07-02T08:00:00.000Z");

    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "Old Title" }],
      t1,
    );
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "New Title" }],
      t2,
    );

    const record = ledger.tabs["https://example.com/a"];
    assert.equal(record.firstSeen, "2026-07-01T12:00:00.000Z");
    assert.equal(record.lastSeen, "2026-07-02T08:00:00.000Z");
    assert.equal(record.title, "New Title");
  });

  test("keys tabs by normalized URL", () => {
    const ledger = { tabs: {}, digests: [] };
    const now = new Date("2026-07-01T12:00:00.000Z");
    recordSnapshot(
      ledger,
      [{ url: "https://EXAMPLE.com/a/?utm_source=x", title: "A" }],
      now,
    );
    assert.ok(ledger.tabs["https://example.com/a"]);
    assert.equal(Object.keys(ledger.tabs).length, 1);
  });

  test("mutates and returns the same ledger object", () => {
    const ledger = { tabs: {}, digests: [] };
    const result = recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      new Date(),
    );
    assert.equal(result, ledger);
  });

  test("appends to reopenedAt when a sent URL is seen open again", () => {
    const ledger = { tabs: {}, digests: [] };
    const t1 = new Date("2026-07-01T00:00:00.000Z");
    recordSnapshot(ledger, [{ url: "https://example.com/a", title: "A" }], t1);

    recordDigest(
      ledger,
      {
        id: "d1",
        sentAt: "2026-07-03T00:00:00.000Z",
        articles: 1,
        sizeBytes: 100,
        urls: ["https://example.com/a"],
      },
      new Date("2026-07-03T00:00:00.000Z"),
    );
    assert.equal(
      ledger.tabs["https://example.com/a"].sentAt,
      "2026-07-03T00:00:00.000Z",
    );

    const t2 = new Date("2026-07-05T00:00:00.000Z");
    recordSnapshot(ledger, [{ url: "https://example.com/a", title: "A" }], t2);

    const record = ledger.tabs["https://example.com/a"];
    assert.deepEqual(record.reopenedAt, ["2026-07-05T00:00:00.000Z"]);
  });

  test("does not append a duplicate reopenedAt entry for the same snapshot instant", () => {
    const ledger = { tabs: {}, digests: [] };
    const t1 = new Date("2026-07-01T00:00:00.000Z");
    recordSnapshot(ledger, [{ url: "https://example.com/a", title: "A" }], t1);
    recordDigest(
      ledger,
      {
        id: "d1",
        sentAt: "2026-07-01T00:00:00.000Z",
        articles: 1,
        sizeBytes: 100,
        urls: ["https://example.com/a"],
      },
      t1,
    );

    const t2 = new Date("2026-07-05T00:00:00.000Z");
    // Call recordSnapshot twice with the exact same `now` for the same URL —
    // simulating a caller that accidentally re-runs reconciliation for one
    // snapshot instant. The second call must not double-append.
    recordSnapshot(ledger, [{ url: "https://example.com/a", title: "A" }], t2);
    recordSnapshot(ledger, [{ url: "https://example.com/a", title: "A" }], t2);

    assert.deepEqual(ledger.tabs["https://example.com/a"].reopenedAt, [
      "2026-07-05T00:00:00.000Z",
    ]);
  });

  test("does not append to reopenedAt for a URL that has never been sent", () => {
    const ledger = { tabs: {}, digests: [] };
    const t1 = new Date("2026-07-01T00:00:00.000Z");
    const t2 = new Date("2026-07-02T00:00:00.000Z");
    recordSnapshot(ledger, [{ url: "https://example.com/a", title: "A" }], t1);
    recordSnapshot(ledger, [{ url: "https://example.com/a", title: "A" }], t2);
    assert.deepEqual(ledger.tabs["https://example.com/a"].reopenedAt, []);
  });

  test("multiple reopens accumulate across snapshots", () => {
    const ledger = { tabs: {}, digests: [] };
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      new Date("2026-07-01T00:00:00.000Z"),
    );
    recordDigest(
      ledger,
      {
        id: "d1",
        sentAt: "2026-07-01T00:00:00.000Z",
        articles: 1,
        sizeBytes: 1,
        urls: ["https://example.com/a"],
      },
      new Date("2026-07-01T00:00:00.000Z"),
    );
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      new Date("2026-07-02T00:00:00.000Z"),
    );
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      new Date("2026-07-03T00:00:00.000Z"),
    );

    assert.deepEqual(ledger.tabs["https://example.com/a"].reopenedAt, [
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ]);
  });
});

describe("selectStale", () => {
  test("selects URLs at exactly the threshold boundary (>=)", () => {
    const ledger = { tabs: {}, digests: [] };
    const firstSeen = new Date("2026-07-01T00:00:00.000Z");
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      firstSeen,
    );

    // Exactly 48h later
    const now = new Date("2026-07-03T00:00:00.000Z");
    const stale = selectStale(ledger, 48, now);
    assert.deepEqual(stale, ["https://example.com/a"]);
  });

  test("excludes URLs one millisecond before the threshold", () => {
    const ledger = { tabs: {}, digests: [] };
    const firstSeen = new Date("2026-07-01T00:00:00.000Z");
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      firstSeen,
    );

    const now = new Date("2026-07-02T23:59:59.999Z"); // 1ms short of 48h
    const stale = selectStale(ledger, 48, now);
    assert.deepEqual(stale, []);
  });

  test("excludes URLs that already have sentAt set", () => {
    const ledger = { tabs: {}, digests: [] };
    const firstSeen = new Date("2026-07-01T00:00:00.000Z");
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      firstSeen,
    );
    recordDigest(
      ledger,
      {
        id: "d1",
        sentAt: firstSeen.toISOString(),
        articles: 1,
        sizeBytes: 1,
        urls: ["https://example.com/a"],
      },
      firstSeen,
    );

    const now = new Date("2026-07-10T00:00:00.000Z");
    const stale = selectStale(ledger, 48, now);
    assert.deepEqual(stale, []);
  });

  test("returns multiple stale URLs, excludes URLs opened too recently", () => {
    const ledger = { tabs: {}, digests: [] };
    recordSnapshot(
      ledger,
      [
        { url: "https://example.com/old-1", title: "Old 1" },
        { url: "https://example.com/old-2", title: "Old 2" },
      ],
      new Date("2026-07-01T00:00:00.000Z"),
    );
    recordSnapshot(
      ledger,
      [{ url: "https://example.com/brandnew", title: "Brand New" }],
      new Date("2026-07-09T00:00:00.000Z"),
    );

    const now = new Date("2026-07-10T00:00:00.000Z");
    const stale = selectStale(ledger, 48, now);
    assert.deepEqual(
      stale.sort(),
      ["https://example.com/old-1", "https://example.com/old-2"].sort(),
    );
    assert.ok(!stale.includes("https://example.com/brandnew"));
  });
});

describe("recordDigest", () => {
  test("sets sentAt and digestId on each URL in the digest", () => {
    const ledger = { tabs: {}, digests: [] };
    recordSnapshot(
      ledger,
      [
        { url: "https://example.com/a", title: "A" },
        { url: "https://example.com/b", title: "B" },
      ],
      new Date("2026-07-01T00:00:00.000Z"),
    );

    const now = new Date("2026-07-03T00:00:00.000Z");
    recordDigest(
      ledger,
      {
        id: "2026-07-03-a",
        sentAt: now.toISOString(),
        articles: 2,
        sizeBytes: 12345,
        urls: ["https://example.com/a", "https://example.com/b"],
      },
      now,
    );

    assert.equal(
      ledger.tabs["https://example.com/a"].sentAt,
      now.toISOString(),
    );
    assert.equal(ledger.tabs["https://example.com/a"].digestId, "2026-07-03-a");
    assert.equal(
      ledger.tabs["https://example.com/b"].sentAt,
      now.toISOString(),
    );
    assert.equal(ledger.tabs["https://example.com/b"].digestId, "2026-07-03-a");
  });

  test("pushes the digest record onto ledger.digests", () => {
    const ledger = { tabs: {}, digests: [] };
    const digest = {
      id: "2026-07-03-a",
      sentAt: "2026-07-03T00:00:00.000Z",
      articles: 0,
      sizeBytes: 0,
      urls: [],
    };
    recordDigest(ledger, digest, new Date("2026-07-03T00:00:00.000Z"));
    assert.equal(ledger.digests.length, 1);
    assert.deepEqual(ledger.digests[0], digest);
  });

  test("ignores URLs in the digest that are not present in ledger.tabs", () => {
    const ledger = { tabs: {}, digests: [] };
    assert.doesNotThrow(() => {
      recordDigest(
        ledger,
        {
          id: "d1",
          sentAt: "2026-07-03T00:00:00.000Z",
          articles: 1,
          sizeBytes: 1,
          urls: ["https://never-seen.example.com/"],
        },
        new Date("2026-07-03T00:00:00.000Z"),
      );
    });
  });
});

describe("saveLedger", () => {
  test("writes pretty-printed, human-readable JSON", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");
    const ledger = { tabs: {}, digests: [] };
    await saveLedger(ledgerPath, ledger);

    const raw = await readFile(ledgerPath, "utf8");
    assert.ok(raw.includes("\n  "), "expected 2-space indented JSON");
    assert.deepEqual(JSON.parse(raw), ledger);
  });

  test("creates a missing parent directory", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "nested", "ledger.json");
    await saveLedger(ledgerPath, { tabs: {}, digests: [] });
    const raw = await readFile(ledgerPath, "utf8");
    assert.deepEqual(JSON.parse(raw), { tabs: {}, digests: [] });
  });

  test("does not leave a .tmp file behind after a successful save", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");
    await saveLedger(ledgerPath, { tabs: {}, digests: [] });
    await assert.rejects(() => stat(`${ledgerPath}.tmp`));
  });

  test("atomic write: final file is never a torn/partial write", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");

    // Seed a large-ish valid ledger, save it, then overwrite with another
    // large valid ledger and confirm the final file always parses cleanly
    // (rename is atomic, so there's no window where readers see a half
    // written file even though we can't easily simulate a real mid-write
    // crash in a unit test).
    const bigLedger = { tabs: {}, digests: [] };
    for (let i = 0; i < 500; i++) {
      bigLedger.tabs[`https://example.com/${i}`] = {
        title: `Article ${i}`,
        firstSeen: "2026-07-01T00:00:00.000Z",
        lastSeen: "2026-07-01T00:00:00.000Z",
        sentAt: null,
        digestId: null,
        reopenedAt: [],
        closedByKindling: false,
      };
    }
    await saveLedger(ledgerPath, bigLedger);
    const loaded = await loadLedger(ledgerPath);
    assert.equal(Object.keys(loaded.tabs).length, 500);
  });

  test("round-trips through loadLedger", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");
    let ledger = { tabs: {}, digests: [] };
    ledger = recordSnapshot(
      ledger,
      [{ url: "https://example.com/a", title: "A" }],
      new Date("2026-07-01T00:00:00.000Z"),
    );
    await saveLedger(ledgerPath, ledger);

    const loaded = await loadLedger(ledgerPath);
    assert.deepEqual(loaded, ledger);
  });

  test("corrupt JSON throws an actionable error naming the path", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");
    await writeFile(ledgerPath, "{ this is not: valid json", "utf8");
    await assert.rejects(loadLedger(ledgerPath), (err) => {
      assert.match(err.message, /not valid JSON/);
      assert.ok(
        err.message.includes(ledgerPath),
        "error should name the ledger path",
      );
      return true;
    });
  });

  test("malformed shape (missing keys) is backfilled, not crashed on", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");
    await writeFile(ledgerPath, '{"tabs":{}}', "utf8"); // no digests
    const loaded = await loadLedger(ledgerPath);
    assert.deepEqual(loaded.digests, []);
    assert.deepEqual(loaded.tabs, {});
  });

  test("non-object JSON (array/null) falls back to an empty ledger", async () => {
    const dir = await makeTmpDir();
    const ledgerPath = path.join(dir, "ledger.json");
    await writeFile(ledgerPath, "[]", "utf8");
    assert.deepEqual(await loadLedger(ledgerPath), { tabs: {}, digests: [] });
  });
});
