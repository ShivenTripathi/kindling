import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readOpenTabs,
  parseSnssBuffer,
  SnssParseError,
} from "../src/tabs/snss.js";
import {
  listProfiles,
  newestSessionFile,
  readProfileTabs,
} from "../src/tabs/profiles.js";

// ---------------------------------------------------------------------------
// Synthetic SNSS buffer construction helpers
//
// These build a minimal, valid SNSS file byte-for-byte per the format
// documented at the top of src/tabs/snss.js, so we can unit-test the parser
// without depending on a real Chrome profile.
// ---------------------------------------------------------------------------

function align4(n) {
  return (n + 3) & ~3;
}

/** One command: uint16 LE size (of type+payload), uint8 type, payload bytes. */
function buildCommand(type, payload) {
  const size = payload.length + 1;
  const buf = Buffer.alloc(2 + 1 + payload.length);
  buf.writeUInt16LE(size, 0);
  buf.writeUInt8(type, 2);
  payload.copy(buf, 3);
  return buf;
}

/** raw struct: two uint32 LE fields back-to-back. */
function twoU32(a, b) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(a, 0);
  buf.writeUInt32LE(b, 4);
  return buf;
}

/** pickled 8-bit string: uint32 length + bytes, 4-byte aligned. */
function pickledString(str) {
  const strBytes = Buffer.from(str, "utf8");
  const len = strBytes.length;
  const padded = align4(len);
  const buf = Buffer.alloc(4 + padded);
  buf.writeUInt32LE(len, 0);
  strBytes.copy(buf, 4);
  return buf;
}

/** pickled UTF-16 string: uint32 char count + chars*2 bytes, 4-byte aligned. */
function pickledString16(str) {
  const strBytes = Buffer.from(str, "utf16le");
  const chars = str.length;
  const byteLen = chars * 2;
  const padded = align4(byteLen);
  const buf = Buffer.alloc(4 + padded);
  buf.writeUInt32LE(chars, 0);
  strBytes.copy(buf, 4);
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
  const header = Buffer.alloc(8);
  header.write("SNSS", 0, "latin1");
  header.writeUInt32LE(1, 4); // version 1

  const setTabWindow = buildCommand(kCommandSetTabWindow, twoU32(1, 1)); // windowId=1, tabId=1
  const setTabIndex = buildCommand(kCommandSetTabIndexInWindow, twoU32(1, 0)); // tabId=1, index=0

  const innerParts = Buffer.concat([
    twoU32(1, 0).subarray(0, 4), // tabId=1
    Buffer.from([0, 0, 0, 0]), // navIndex=0
    pickledString(url),
    pickledString16(title),
  ]);
  const navPayload = Buffer.concat([
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(innerParts.length, 0);
      return b;
    })(),
    innerParts,
  ]);
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
    const pinnedPayload = Buffer.alloc(8); // tabId (4) + bool (1) + padding (3)
    pinnedPayload.writeUInt32LE(1, 0);
    pinnedPayload.writeUInt8(1, 4);
    parts.push(buildCommand(kCommandSetPinnedState, pinnedPayload));
  }

  return Buffer.concat(parts);
}

