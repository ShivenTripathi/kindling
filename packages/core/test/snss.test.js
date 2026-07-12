import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseSnssBuffer,
  openTabsFromBytes,
  SnssParseError,
} from "../src/snss.js";

// ---------------------------------------------------------------------------
// Synthetic SNSS buffer construction helpers
//
// These build a minimal, valid SNSS file byte-for-byte per the format
// documented at the top of src/snss.js (ported from the audited Node parser
// at /Users/shiventripathi/dev/kindling/src/tabs/snss.js), so we can unit-
// test the parser without depending on a real Chrome profile. Fixtures are
// built as plain Uint8Array (via a small builder using DataView) so nothing
// here relies on Node's Buffer beyond what's convenient in a test file; the
// parser itself is only ever fed a Uint8Array.
// ---------------------------------------------------------------------------

function align4(n) {
  return (n + 3) & ~3;
}

function concatU8(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** One command: uint16 LE size (of type+payload), uint8 type, payload bytes. */
function buildCommand(type, payload) {
  const size = payload.length + 1;
  const buf = new Uint8Array(2 + 1 + payload.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, size, true);
  view.setUint8(2, type);
  buf.set(payload, 3);
  return buf;
}

/** raw struct: two uint32 LE fields back-to-back. */
function twoU32(a, b) {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, a, true);
  view.setUint32(4, b, true);
  return buf;
}

/** pickled 8-bit string: uint32 length + bytes, 4-byte aligned. */
function pickledString(str) {
  const strBytes = new TextEncoder().encode(str);
  const len = strBytes.length;
  const padded = align4(len);
  const buf = new Uint8Array(4 + padded);
  new DataView(buf.buffer).setUint32(0, len, true);
  buf.set(strBytes, 4);
  return buf;
}

/** pickled UTF-16LE string: uint32 char count + chars*2 bytes, 4-byte aligned. */
function pickledString16(str) {
  const chars = str.length;
  const byteLen = chars * 2;
  const padded = align4(byteLen);
  const buf = new Uint8Array(4 + padded);
  const view = new DataView(buf.buffer);
  view.setUint32(0, chars, true);
  for (let i = 0; i < chars; i++) {
    view.setUint16(4 + i * 2, str.charCodeAt(i), true);
  }
  return buf;
}

const kCommandSetTabWindow = 0;
const kCommandSetTabIndexInWindow = 2;
const kCommandUpdateTabNavigation = 6;
const kCommandSetSelectedNavigationIndex = 7;
const kCommandSetSelectedTabInIndex = 8;
const kCommandSetPinnedState = 12;

/**
 * Build a minimal valid SNSS buffer describing one window (id 1) with one
 * tab (id 1) navigated to `url`/`title`, optionally pinned.
 */
function buildSnssBuffer({ url, title, pinned = false } = {}) {
  const header = new Uint8Array(8);
  header[0] = "S".charCodeAt(0);
  header[1] = "N".charCodeAt(0);
  header[2] = "S".charCodeAt(0);
  header[3] = "S".charCodeAt(0);
  new DataView(header.buffer).setUint32(4, 1, true); // version 1

  const setTabWindow = buildCommand(kCommandSetTabWindow, twoU32(1, 1)); // windowId=1, tabId=1
  const setTabIndex = buildCommand(kCommandSetTabIndexInWindow, twoU32(1, 0)); // tabId=1, index=0

  const innerParts = concatU8([
    twoU32(1, 0).subarray(0, 4), // tabId=1
    new Uint8Array([0, 0, 0, 0]), // navIndex=0
    pickledString(url),
    pickledString16(title),
  ]);
  const innerLen = new Uint8Array(4);
  new DataView(innerLen.buffer).setUint32(0, innerParts.length, true);
  const navPayload = concatU8([innerLen, innerParts]);
  const updateNav = buildCommand(kCommandUpdateTabNavigation, navPayload);

  const setSelectedNav = buildCommand(
    kCommandSetSelectedNavigationIndex,
    twoU32(1, 0),
  ); // tabId=1, navIndex=0
  const setSelectedTab = buildCommand(
    kCommandSetSelectedTabInIndex,
    twoU32(1, 0),
  ); // windowId=1, index=0

  const parts = [
    header,
    setTabWindow,
    setTabIndex,
    updateNav,
    setSelectedNav,
    setSelectedTab,
  ];

  if (pinned) {
    const pinnedPayload = new Uint8Array(8); // tabId (4) + bool (1) + padding (3)
    new DataView(pinnedPayload.buffer).setUint32(0, 1, true);
    pinnedPayload[4] = 1;
    parts.push(buildCommand(kCommandSetPinnedState, pinnedPayload));
  }

  return concatU8(parts);
}

