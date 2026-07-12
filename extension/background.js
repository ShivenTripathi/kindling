// background.js — Kindling's MV3 service worker.
//
// Responsibilities (see docs and CLAUDE.md invariants this must respect):
//  1. Track how long each open http(s) tab has been open, per-URL, entirely
//     in chrome.storage.local (this browser profile only — MV3 extensions
//     have no visibility into other Chrome profiles, so "profile isolation"
//     is a property of the platform here, not something we implement).
//  2. Keep the toolbar badge showing how many tabs are currently stale.
//  3. Keep a local, permanent history of what was sent and detect
//     "reopened after being sent" (never silently drop that signal).
//  4. On an explicit user "send" action, optionally capture the live,
//     rendered DOM of each chosen tab (the premium path — defeats
//     paywalls/SPAs/bot-challenges the CLI's plain fetcher can't get past)
//     and hand everything to the native-messaging host, which runs the
//     real pipeline (extract -> epub -> send -> ledger) locally.
//
// Nothing here talks to any server. The only outbound channel is
// chrome.runtime.connectNative to the local native host.

import {
  normalizeUrl,
  isTrackableUrl,
  isSendableUrl,
  domainOf,
  formatAge,
  hoursToMs,
  digestId,
  emptyState,
  STORAGE_KEY,
} from './common.js';

const NATIVE_HOST = 'com.kindling.host';
const RECOMPUTE_ALARM = 'kindling-recompute';
const BADGE_COLOR = '#c65d2e';

// ---------------------------------------------------------------------------
// State load/save
// ---------------------------------------------------------------------------

async function loadState() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const state = got[STORAGE_KEY];
  if (!state || typeof state !== 'object') return emptyState();
  if (!state.tabs) state.tabs = {};
  if (!Array.isArray(state.digests)) state.digests = [];
  if (!state.settings) state.settings = emptyState().settings;
  return state;
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// ---------------------------------------------------------------------------
// Tab tracking: reconcile chrome.tabs.query({}) against stored records.
// ---------------------------------------------------------------------------

/**
 * Re-derive open/closed + firstSeen/reopened state from the live tab list.
 * Idempotent and safe to call from any event handler or the alarm.
 */
async function reconcileOpenTabs() {
  const state = await loadState();
  const now = new Date().toISOString();

  const liveTabs = await chrome.tabs.query({});
  const seenKeys = new Set();

  for (const tab of liveTabs) {
    // Skip non-http(s) pages AND excluded/sensitive domains (webmail, banking,
    // social, etc.) — those must never be tracked, offered, or have their
    // authenticated DOM captured. Mirrors the CLI's screenUrl gate.
    if (!tab.url || !isTrackableUrl(tab.url) || !isSendableUrl(tab.url)) continue;
    const key = normalizeUrl(tab.url);
    seenKeys.add(key);

    const rec = state.tabs[key];
    if (!rec) {
      state.tabs[key] = {
        title: tab.title || key,
        firstSeen: now,
        lastSeen: now,
        tabIds: [tab.id],
        sentAt: null,
        digestId: null,
        reopenedAt: [],
        closedByKindling: false,
      };
      continue;
    }

    const wasOpen = Array.isArray(rec.tabIds) && rec.tabIds.length > 0;
    rec.title = tab.title || rec.title;
    rec.lastSeen = now;
    if (!Array.isArray(rec.tabIds)) rec.tabIds = [];
    if (!rec.tabIds.includes(tab.id)) rec.tabIds.push(tab.id);

    if (!wasOpen) {
      // Fresh "currently open" streak: restart the staleness clock.
      rec.firstSeen = now;
      // If this URL was sent before, this reopen is exactly the signal the
      // user wants surfaced in history — record it, but don't touch
      // sentAt/digestId (matches src/ledger.js's selectStale semantics:
      // once sent, a URL is never re-selected just because it reappeared).
      if (rec.sentAt) rec.reopenedAt.push(now);
    }
  }

  // Anything no longer live: mark closed (keep the record for history).
  for (const [key, rec] of Object.entries(state.tabs)) {
    if (seenKeys.has(key)) continue;
    if (Array.isArray(rec.tabIds) && rec.tabIds.length > 0) {
      rec.tabIds = [];
    }
  }

  await saveState(state);
  await updateBadge(state);
  return state;
}

