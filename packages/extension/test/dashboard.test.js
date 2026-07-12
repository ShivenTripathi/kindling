// dashboard.test.js — unit tests for the dashboard's pure helpers
// (src/dashboard/topics.js). These have no DOM/chrome.* dependency, unlike
// dashboard.js itself (which wires them to the page and needs a real browser
// to verify — see the report for what that requires).

import { test } from "node:test";
import assert from "node:assert/strict";
import { tagTopics } from "@kindling/core/insights";
import {
  aggregateTopics,
  formatReadingTime,
  RANGE_PRESETS,
  digestHistory,
} from "../src/dashboard/topics.js";

function makeLedger() {
  return {
    tabs: {
      "https://github.com/foo/bar": {
        title: "foo/bar: a repo",
        firstSeen: "2026-07-01T00:00:00.000Z",
        lastSeen: "2026-07-01T00:00:00.000Z",
        sentAt: "2026-07-02T00:00:00.000Z",
        digestId: "d1",
        reopenedAt: ["2026-07-03T00:00:00.000Z"],
      },
      "https://nature.com/articles/x": {
        title: "A new discovery",
        firstSeen: "2026-07-01T00:00:00.000Z",
        lastSeen: "2026-07-01T00:00:00.000Z",
        sentAt: "2026-07-02T00:00:00.000Z",
        digestId: "d1",
        reopenedAt: [],
      },
      "https://example.com/unsent": {
        title: "Not sent yet",
        firstSeen: "2026-07-05T00:00:00.000Z",
        lastSeen: "2026-07-05T00:00:00.000Z",
        sentAt: null,
        digestId: null,
        reopenedAt: [],
      },
    },
    digests: [
      {
        id: "d1",
        sentAt: "2026-07-02T00:00:00.000Z",
        articles: 2,
        sizeBytes: 20480,
        urls: ["https://github.com/foo/bar", "https://nature.com/articles/x"],
      },
    ],
  };
}

test("aggregateTopics only tags sent tabs, sorted desc by count", () => {
  const ledger = makeLedger();
  const topics = aggregateTopics(ledger, tagTopics);
  // github.com -> "dev", nature.com -> "science"; the unsent example.com tab
  // must never contribute.
  const topicNames = topics.map((t) => t.topic);
  assert.ok(topicNames.includes("dev"));
  assert.ok(topicNames.includes("science"));
  for (const { count } of topics) assert.equal(count, 1);
});

test("aggregateTopics returns [] for an empty ledger", () => {
  assert.deepEqual(aggregateTopics({ tabs: {}, digests: [] }, tagTopics), []);
});

test("formatReadingTime formats minutes as Xh Ym / Ym", () => {
  assert.equal(formatReadingTime(0), "0m");
  assert.equal(formatReadingTime(45), "45m");
  assert.equal(formatReadingTime(60), "1h 0m");
  assert.equal(formatReadingTime(125), "2h 5m");
  assert.equal(formatReadingTime(-5), "0m");
});

test("RANGE_PRESETS covers week/month/all with sane day counts", () => {
  assert.equal(RANGE_PRESETS.week, 7);
  assert.equal(RANGE_PRESETS.month, 30);
  assert.ok(RANGE_PRESETS.all > 365);
});

test("digestHistory sorts newest-first and flags reopened urls", () => {
  const ledger = makeLedger();
  ledger.digests.push({
    id: "d0",
    sentAt: "2026-06-01T00:00:00.000Z",
    articles: 1,
    sizeBytes: 1024,
    urls: ["https://example.com/older"],
  });
  const history = digestHistory(ledger);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, "d1"); // newer first
  assert.equal(history[1].id, "d0");

  const urls = Object.fromEntries(
    history[0].urls.map((u) => [u.url, u.reopened]),
  );
  assert.equal(urls["https://github.com/foo/bar"], true);
  assert.equal(urls["https://nature.com/articles/x"], false);
});

test("digestHistory tolerates an empty ledger", () => {
  assert.deepEqual(digestHistory({ tabs: {}, digests: [] }), []);
});
