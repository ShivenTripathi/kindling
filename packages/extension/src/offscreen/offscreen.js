// offscreen/offscreen.js — runs the scheduled digest.
//
// The offscreen document has DOM (DOMParser/XMLSerializer, needed by
// buildEpub) but NOT chrome.scripting, so its ContentSource can't inject
// content-extract.js itself — it proxies each getArticle() call to the
// service worker via an `EXTRACT` message (background.js is the only
// context that can call chrome.scripting.executeScript).

import { runDigest } from "@kindling/core";
import { chromeStorage, loadConfig, makeGmailSender } from "../adapters.js";

const TAB_AGES_KEY = "tabAges";

/** ContentSource that proxies extraction to the service worker, which owns
 * chrome.scripting access. Never throws — resolves {status:'failed', reason}
 * on any messaging error, per the ContentSource contract.
 * @returns {import('@kindling/core/ports').ContentSource} */
function makeProxiedContentSource() {
  return {
    async getArticle(url, opts = {}) {
      try {
        const result = await chrome.runtime.sendMessage({ type: "EXTRACT", url, opts });
        if (!result) return { status: "failed", reason: "no response from background" };
        if (result.error) return { status: "failed", reason: result.error };
        return result;
      } catch (err) {
        return { status: "failed", reason: `extraction proxy error: ${err && err.message}` };
      }
    },
  };
}

async function runScheduledDigest() {
  const config = await loadConfig();
  const tabAges = (await chromeStorage.get(TAB_AGES_KEY)) || {};
  const openTabs = Object.values(tabAges).map((record) => ({ url: record.url, title: record.title }));

  const ports = {
    content: makeProxiedContentSource(),
    sender: makeGmailSender(),
    storage: chromeStorage,
  };

  return runDigest({ openTabs, ports, config });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!message || message.type !== "RUN_SCHEDULED") return false;

  runScheduledDigest()
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String((err && err.message) || err) }));
  return true;
});