/** @param {Object} rec @param {number} staleMs @param {number} nowMs */
function isStale(rec, staleMs, nowMs) {
  if (!rec.tabIds || rec.tabIds.length === 0) return false;
  if (rec.sentAt) return false;
  return nowMs - new Date(rec.firstSeen).getTime() >= staleMs;
}

async function updateBadge(state) {
  const staleMs = hoursToMs(state.settings.staleHours);
  const nowMs = Date.now();
  const count = Object.values(state.tabs).filter((rec) => isStale(rec, staleMs, nowMs)).length;
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}

// ---------------------------------------------------------------------------
// Popup-facing queries
// ---------------------------------------------------------------------------

async function getStaleTabs() {
  const state = await reconcileOpenTabs();
  const staleMs = hoursToMs(state.settings.staleHours);
  const nowMs = Date.now();

  const out = [];
  for (const [url, rec] of Object.entries(state.tabs)) {
    if (!isStale(rec, staleMs, nowMs)) continue;
    const ageMs = nowMs - new Date(rec.firstSeen).getTime();
    out.push({
      url,
      title: rec.title,
      domain: domainOf(url),
      ageMs,
      ageLabel: formatAge(ageMs),
      tabId: rec.tabIds[0],
    });
  }
  out.sort((a, b) => b.ageMs - a.ageMs);
  return out;
}

async function getHistory() {
  const state = await loadState();
  const digests = state.digests
    .slice()
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))
    .map((d) => ({
      ...d,
      urls: d.urls.map((url) => {
        const rec = state.tabs[normalizeUrl(url)];
        return {
          url,
          title: (rec && rec.title) || url,
          reopenedCount: (rec && rec.reopenedAt && rec.reopenedAt.length) || 0,
        };
      }),
    }));
  return { digests };
}

async function getSettings() {
  const state = await loadState();
  return state.settings;
}

async function setSettings(partial) {
  const state = await loadState();
  state.settings = { ...state.settings, ...partial };
  await saveState(state);
  await updateBadge(state);
  return state.settings;
}

// ---------------------------------------------------------------------------
// Optional host permission (needed for scripting.executeScript on arbitrary
// background tabs — see manifest.json / README for the tradeoff writeup).
// ---------------------------------------------------------------------------

async function hasHostPermission() {
  return chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
}

async function requestHostPermission() {
  return chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
}

// ---------------------------------------------------------------------------
// Capturing rendered DOM from a live tab (the "premium" extraction source).
// ---------------------------------------------------------------------------

async function captureTabHtml(tabId) {
  if (tabId == null) return null;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return typeof result === 'string' ? result : null;
  } catch {
    // Tab may have navigated away, closed, or be a chrome:// page scripting
    // can't touch. Fall back silently — the host will fetch it itself.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Native messaging bridge
// ---------------------------------------------------------------------------

/**
 * Send one request to the native host and collect progress + the final
 * result over a long-lived port (send can take a while: extraction,
 * epub build, and the actual email send).
 * @param {{type:string, items: Array}} request
 * @param {(progress:Object)=>void} onProgress
 * @returns {Promise<Object>} the final `result` message
 */
function callNativeHost(request, onProgress) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      reject(new Error(`Could not start the Kindling native host: ${err.message}`));
      return;
    }

    let settled = false;
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'progress') {
        onProgress(msg);
      } else if (msg.type === 'result') {
        settled = true;
        resolve(msg);
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const err = chrome.runtime.lastError;
      reject(
        new Error(
          err
            ? `Native host disconnected: ${err.message}. Run native-host/install.js and reload the extension.`
            : 'Native host disconnected unexpectedly before finishing.',
        ),
      );
    });

    port.postMessage(request);
  });
}

