// background.js — the MV3 service worker. No DOM here (see
// docs/extension-interfaces.md's "what runs where" table), so this file only
// does chrome.* bookkeeping: tab-age tracking, the badge, the message router,
// scheduling, and standing up/tearing down the offscreen document for the
// scheduled send. It also proxies chrome.scripting extraction calls for the
// offscreen document, which has no chrome.scripting access of its own.

import { screenUrl, normalizeUrl } from "@kindling/core/filter";
import { chromeStorage, loadConfig, makeContentSource } from "./adapters.js";

const TAB_AGES_KEY = "tabAges";
const RECOMPUTE_ALARM = "recompute";
const SCHEDULED_SEND_ALARM = "scheduled-send";
const RECOMPUTE_PERIOD_MINUTES = 30;
const OFFSCREEN_URL = "offscreen/offscreen.html";
const BADGE_COLOR = "#D97706"; // warm amber

// ---- Tab-age tracking -------------------------------------------------------

/** Re-derive the tracked-tab map from a fresh chrome.tabs.query snapshot:
 * keep firstSeen for URLs still open, add new ones, prune closed ones. Only
 * http(s) urls that pass screenUrl (per the current config's filters) are
 * tracked — sensitive/app tabs are never captured here.
 * @returns {Promise<Record<string, {firstSeen:string, title:string, url:string}>>} */
async function recomputeTabAges() {
  const config = await loadConfig();
  const tabs = await chrome.tabs.query({});
  const nowIso = new Date().toISOString();
  const tabAges = (await chromeStorage.get(TAB_AGES_KEY)) || {};

  const seen = new Set();
  for (const tab of tabs) {
    if (!tab.url || !/^https?:/i.test(tab.url)) continue;
    const { include } = screenUrl(tab.url, config.filters);
    if (!include) continue;

    const key = normalizeUrl(tab.url);
    seen.add(key);

    const existing = tabAges[key];
    if (!existing) {
      tabAges[key] = { firstSeen: nowIso, title: tab.title || tab.url, url: tab.url };
    } else {
      existing.title = tab.title || existing.title;
      existing.url = tab.url;
    }
  }

  for (const key of Object.keys(tabAges)) {
    if (!seen.has(key)) delete tabAges[key];
  }

  await chromeStorage.set(TAB_AGES_KEY, tabAges);
  await updateBadge(config, tabAges);
  return tabAges;
}

async function updateBadge(config, tabAges) {
  const staleHours = config.staleHours ?? 48;
  const thresholdMs = staleHours * 60 * 60 * 1000;
  const nowMs = Date.now();
  let staleCount = 0;
  for (const record of Object.values(tabAges)) {
    if (nowMs - new Date(record.firstSeen).getTime() >= thresholdMs) staleCount++;
  }
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: staleCount > 0 ? String(staleCount) : "" });
}

/** Build the {url,title,ageMs,stale} list GET_STATE returns. */
function tabsFromAges(tabAges, staleHours) {
  const thresholdMs = (staleHours ?? 48) * 60 * 60 * 1000;
  const nowMs = Date.now();
  return Object.values(tabAges).map((record) => {
    const ageMs = nowMs - new Date(record.firstSeen).getTime();
    return { url: record.url, title: record.title, ageMs, stale: ageMs >= thresholdMs };
  });
}

for (const evt of [chrome.tabs.onCreated, chrome.tabs.onRemoved]) {
  evt.addListener(() => {
    recomputeTabAges().catch((err) => console.error("kindling: recompute failed", err));
  });
}
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  recomputeTabAges().catch((err) => console.error("kindling: recompute failed", err));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECOMPUTE_ALARM) {
    recomputeTabAges().catch((err) => console.error("kindling: recompute failed", err));
  } else if (alarm.name === SCHEDULED_SEND_ALARM) {
    runScheduledSend().catch((err) => console.error("kindling: scheduled send failed", err));
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RECOMPUTE_ALARM, { periodInMinutes: RECOMPUTE_PERIOD_MINUTES });
  recomputeTabAges().catch((err) => console.error("kindling: recompute failed", err));
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(RECOMPUTE_ALARM, { periodInMinutes: RECOMPUTE_PERIOD_MINUTES });
  recomputeTabAges().catch((err) => console.error("kindling: recompute failed", err));
});

// ---- Offscreen document lifecycle (scheduled send) -------------------------

let offscreenReady = null; // Promise guarding concurrent ensure calls.

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (offscreenReady) return offscreenReady;
  offscreenReady = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["DOM_PARSER"],
      justification: "build the EPUB digest",
    })
    .catch((err) => {
      // "Only a single offscreen document may be created" races are
      // benign — another caller already stood one up.
      if (!/single offscreen document/i.test(String(err && err.message))) throw err;
    })
    .finally(() => {
      offscreenReady = null;
    });
  return offscreenReady;
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function runScheduledSend() {
  const config = await loadConfig();
  if (!config.kindleEmail) return; // nothing configured — nothing to do

  await ensureOffscreenDocument();
  try {
    const report = await chrome.runtime.sendMessage({ type: "RUN_SCHEDULED" });
    return report;
  } finally {
    await closeOffscreenDocument().catch((err) => console.error("kindling: closing offscreen failed", err));
  }
}

// ---- Message router ---------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false; // no externally_connectable — ignore anything else
  if (!message || typeof message.type !== "string") return false;

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String((err && err.message) || err) }));
  return true; // keep the message channel open for the async response
});

async function handleMessage(message) {
  switch (message.type) {
    case "GET_STATE": {
      const config = await loadConfig();
      const tabAges = (await chromeStorage.get(TAB_AGES_KEY)) || {};
      return { config, tabs: tabsFromAges(tabAges, config.staleHours) };
    }
    case "SET_CONFIG": {
      await chromeStorage.set("config", message.config);
      await recomputeTabAges();
      return { ok: true };
    }
    case "SCHEDULE_INSTALL": {
      const periodInMinutes = Math.max(1, Number(message.everyMinutes) || 60);
      await chrome.alarms.create(SCHEDULED_SEND_ALARM, { periodInMinutes });
      return { ok: true };
    }
    case "SCHEDULE_UNINSTALL": {
      await chrome.alarms.clear(SCHEDULED_SEND_ALARM);
      return { ok: true };
    }
    case "EXTRACT": {
      // Proxy for the offscreen document, which has no chrome.scripting
      // access — the SW is the only context that can inject into tabs.
      const source = makeContentSource();
      return source.getArticle(message.url, message.opts || {});
    }
    default:
      return { error: `unknown message type: ${message.type}` };
  }
}
