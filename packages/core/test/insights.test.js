import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeInsights,
  tagTopics,
  DOMAIN_CATEGORIES,
} from "../src/insights/index.js";

/** Build an empty ledger. */
function emptyLedger() {
  return { tabs: {}, digests: [] };
}

/** ISO string `hoursAgo` hours before `now`. */
function isoHoursAgo(now, hours) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/** ISO string `daysAgo` days before `now`. */
function isoDaysAgo(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

const NOW = new Date("2026-07-12T12:00:00.000Z");

describe("computeInsights: backlog", () => {
  test("counts unsent tabs open >= staleHours, boundary is inclusive", () => {
    const ledger = emptyLedger();
    // exactly 48h old, unsent -> counted (boundary inclusive: >=)
    ledger.tabs["https://a.example.com/"] = {
      title: "A",
      firstSeen: isoHoursAgo(NOW, 48),
      lastSeen: isoHoursAgo(NOW, 48),
      sentAt: null,
      digestId: null,
      reopenedAt: [],
      closedByKindling: false,
    };
    // just under 48h old, unsent -> not counted
    ledger.tabs["https://b.example.com/"] = {
      title: "B",
      firstSeen: isoHoursAgo(NOW, 47.999),
      lastSeen: isoHoursAgo(NOW, 47.999),
      sentAt: null,
      digestId: null,
      reopenedAt: [],
      closedByKindling: false,
    };
    // old but already sent -> not backlog
    ledger.tabs["https://c.example.com/"] = {
      title: "C",
      firstSeen: isoHoursAgo(NOW, 100),
      lastSeen: isoHoursAgo(NOW, 100),
      sentAt: isoHoursAgo(NOW, 50),
      digestId: "d1",
      reopenedAt: [],
      closedByKindling: false,
    };

    const insights = computeInsights(ledger, { now: NOW, staleHours: 48 });
    assert.equal(insights.backlog, 1);
    assert.equal(insights.totalTracked, 3);
  });
});

describe("computeInsights: reopenRate", () => {
  test("counts only reopens strictly after sentAt, over all sent urls", () => {
    const ledger = emptyLedger();
    const sentAt = isoDaysAgo(NOW, 5);

    // sent + reopened after send -> counts toward reopenRate numerator
    ledger.tabs["https://a.example.com/"] = {
      title: "A",
      firstSeen: isoDaysAgo(NOW, 10),
      lastSeen: isoDaysAgo(NOW, 1),
      sentAt,
      digestId: "d1",
      reopenedAt: [isoDaysAgo(NOW, 2)], // after sentAt
      closedByKindling: false,
    };
    // sent, "reopened" only before send (stale data) -> should not count
    ledger.tabs["https://b.example.com/"] = {
      title: "B",
      firstSeen: isoDaysAgo(NOW, 10),
      lastSeen: isoDaysAgo(NOW, 6),
      sentAt,
      digestId: "d1",
      reopenedAt: [isoDaysAgo(NOW, 8)], // before sentAt
      closedByKindling: false,
    };
    // sent, never reopened
    ledger.tabs["https://c.example.com/"] = {
      title: "C",
      firstSeen: isoDaysAgo(NOW, 10),
      lastSeen: isoDaysAgo(NOW, 6),
      sentAt,
      digestId: "d1",
      reopenedAt: [],
      closedByKindling: false,
    };
    // never sent -> excluded from reopenRate denominator entirely
    ledger.tabs["https://d.example.com/"] = {
      title: "D",
      firstSeen: isoDaysAgo(NOW, 1),
      lastSeen: isoDaysAgo(NOW, 1),
      sentAt: null,
      digestId: null,
      reopenedAt: [],
      closedByKindling: false,
    };

    const insights = computeInsights(ledger, { now: NOW });
    // 1 reopened-after-send out of 3 sent urls
    assert.equal(insights.reopenRate, 1 / 3);
    assert.equal(insights.totalSent, 3);
  });

  test("reopenRate is 0 when nothing has been sent", () => {
    const insights = computeInsights(emptyLedger(), { now: NOW });
    assert.equal(insights.reopenRate, 0);
  });
});

describe("computeInsights: topSources", () => {
  test("aggregates by domain, strips leading www., sorts desc", () => {
    const ledger = emptyLedger();
    const mk = (url, daysAgo) => ({
      title: url,
      firstSeen: isoDaysAgo(NOW, daysAgo + 1),
      lastSeen: isoDaysAgo(NOW, daysAgo),
      sentAt: isoDaysAgo(NOW, daysAgo),
      digestId: "d1",
      reopenedAt: [],
      closedByKindling: false,
    });

    ledger.tabs["https://www.example.com/1"] = mk(
      "https://www.example.com/1",
      1,
    );
    ledger.tabs["https://example.com/2"] = mk("https://example.com/2", 2);
    ledger.tabs["https://example.com/3"] = mk("https://example.com/3", 3);
    ledger.tabs["https://other.com/1"] = mk("https://other.com/1", 1);

    const insights = computeInsights(ledger, { now: NOW, rangeDays: 30 });
    assert.deepEqual(insights.topSources, [
      { domain: "example.com", count: 3 },
      { domain: "other.com", count: 1 },
    ]);
  });
});

describe("computeInsights: volumeByDay", () => {
  test("includes zero days and has length rangeDays (plus today if needed)", () => {
    const ledger = emptyLedger();
    ledger.tabs["https://example.com/1"] = {
      title: "A",
      firstSeen: isoDaysAgo(NOW, 5),
      lastSeen: isoDaysAgo(NOW, 2),
      sentAt: isoDaysAgo(NOW, 2),
      digestId: "d1",
      reopenedAt: [],
      closedByKindling: false,
    };

    const rangeDays = 10;
    const insights = computeInsights(ledger, { now: NOW, rangeDays });
    assert.ok(insights.volumeByDay.length >= rangeDays);
    const total = insights.volumeByDay.reduce((sum, d) => sum + d.count, 0);
    assert.equal(total, 1);
    // most days are zero
    const zeroDays = insights.volumeByDay.filter((d) => d.count === 0).length;
    assert.ok(zeroDays >= rangeDays - 1);
  });
});

describe("computeInsights: streakDays", () => {
  test("counts consecutive days up to now, stops at a gap", () => {
    const ledger = emptyLedger();
    const mkSent = (daysAgo) => ({
      title: "x",
      firstSeen: isoDaysAgo(NOW, daysAgo + 1),
      lastSeen: isoDaysAgo(NOW, daysAgo),
      sentAt: isoDaysAgo(NOW, daysAgo),
      digestId: "d1",
      reopenedAt: [],
      closedByKindling: false,
    });

    // sends today, yesterday, 2 days ago -> streak of 3, then a gap at day 3
    ledger.tabs["https://example.com/today"] = mkSent(0);
    ledger.tabs["https://example.com/y1"] = mkSent(1);
    ledger.tabs["https://example.com/y2"] = mkSent(2);
    // gap at day 3 (nothing sent)
    ledger.tabs["https://example.com/y4"] = mkSent(4);

    const insights = computeInsights(ledger, { now: NOW, rangeDays: 30 });
    assert.equal(insights.streakDays, 3);
  });

  test("streak is 0 when nothing sent today", () => {
    const ledger = emptyLedger();
    ledger.tabs["https://example.com/y1"] = {
      title: "x",
      firstSeen: isoDaysAgo(NOW, 2),
      lastSeen: isoDaysAgo(NOW, 1),
      sentAt: isoDaysAgo(NOW, 1),
      digestId: "d1",
      reopenedAt: [],
      closedByKindling: false,
    };
    const insights = computeInsights(ledger, { now: NOW, rangeDays: 30 });
    assert.equal(insights.streakDays, 0);
  });
});

describe("computeInsights: readingMinutes", () => {
  test("uses wordCountByUrl when provided", () => {
    const ledger = emptyLedger();
    ledger.tabs["https://example.com/a"] = {
      title: "A",
      firstSeen: isoDaysAgo(NOW, 2),
      lastSeen: isoDaysAgo(NOW, 1),
      sentAt: isoDaysAgo(NOW, 1),
      digestId: "d1",
      reopenedAt: [],
      closedByKindling: false,
    };
    const insights = computeInsights(ledger, {
      now: NOW,
      wordsPerMinute: 200,
      wordCountByUrl: { "https://example.com/a": 1000 },
    });
    assert.equal(insights.readingMinutes, 5); // 1000 / 200
  });

  test("falls back to an average-per-article estimate when wordCountByUrl is absent", () => {
    const ledger = emptyLedger();
    ledger.tabs["https://example.com/a"] = {
      title: "A",
      firstSeen: isoDaysAgo(NOW, 2),
      lastSeen: isoDaysAgo(NOW, 1),
      sentAt: isoDaysAgo(NOW, 1),
      digestId: "d1",
      reopenedAt: [],
      closedByKindling: false,
    };
    const insights = computeInsights(ledger, { now: NOW, wordsPerMinute: 200 });
    assert.ok(insights.readingMinutes > 0);
  });
});

describe("tagTopics", () => {
  test("tags known science domain", () => {
    const tags = tagTopics({
      url: "https://www.biorxiv.org/content/123",
      title: "A new preprint",
      textContent: "Some abstract text with no keyword hits.",
    });
    assert.ok(tags.includes("science"));
  });

  test("tags known dev domain", () => {
    const tags = tagTopics({
      url: "https://github.com/foo/bar",
      title: "A repo",
      textContent: "readme contents",
    });
    assert.ok(tags.includes("dev"));
  });

  test("keyword pass tags ai/ml for an unlisted domain", () => {
    const tags = tagTopics({
      url: "https://someones-personal-blog.example/post",
      title: "Thoughts on machine learning systems",
      textContent: "This post discusses a new transformer model architecture.",
    });
    assert.ok(tags.includes("ai/ml"));
  });

  test("returns at most 3 tags and dedupes", () => {
    const tags = tagTopics({
      url: "https://nytimes.com/article",
      title: "Election coverage",
      textContent:
        "election senate congress policy debate health medicine disease clinical trial stock market inflation",
    });
    assert.ok(tags.length <= 3);
    assert.equal(new Set(tags).size, tags.length);
    assert.ok(tags.includes("news")); // domain tag always present first
  });

  test("returns empty array for an unmatched domain with no keywords", () => {
    const tags = tagTopics({
      url: "https://totally-unknown-site.example/page",
      title: "Untitled",
      textContent: "Lorem ipsum dolor sit amet.",
    });
    assert.deepEqual(tags, []);
  });

  test("DOMAIN_CATEGORIES is exported and extensible", () => {
    assert.equal(DOMAIN_CATEGORIES["github.com"], "dev");
  });
});