/**
 * @param {string[]} urls
 * @param {{closeAfterSend?: boolean, captureDom?: boolean}} opts
 * @param {(progress:Object)=>void} onProgress
 */
async function sendTabs(urls, opts, onProgress = () => {}) {
  const state = await loadState();
  const captureDom = opts.captureDom !== false;
  const canCapture = captureDom && (await hasHostPermission());

  const items = [];
  for (const url of urls) {
    const key = normalizeUrl(url);
    const rec = state.tabs[key];
    const tabId = rec && rec.tabIds && rec.tabIds[0];
    let rawHtml = null;
    if (canCapture && tabId != null) {
      onProgress({ type: 'progress', stage: 'capture', url });
      rawHtml = await captureTabHtml(tabId);
    }
    items.push({ url, title: (rec && rec.title) || url, rawHtml });
  }

  onProgress({ type: 'progress', stage: 'handoff', url: null, message: `Sending ${items.length} tab(s) to the local pipeline…` });

  let result;
  try {
    result = await callNativeHost({ type: 'sendTabs', items }, onProgress);
  } catch (err) {
    return { ok: false, error: err.message, sentUrls: [], failedUrls: urls.map((url) => ({ url, reason: err.message })) };
  }

  if (!result.ok) {
    return { ok: false, error: result.error || 'Unknown native host error', sentUrls: [], failedUrls: result.failedUrls || [] };
  }

  // Record the digest + mark sent URLs in local state.
  const now = new Date();
  const freshState = await loadState();
  const sentUrls = result.sentUrls || [];
  for (const url of sentUrls) {
    const key = normalizeUrl(url);
    const rec = freshState.tabs[key];
    if (rec) {
      rec.sentAt = now.toISOString();
      rec.digestId = result.digestId;
    }
  }
  if (sentUrls.length > 0) {
    freshState.digests.push({
      id: result.digestId || digestId(now, freshState.digests.length),
      sentAt: now.toISOString(),
      articles: result.articleCount ?? sentUrls.length,
      sizeBytes: result.sizeBytes ?? 0,
      urls: sentUrls,
    });
  }
  await saveState(freshState);
  await updateBadge(freshState);

  if (opts.closeAfterSend) {
    const tabIdsToClose = [];
    for (const url of sentUrls) {
      const rec = freshState.tabs[normalizeUrl(url)];
      if (rec && rec.tabIds) tabIdsToClose.push(...rec.tabIds);
    }
    if (tabIdsToClose.length > 0) {
      try {
        await chrome.tabs.remove(tabIdsToClose);
      } catch {
        // Tab may already be gone; not fatal.
      }
    }
  }

  return { ok: true, digestId: result.digestId, sentUrls, failedUrls: result.failedUrls || [] };
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RECOMPUTE_ALARM, { periodInMinutes: 15 });
  reconcileOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  reconcileOpenTabs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECOMPUTE_ALARM) reconcileOpenTabs();
});

chrome.tabs.onCreated.addListener(() => reconcileOpenTabs());
chrome.tabs.onRemoved.addListener(() => reconcileOpenTabs());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') reconcileOpenTabs();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'getStaleTabs':
          sendResponse({ ok: true, tabs: await getStaleTabs() });
          break;
        case 'getHistory':
          sendResponse({ ok: true, ...(await getHistory()) });
          break;
        case 'getSettings':
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case 'setSettings':
          sendResponse({ ok: true, settings: await setSettings(msg.settings || {}) });
          break;
        case 'hasHostPermission':
          sendResponse({ ok: true, granted: await hasHostPermission() });
          break;
        case 'requestHostPermission':
          sendResponse({ ok: true, granted: await requestHostPermission() });
          break;
        case 'sendTabs': {
          const result = await sendTabs(msg.urls || [], msg.opts || {}, (progress) => {
            // Best-effort broadcast to the popup, if it's still open. If
            // nothing is listening this simply resolves with no receiver.
            chrome.runtime.sendMessage({ type: 'sendProgress', progress }).catch(() => {});
          });
          sendResponse({ ok: true, result });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg && msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
