// snss.js
//
// Browser-safe (zero-dependency) parser for Chrome/Chromium "SNSS" session
// files (the `Session_<timestamp>` files under a profile's `Sessions/`
// directory) that reconstructs the set of CURRENTLY OPEN tabs (open windows,
// open tabs, current navigation entry per tab).
//
// Format background
// ------------------
// An SNSS file is not a snapshot: Chrome appends a small "command" every time
// tab/window state changes (tab created, navigated, closed, reordered,
// pinned, ...). To learn "what's open right now" a reader has to replay every
// command in order and reconstruct the final in-memory state, exactly like
// Chrome itself does on restore. This is inherently an implementation detail
// of Chrome and can drift between versions; the layout below matches the
// (still current, as of Chromium's `session_service_commands.cc`) format.
//
// File layout:
//   bytes 0..3   "SNSS" magic
//   bytes 4..7   uint32 LE version (observed: 1 and 3; newer Chromium can
//                also emit other small integers - we parse permissively and
//                do not hard-fail on an unrecognized version, since the
//                command encoding itself hasn't changed)
//   then a stream of commands:
//     uint16 LE size        -- size of (1 type byte + payload), i.e.
//                               payload length = size - 1
//     uint8  type
//     <payload, `size - 1` bytes>
//
// Two payload encodings are used, and you must know which one a command uses
// from its type id (there's no in-band tag):
//   * "raw struct dump": fields are written back-to-back exactly as they sit
//     in the C++ struct in memory, INCLUDING compiler alignment padding.
//     E.g. {int32, bool} is really 8 bytes on disk (4 + 1 + 3 padding), not 5.
//     Because the command's outer `size` field tells us the true payload
//     length, we can safely read only the fields we need and ignore any
//     trailing padding bytes - we just skip to `size - 1` bytes total.
//   * "pickled": a `base::Pickle`-based payload that starts with its own
//     redundant uint32 length, followed by aligned-to-4-bytes chunks (used
//     for variable-length data like URL and title strings).
//
// Reference: this port was checked against
//   - https://raw.githubusercontent.com/lemnos/chrome-session-dump/master/chrome-session-dump.go
//     (a well-known, widely used pure Go implementation of the same idea)
//   - Chromium source, components/sessions/core/session_service_commands.cc
//     (current `kCommand*` constants pulled directly from that file)
// Command id numbering matches both sources exactly for everything we use
// below; no drift was found for the commands we need.
//
// This is a browser-safe port of the Node parser at `src/tabs/snss.js`: the
// only difference is the binary `Cursor`, which here operates on a
// `Uint8Array` via `DataView`/`TextDecoder` instead of Node `Buffer` methods.
// No `node:*` imports.

/**
 * @typedef {Object} OpenTab
 * @property {string} url
 * @property {string} title
 * @property {number} windowId
 * @property {number} tabId
 * @property {number} index   // position within its window
 */

// ---- Command ids (from Chromium's session_service_commands.cc) ----------
const kCommandSetTabWindow = 0;
const kCommandSetTabIndexInWindow = 2;
const kCommandUpdateTabNavigation = 6;
const kCommandSetSelectedNavigationIndex = 7;
const kCommandSetSelectedTabInIndex = 8;
const kCommandSetPinnedState = 12;
const kCommandTabClosed = 16;
const kCommandWindowClosed = 17;
const kCommandSetActiveWindow = 20;

/** Error thrown for unrecoverable parse failures (bad file, not an SNSS file, etc). */
export class SnssParseError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown}} [opts]
   */
  constructor(message, opts) {
    super(message);
    this.name = "SnssParseError";
    if (opts && opts.cause) this.cause = opts.cause;
  }
}

const utf8Decoder = new TextDecoder("utf-8");
const utf16leDecoder = new TextDecoder("utf-16le");

// A small bounds-checked binary cursor over a Uint8Array. Every read throws a
// plain Error (caught by callers) instead of silently reading garbage or
// letting a RangeError escape, so OOB conditions are always handled
// deliberately rather than crashing.
class Cursor {
  /**
   * @param {Uint8Array} bytes
   * @param {number} [offset]
   * @param {number} [end]
   */
  constructor(bytes, offset = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    this.offset = offset;
    this.end = end;
  }

  get remaining() {
    return this.end - this.offset;
  }

  _need(n) {
    if (this.offset + n > this.end) {
      throw new Error(
        `unexpected end of data (wanted ${n} bytes at offset ${this.offset}, only ${this.remaining} available)`,
      );
    }
  }

