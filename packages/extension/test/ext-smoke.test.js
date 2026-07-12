// ext-smoke.test.js — minimal Node smoke check for the extension "engine"
// (adapters.js + background.js). These files assume chrome.* globals that
// only exist inside a real MV3 runtime, so this is NOT a behavioral test —
// it just proves the modules import cleanly against a minimal chrome stub
// (catching typos/bad imports/wrong export names before they ever hit a
// loaded extension) and that the documented exports exist with the right
// shape. Full behavioral verification (chrome.scripting injection,
// chrome.identity token flow, offscreen document lifecycle) requires a real
// loaded extension — see the report for what's out of reach here.

import { test } from "node:test";
import assert from "node:assert/strict";

function installChromeStub() {
  const storageData = {};
  const listeners = {
    onMessage: [],
    onCreated: [],
    onRemoved: [],
    onUpdated: [],
    onAlarm: [],
    onInstalled: [],
    onStartup: [],
  };

  globalThis.chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
      onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
      sendMessage: async () => ({ ok: true }),
      getContexts: async () => [],
    },
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === "string") return { [key]: storageData[key] };
          return { ...storageData };
        },
        set: async (obj) => {
          Object.assign(storageData, obj);
        },
        remove: async (key) => {
          delete storageData[key];
        },
      },
    },
    tabs: {
      query: async () => [],
      onCreated: { addListener: (fn) => listeners.onCreated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
      remove: async () => {},
    },
    scripting: {
      executeScript: async () => [
        { result: { status: "skipped", reason: "stub" } },
      ],
    },
    alarms: {
      create: async () => {},
      clear: async () => {},
      onAlarm: { addListener: (fn) => listeners.onAlarm.push(fn) },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    identity: {
      getAuthToken: (_opts, cb) => cb("fake-token"),
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {},
    },
  };

  return { storageData, listeners };
}

test("adapters.js exports the documented shape and works against the chrome stub", async () => {
  installChromeStub();
  const adapters = await import("../src/adapters.js");

  assert.equal(typeof adapters.chromeStorage.get, "function");
  assert.equal(typeof adapters.chromeStorage.set, "function");
  assert.equal(typeof adapters.chromeStorage.remove, "function");
  assert.equal(typeof adapters.makeContentSource, "function");
  assert.equal(typeof adapters.makeGmailSender, "function");
  assert.equal(typeof adapters.getAuthToken, "function");
  assert.equal(typeof adapters.getAuthEmail, "function");
  assert.equal(typeof adapters.loadConfig, "function");
  assert.equal(typeof adapters.saveConfig, "function");
  assert.ok(
    adapters.DEFAULT_CONFIG && typeof adapters.DEFAULT_CONFIG === "object",
  );
  assert.equal(adapters.DEFAULT_CONFIG.staleHours, 48);
  assert.equal(adapters.DEFAULT_CONFIG.minWords, 300);

  // chromeStorage round-trips through the stub.
  await adapters.chromeStorage.set("foo", { a: 1 });
  assert.deepEqual(await adapters.chromeStorage.get("foo"), { a: 1 });
  await adapters.chromeStorage.remove("foo");
  assert.equal(await adapters.chromeStorage.get("foo"), undefined);

  // loadConfig merges DEFAULT_CONFIG over an empty store.
  const cfg = await adapters.loadConfig();
  assert.equal(cfg.staleHours, 48);
  assert.deepEqual(cfg.filters, { block: [], allow: [] });

  // saveConfig + loadConfig round-trip, with defaults backfilled.
  await adapters.saveConfig({ kindleEmail: "me@kindle.com" });
  const reloaded = await adapters.loadConfig();
  assert.equal(reloaded.kindleEmail, "me@kindle.com");
  assert.equal(reloaded.staleHours, 48); // backfilled default

  // makeContentSource().getArticle never throws, even with no matching tab.
  const source = adapters.makeContentSource();
  const result = await source.getArticle("https://example.com/article");
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "tab not open");

  // makeGmailSender returns a Sender-shaped object (send is not invoked here
  // — that would hit the real network).
  const sender = adapters.makeGmailSender();
  assert.equal(typeof sender.send, "function");

  // getAuthToken resolves through the stubbed chrome.identity callback.
  const token = await adapters.getAuthToken(false);
  assert.equal(token, "fake-token");
});

test("background.js imports cleanly against the chrome stub and installs its listeners", async () => {
  const { listeners } = installChromeStub();
  await import("../src/background.js");

  assert.ok(
    listeners.onMessage.length >= 1,
    "registers a runtime.onMessage handler",
  );
  assert.ok(
    listeners.onCreated.length >= 1,
    "registers a tabs.onCreated handler",
  );
  assert.ok(
    listeners.onRemoved.length >= 1,
    "registers a tabs.onRemoved handler",
  );
  assert.ok(
    listeners.onUpdated.length >= 1,
    "registers a tabs.onUpdated handler",
  );
  assert.ok(
    listeners.onAlarm.length >= 1,
    "registers an alarms.onAlarm handler",
  );

  // Drive the message router directly (bypassing real chrome.runtime
  // dispatch, which the stub doesn't implement) to prove GET_STATE responds
  // with the documented shape.
  const handler = listeners.onMessage[0];
  const responses = [];
  const keepChannelOpen = handler(
    { type: "GET_STATE" },
    { id: "test-extension-id" },
    (resp) => responses.push(resp),
  );
  assert.equal(
    keepChannelOpen,
    true,
    "returns true to keep the async channel open",
  );

  // Let the handler's promise chain resolve.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(responses.length, 1);
  assert.ok("config" in responses[0]);
  assert.ok(Array.isArray(responses[0].tabs));
});

test("offscreen.js imports cleanly against the chrome stub", async () => {
  installChromeStub();
  await import("../src/offscreen/offscreen.js");
  // No exports to check (message-driven), but a clean import proves the
  // @kindling/core + adapters.js wiring resolves.
});

test("content-extract.js sets window.__kindlingExtract when a DOM is present", async () => {
  // content-extract.js is meant to run as a classic script injected into a
  // page (bundled IIFE), not imported as an ES module — but its source is
  // plain ESM importing @kindling/core/extract, so importing it here still
  // exercises the wiring as long as `window`/`document` exist. Use jsdom's
  // globals if available; otherwise skip (this file's real behavior is only
  // fully verifiable via chrome.scripting in a loaded extension).
  let hasDom =
    typeof globalThis.window !== "undefined" &&
    typeof globalThis.document !== "undefined";
  if (!hasDom) {
    try {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM(
        "<!doctype html><html><body><p>hi</p></body></html>",
        {
          url: "https://example.com/",
        },
      );
      globalThis.window = dom.window;
      globalThis.document = dom.window.document;
      globalThis.location = dom.window.location;
      hasDom = true;
    } catch {
      hasDom = false;
    }
  }

  if (!hasDom) {
    console.warn(
      "skipping content-extract.js DOM check: no window/document/jsdom available",
    );
    return;
  }

  await import("../src/content-extract.js");
  assert.equal(typeof globalThis.window.__kindlingExtract, "function");
  const result = await globalThis.window.__kindlingExtract();
  assert.ok(result && typeof result.status === "string");
});