describe("snss.js", () => {
  test("parseSnssBuffer reconstructs one open tab from a synthetic file", () => {
    const buf = buildSnssBuffer({
      url: "https://example.com/article",
      title: "Example Article",
    });
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
    const buf = Buffer.concat([Buffer.from("NOPE", "latin1"), Buffer.alloc(4)]);
    assert.throws(() => parseSnssBuffer(buf), SnssParseError);
  });

  test("parseSnssBuffer rejects a too-small buffer", () => {
    assert.throws(() => parseSnssBuffer(Buffer.alloc(3)), SnssParseError);
  });

  test("parseSnssBuffer tolerates truncation mid-command and still returns partial state", () => {
    // Build the window/tab-association commands first (including the one
    // that registers window 1 in the windows map), then a navigation command
    // last, and cut the file off partway through that final command's
    // payload - the command header is present but its payload is
    // incomplete. Everything before it should still have been applied.
    const header = Buffer.alloc(8);
    header.write("SNSS", 0, "latin1");
    header.writeUInt32LE(1, 4);

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
    const innerParts = Buffer.concat([
      Buffer.from([1, 0, 0, 0]), // tabId=1
      Buffer.from([0, 0, 0, 0]), // navIndex=0
      pickledString(url),
      pickledString16(title),
    ]);
    const navPayload = Buffer.concat([
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(innerParts.length, 0);
        return b;
      })(),
      innerParts,
    ]);
    const updateNav = buildCommand(kCommandUpdateTabNavigation, navPayload);

    const full = Buffer.concat([
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
    const closedPayload = Buffer.alloc(12); // int32 id + int64 close_time
    closedPayload.writeUInt32LE(2, 0);
    const withClosed = Buffer.concat([buf, buildCommand(16, closedPayload)]);

    const tabs = parseSnssBuffer(withClosed);
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].tabId, 1);
  });

  test("readOpenTabs reads a real file end-to-end and returns the OpenTab contract shape", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kindling-snss-"));
    try {
      const filePath = path.join(dir, "Session_0001");
      const buf = buildSnssBuffer({
        url: "https://example.com/read",
        title: "Read Me",
      });
      await writeFile(filePath, buf);

      const tabs = await readOpenTabs(filePath);
      assert.deepEqual(tabs, [
        {
          url: "https://example.com/read",
          title: "Read Me",
          windowId: 1,
          tabId: 1,
          index: 0,
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readOpenTabs rejects with SnssParseError for a missing file", async () => {
    await assert.rejects(
      () => readOpenTabs("/nonexistent/path/Session_0001"),
      SnssParseError,
    );
  });

  test("readOpenTabs rejects with SnssParseError for a corrupt file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kindling-snss-"));
    try {
      const filePath = path.join(dir, "Session_bad");
      await writeFile(filePath, Buffer.from("NOTSNSS!"));
      await assert.rejects(() => readOpenTabs(filePath), SnssParseError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// profiles.js — synthetic fake Chrome root, never the real one
// ---------------------------------------------------------------------------

async function makeFakeChromeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "kindling-chrome-"));

  const localState = {
    profile: {
      info_cache: {
        Default: { name: "Person A", user_name: "persona@example.com" },
        "Profile 1": { name: "Person B" },
      },
    },
  };
  await writeFile(path.join(root, "Local State"), JSON.stringify(localState));

  // Default profile: has an account_info email (should win over
  // Local State's user_name) and a real session file.
  const defaultDir = path.join(root, "Default");
  await mkdir(path.join(defaultDir, "Sessions"), { recursive: true });
  await writeFile(
    path.join(defaultDir, "Preferences"),
    JSON.stringify({ account_info: [{ email: "signed-in@example.com" }] }),
  );
  const defaultBuf = buildSnssBuffer({
    url: "https://default.example/tab",
    title: "Default Tab",
  });
  await writeFile(
    path.join(defaultDir, "Sessions", "Session_0001"),
    defaultBuf,
  );

  // Profile 1: no Preferences account_info, no Sessions dir at all (to
  // exercise newestSessionFile -> null and readProfileTabs -> throws).
  const profile1Dir = path.join(root, "Profile 1");
  await mkdir(profile1Dir, { recursive: true });
  await writeFile(path.join(profile1Dir, "Preferences"), JSON.stringify({}));

  return root;
}

describe("profiles.js", () => {
  test("listProfiles reads Local State + Preferences metadata only", async () => {
    const root = await makeFakeChromeRoot();
    try {
      const profiles = await listProfiles(root);
      profiles.sort((a, b) => a.id.localeCompare(b.id));

      assert.equal(profiles.length, 2);
      assert.deepEqual(profiles[0], {
        id: "Default",
        displayName: "Person A",
        email: "signed-in@example.com", // Preferences account_info wins
        path: path.join(root, "Default"),
      });
      assert.deepEqual(profiles[1], {
        id: "Profile 1",
        displayName: "Person B",
        email: null, // no account_info, no Local State user_name
        path: path.join(root, "Profile 1"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listProfiles throws an actionable error when Local State is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kindling-chrome-empty-"));
    try {
      await assert.rejects(() => listProfiles(root), /Local State/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("newestSessionFile finds the session file for a profile with one", async () => {
    const root = await makeFakeChromeRoot();
    try {
      const found = await newestSessionFile(path.join(root, "Default"));
      assert.equal(
        found,
        path.join(root, "Default", "Sessions", "Session_0001"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("newestSessionFile returns null when there is no Sessions dir", async () => {
    const root = await makeFakeChromeRoot();
    try {
      const found = await newestSessionFile(path.join(root, "Profile 1"));
      assert.equal(found, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("newestSessionFile picks the most recently modified Session_* file", async () => {
    const root = await makeFakeChromeRoot();
    try {
      const sessionsDir = path.join(root, "Default", "Sessions");
      const olderBuf = buildSnssBuffer({
        url: "https://older.example/",
        title: "Older",
      });
      const newerPath = path.join(sessionsDir, "Session_0002");
      // Ensure a distinguishable mtime ordering.
      await writeFile(path.join(sessionsDir, "Session_0000"), olderBuf);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(newerPath, olderBuf);

      const found = await newestSessionFile(
        sessionsDir.replace(/Sessions$/, ""),
      );
      assert.equal(found, newerPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("readProfileTabs returns tabs for exactly the requested profile", async () => {
    const root = await makeFakeChromeRoot();
    try {
      const tabs = await readProfileTabs("Default", root);
      assert.deepEqual(tabs, [
        {
          url: "https://default.example/tab",
          title: "Default Tab",
          windowId: 1,
          tabId: 1,
          index: 0,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("readProfileTabs throws for an unknown profile id (never silently reads another profile)", async () => {
    const root = await makeFakeChromeRoot();
    try {
      await assert.rejects(
        () => readProfileTabs("Nonexistent Profile", root),
        /Unknown Chrome profile/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("readProfileTabs throws an actionable error for a profile with no session file", async () => {
    const root = await makeFakeChromeRoot();
    try {
      await assert.rejects(
        () => readProfileTabs("Profile 1", root),
        /No session file found/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