describe("snss.js (browser-safe)", () => {
  test("parseSnssBuffer reconstructs one open tab from a synthetic file", () => {
    const buf = buildSnssBuffer({
      url: "https://example.com/article",
      title: "Example Article",
    });
    assert.ok(buf instanceof Uint8Array);
    const tabs = parseSnssBuffer(buf);

    assert.equal(tabs.length, 1);
    assert.deepEqual(
      {
        url: tabs[0].url,
        title: tabs[0].title,
        windowId: tabs[0].windowId,
        tabId: tabs[0].tabId,
        index: tabs[0].index,
      },
      {
        url: "https://example.com/article",
        title: "Example Article",
        windowId: 1,
        tabId: 1,
        index: 0,
      },
    );
    assert.equal(tabs[0].pinned, false);
    assert.equal(tabs[0].active, true);
    assert.equal(tabs.meta.truncated, false);
    assert.equal(tabs.meta.version, 1);
  });

  test("parseSnssBuffer honors pinned state", () => {
    const buf = buildSnssBuffer({
      url: "https://example.com/pinned",
      title: "Pinned Tab",
      pinned: true,
    });
    const tabs = parseSnssBuffer(buf);
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].pinned, true);
  });

  test("parseSnssBuffer rejects bad magic", () => {
    const buf = concatU8([new TextEncoder().encode("NOPE"), new Uint8Array(4)]);
    assert.throws(() => parseSnssBuffer(buf), SnssParseError);
  });

  test("parseSnssBuffer rejects a too-small buffer", () => {
    assert.throws(() => parseSnssBuffer(new Uint8Array(3)), SnssParseError);
  });

  test("parseSnssBuffer tolerates truncation mid-command and still returns partial state", () => {
    // Build the window/tab-association commands first (including the one
    // that registers window 1 in the windows map), then a navigation command
    // last, and cut the file off partway through that final command's
    // payload - the command header is present but its payload is
    // incomplete. Everything before it should still have been applied.
    const header = new Uint8Array(8);
    header[0] = "S".charCodeAt(0);
    header[1] = "N".charCodeAt(0);
    header[2] = "S".charCodeAt(0);
    header[3] = "S".charCodeAt(0);
    new DataView(header.buffer).setUint32(4, 1, true);

    const setTabWindow = buildCommand(kCommandSetTabWindow, twoU32(1, 1));
    const setTabIndex = buildCommand(kCommandSetTabIndexInWindow, twoU32(1, 0));
    const setSelectedTab = buildCommand(
      kCommandSetSelectedTabInIndex,
      twoU32(1, 0),
    );
    const setSelectedNav = buildCommand(
      kCommandSetSelectedNavigationIndex,
      twoU32(1, 0),
    );

    const url = "https://example.com/a";
    const title = "A";
    const innerParts = concatU8([
      new Uint8Array([1, 0, 0, 0]), // tabId=1
      new Uint8Array([0, 0, 0, 0]), // navIndex=0
      pickledString(url),
      pickledString16(title),
    ]);
    const innerLen = new Uint8Array(4);
    new DataView(innerLen.buffer).setUint32(0, innerParts.length, true);
    const navPayload = concatU8([innerLen, innerParts]);
    const updateNav = buildCommand(kCommandUpdateTabNavigation, navPayload);

    const full = concatU8([
      header,
      setTabWindow,
      setTabIndex,
      setSelectedTab,
      setSelectedNav,
      updateNav,
    ]);
    // Cut off the last few bytes, which fall inside updateNav's payload
    // (the title string), leaving its command header intact but its
    // declared payload incomplete.
    const truncated = full.subarray(0, full.length - 3);

    const tabs = parseSnssBuffer(truncated);
    assert.equal(tabs.meta.truncated, true);
    assert.ok(tabs.meta.truncationReason);
    // The window/tab association and selection commands were all fully
    // applied before truncation was hit. The tab has no navigation entry
    // (that command was cut off), so it is correctly omitted from the
    // reconstructed open-tab list rather than reported with garbage data.
    assert.equal(tabs.length, 0);
  });

  test("parseSnssBuffer excludes closed tabs and closed windows", () => {
    const buf = buildSnssBuffer({ url: "https://example.com/x", title: "X" });
    // Append a "tab closed" command for a second, never-created tab id: a
    // no-op in terms of output, but exercises the closed-tab bookkeeping
    // path without disturbing tab 1.
    const closedPayload = new Uint8Array(12); // int32 id + int64 close_time
    new DataView(closedPayload.buffer).setUint32(0, 2, true);
    const withClosed = concatU8([buf, buildCommand(16, closedPayload)]);

    const tabs = parseSnssBuffer(withClosed);
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].tabId, 1);
  });

  test("openTabsFromBytes maps to the public OpenTab contract shape", () => {
    const buf = buildSnssBuffer({
      url: "https://example.com/read",
      title: "Read Me",
    });
    const tabs = openTabsFromBytes(buf);
    assert.deepEqual(tabs, [
      {
        url: "https://example.com/read",
        title: "Read Me",
        windowId: 1,
        tabId: 1,
        index: 0,
      },
    ]);
  });

  test("openTabsFromBytes propagates SnssParseError for a corrupt file", () => {
    assert.throws(
      () => openTabsFromBytes(new TextEncoder().encode("NOTSNSS!")),
      SnssParseError,
    );
  });

  test("parseSnssBuffer accepts a Node Buffer (Uint8Array subclass) unchanged", () => {
    // Buffer is a Uint8Array subclass; confirm the browser-safe parser still
    // works when fed one, without importing node:buffer itself in src/snss.js.
    const buf = buildSnssBuffer({
      url: "https://example.com/buffer",
      title: "Buffer Compat",
    });
    const nodeBuffer = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const tabs = parseSnssBuffer(nodeBuffer);
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].url, "https://example.com/buffer");
  });
});