  readU8() {
    this._need(1);
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readU16LE() {
    this._need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readU32LE() {
    this._need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU64LE() {
    this._need(8);
    // Values here are ids/counters/timestamps; Number is fine (well under
    // Number.MAX_SAFE_INTEGER for anything we actually use).
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return Number(v);
  }

  readBytes(n) {
    this._need(n);
    const b = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }

  /** Pickled 8-bit string: uint32 length, then that many bytes, 4-byte aligned. */
  readPickledString() {
    const len = this.readU32LE();
    const padded = align4(len);
    const bytes = this.readBytes(padded);
    return utf8Decoder.decode(bytes.subarray(0, len));
  }

  /** Pickled UTF-16 string: uint32 char count, then char-count*2 bytes, 4-byte aligned. */
  readPickledString16() {
    const chars = this.readU32LE();
    const byteLen = chars * 2;
    const padded = align4(byteLen);
    const bytes = this.readBytes(padded);
    return utf16leDecoder.decode(bytes.subarray(0, byteLen));
  }
}

function align4(n) {
  return (n + 3) & ~3;
}

// ---- In-memory reconstruction state --------------------------------------

class TabState {
  constructor(id) {
    this.id = id;
    this.windowId = undefined;
    this.visualIndex = 0; // position within window (kCommandSetTabIndexInWindow)
    this.deleted = false;
    this.pinned = false;
    this.currentNavIndex = 0; // kCommandSetSelectedNavigationIndex
    this.history = new Map(); // navIndex -> {url, title}
  }
}

class WindowState {
  constructor(id) {
    this.id = id;
    this.deleted = false;
    this.activeTabVisualIndex = 0; // kCommandSetSelectedTabInIndex
  }
}

/**
 * Parse an in-memory SNSS buffer and reconstruct the currently open tabs.
 * Internal/lower-level than {@link openTabsFromBytes}: exposes extra fields
 * (tabId, pinned, active) beyond the public {@link OpenTab} contract, plus a
 * non-enumerable `meta` property with parse diagnostics. Exported mainly so
 * it can be unit-tested directly against synthetic buffers.
 *
 * @param {Uint8Array} bytes
 * @returns {Array<{url:string, title:string, windowId:number, tabId:number, index:number, pinned:boolean, active:boolean}>}
 */
export function parseSnssBuffer(bytes) {
  if (bytes.length < 8) {
    throw new SnssParseError(
      `File too small to be an SNSS session file (${bytes.length} bytes)`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "SNSS") {
    throw new SnssParseError(
      `Not an SNSS file (bad magic ${JSON.stringify(magic)})`,
    );
  }

  const version = view.getUint32(4, true);
  // Chrome has historically written version 1 and 3. We don't hard-fail on
  // other values since the command stream format itself is what matters and
  // has been stable; we just note it for diagnostics.
  const knownVersion = version === 1 || version === 3;

  const tabs = new Map(); // id -> TabState
  const windows = new Map(); // id -> WindowState

  const getTab = (id) => {
    let t = tabs.get(id);
    if (!t) {
      t = new TabState(id);
      tabs.set(id, t);
    }
    return t;
  };
  const getWindow = (id) => {
    let w = windows.get(id);
    if (!w) {
      w = new WindowState(id);
      windows.set(id, w);
    }
    return w;
  };

  const cursor = new Cursor(bytes, 8, bytes.length);
  let truncated = false;
  let truncationReason = null;

  while (true) {
    if (cursor.remaining === 0) break; // clean EOF
    if (cursor.remaining < 3) {
      // Not enough bytes left for a minimal command header (2 size + 1 type).
      truncated = true;
      truncationReason = `trailing ${cursor.remaining} byte(s) too small for a command header`;
      break;
    }

    const cmdStartOffset = cursor.offset;
    let size, type;
    try {
      size = cursor.readU16LE();
      if (size < 1) {
        throw new Error(
          `invalid command size ${size} at offset ${cmdStartOffset}`,
        );
      }
      type = cursor.readU8();
    } catch (err) {
      truncated = true;
      truncationReason = err.message;
      break;
    }

    const payloadLen = size - 1;
    if (cursor.remaining < payloadLen) {
      // The command header claims more payload than remains in the file:
      // classic truncation (e.g. Chrome killed mid-write). Stop gracefully
      // and use everything reconstructed so far, rather than throwing.
      truncated = true;
      truncationReason = `command at offset ${cmdStartOffset} (type ${type}) claims ${payloadLen} payload bytes, only ${cursor.remaining} remain`;
      break;
    }

    const payloadStart = cursor.offset;
    const payloadEnd = payloadStart + payloadLen;
    // Always advance the main cursor to the end of the declared payload,
    // regardless of how many bytes the handler below actually consumes
    // (raw-struct commands routinely have unused trailing padding).
    cursor.offset = payloadEnd;

    try {
      const p = new Cursor(bytes, payloadStart, payloadEnd);
      switch (type) {
        case kCommandSetTabWindow: {
          // raw struct: { int32 window_id; int32 tab_id; }
          const windowId = p.readU32LE();
          const tabId = p.readU32LE();
          getTab(tabId).windowId = windowId;
          break;
        }
        case kCommandSetTabIndexInWindow: {
          // raw struct IDAndIndexPayload: { int32 tab_id; int32 index; }
          const tabId = p.readU32LE();
          const index = p.readU32LE();
          getTab(tabId).visualIndex = index;
          break;
        }
        case kCommandUpdateTabNavigation: {
          // pickled: uint32 (redundant size, ignored) then
          // { int32 tab_id, int32 nav_index, string url, string16 title, ...more we don't need }
          p.readU32LE(); // redundant inner size
          const tabId = p.readU32LE();
          const navIndex = p.readU32LE();
          const url = p.readPickledString();
          const title = p.readPickledString16();
          getTab(tabId).history.set(navIndex, { url, title });
          break;
        }
        case kCommandSetSelectedNavigationIndex: {
          // raw struct IDAndIndexPayload: { int32 tab_id; int32 index; }
          const tabId = p.readU32LE();
          const index = p.readU32LE();
          getTab(tabId).currentNavIndex = index;
          break;
        }
        case kCommandSetSelectedTabInIndex: {
          // raw struct IDAndIndexPayload: { int32 window_id; int32 index; }
          const windowId = p.readU32LE();
          const index = p.readU32LE();
          getWindow(windowId).activeTabVisualIndex = index;
          break;
        }
        case kCommandSetPinnedState: {
          // raw struct PinnedStatePayload: { int32 tab_id; bool pinned; (+padding) }
          const tabId = p.readU32LE();
          const pinned = p.readU8() !== 0;
          getTab(tabId).pinned = pinned;
          break;
        }
        case kCommandTabClosed: {
          // raw struct ClosedPayload: { int32 id; int64 close_time; (+padding) }
          const tabId = p.readU32LE();
          getTab(tabId).deleted = true;
          break;
        }
        case kCommandWindowClosed: {
          const windowId = p.readU32LE();
          getWindow(windowId).deleted = true;
          break;
        }
        case kCommandSetActiveWindow: {
          // Read past the active-window id to keep the cursor aligned; we don't
          // use which window is active (all open tabs are returned regardless).
          p.readU32LE();
          break;
        }
        default:
          // Unknown/unneeded command (window bounds, tab groups, user agent
          // overrides, extension app ids, etc.) - safe to skip entirely
          // because the outer size framing already tells us how many bytes
          // to advance past.
          break;
      }
    } catch (err) {
      // A malformed individual command (e.g. a pickled string claiming a
      // length that doesn't fit) should not abort the whole parse - skip it
      // and keep going; the outer cursor has already advanced past it.
      truncated = true;
      truncationReason = `failed to interpret command type ${type} at offset ${cmdStartOffset}: ${err.message}`;
      continue;
    }
  }

  // ---- Reconstruct output: open tabs only ----
  // Group tabs by window, drop deleted tabs/windows, sort by visual index,
  // and recompute a dense 0-based index the same way Chrome/the reference
  // implementation does: only non-deleted tabs count towards the index used
  // to compare against activeTabVisualIndex.
  const tabsByWindow = new Map();
  for (const tab of tabs.values()) {
    if (tab.deleted) continue;
    if (tab.windowId === undefined) continue; // never associated with a window
    const win = windows.get(tab.windowId);
    if (!win || win.deleted) continue;
    if (!tabsByWindow.has(tab.windowId)) tabsByWindow.set(tab.windowId, []);
    tabsByWindow.get(tab.windowId).push(tab);
  }

  const result = [];
  for (const [windowId, winTabs] of tabsByWindow) {
    winTabs.sort((a, b) => a.visualIndex - b.visualIndex);
    const win = windows.get(windowId);

    winTabs.forEach((tab, denseIndex) => {
      // Pick the navigation entry at the tab's currently-selected index; if
      // that exact index was never recorded (can happen with truncated
      // history), fall back to the highest known index as the best guess of
      // "current page".
      let entry = tab.history.get(tab.currentNavIndex);
      if (!entry && tab.history.size > 0) {
        const maxIdx = Math.max(...tab.history.keys());
        entry = tab.history.get(maxIdx);
      }
      if (!entry) return; // no navigation data at all - nothing to report

      result.push({
        url: entry.url,
        title: entry.title,
        windowId,
        tabId: tab.id,
        index: denseIndex,
        pinned: tab.pinned,
        active: denseIndex === win.activeTabVisualIndex,
      });
    });
  }

  // Attach non-enumerable diagnostics without polluting the plain array
  // shape callers expect.
  Object.defineProperty(result, "meta", {
    value: { version, knownVersion, truncated, truncationReason },
    enumerable: false,
  });

  return result;
}

/**
 * Parse an in-memory SNSS buffer and return the currently-open tabs in the
 * public {@link OpenTab} contract shape (browser-safe equivalent of the Node
 * `readOpenTabs`, minus the file I/O).
 *
 * @param {Uint8Array} bytes
 * @returns {OpenTab[]}
 */
export function openTabsFromBytes(bytes) {
  const parsed = parseSnssBuffer(bytes);
  return parsed.map((tab) => ({
    url: tab.url,
    title: tab.title,
    windowId: tab.windowId,
    tabId: tab.tabId,
    index: tab.index,
  }));
}
