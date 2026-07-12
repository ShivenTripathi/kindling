// adapters.js — implements @kindling/core's ports with chrome.* APIs.
//
// Shared by the popup (send-now) and the offscreen document (scheduled send).
// Every export here is the seam between core's platform-agnostic pipeline and
// MV3: chrome.storage for Storage, chrome.scripting + chrome.tabs for
// ContentSource, chrome.identity for auth, and createGmailApiSender (core)
// wired to a token getter for Sender.

import { createGmailApiSender } from "@kindling/core/send";
import { normalizeUrl } from "@kindling/core/filter";

/** @type {import('@kindling/core/ports').Storage} */
export const chromeStorage = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

export const DEFAULT_CONFIG = {
  kindleEmail: "",
  senderEmail: "",
  staleHours: 48,
  minWords: 300,
  filters: { block: [], allow: [] },
  disableWayback: false,
  llm: null,
};

/** @returns {Promise<typeof DEFAULT_CONFIG>} */
export async function loadConfig() {
  const stored = (await chromeStorage.get("config")) || {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    filters: { ...DEFAULT_CONFIG.filters, ...(stored.filters || {}) },
  };
}

/** @param {object} cfg */
export async function saveConfig(cfg) {
  await chromeStorage.set("config", cfg);
}

// ---- ContentSource ---------------------------------------------------------

/** Find the currently-open tab whose normalized URL matches `url`, if any. */
async function findOpenTab(url) {
  const target = normalizeUrl(url);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || tab.id == null) continue;
    if (normalizeUrl(tab.url) === target) return tab;
  }
  return null;
}

/** The function injected (by reference, via chrome.scripting `func`) into the
 * target tab AFTER content-extract.js has been injected as a file. Runs in
 * the page's world, so it can only see page globals — everything it needs
 * (minWords, the extraction hook) is passed in / already on `window`.
 * @param {number} minWords */
function readExtractResult(minWords) {
   
  window.__kindlingMinWords = minWords;
   
  return window.__kindlingExtract ? window.__kindlingExtract() : { status: "failed", reason: "content-extract.js did not load" };
}

/** @returns {import('@kindling/core/ports').ContentSource} */
export function makeContentSource() {
  return {
    async getArticle(url, opts = {}) {
      try {
        const tab = await findOpenTab(url);
        if (!tab) {
          return { status: "skipped", reason: "tab not open" };
        }

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content-extract.js"],
        });

        const minWords = typeof opts.minWords === "number" ? opts.minWords : 300;
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: readExtractResult,
          args: [minWords],
        });

        const result = injection && injection.result;
        if (!result) {
          return { status: "failed", reason: "no result from content-extract" };
        }
        return result;
      } catch (err) {
        // chrome:// / chrome-extension:// / the Chrome Web Store / PDF
        // viewer / crashed-tab pages all reject scripting injection — never
        // throw out of a ContentSource, always resolve with a reason.
        return { status: "failed", reason: `injection failed: ${err && err.message}` };
      }
    },
  };
}

// ---- Sender -----------------------------------------------------------------

/** @returns {import('@kindling/core/ports').Sender} */
export function makeGmailSender() {
  return createGmailApiSender({ getToken: () => getAuthToken(false) });
}

// ---- Auth -------------------------------------------------------------------

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

/** @param {boolean} [interactive=true]
 * @returns {Promise<string>} */
export function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken(
      { interactive, scopes: [GMAIL_SEND_SCOPE, USERINFO_EMAIL_SCOPE] },
      (tokenResult) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        // MV3 chrome.identity.getAuthToken resolves either a bare string
        // token (older API shape) or {token} — handle both defensively.
        const token = typeof tokenResult === "string" ? tokenResult : tokenResult && tokenResult.token;
        if (!token) {
          reject(new Error("no auth token returned"));
          return;
        }
        resolve(token);
      },
    );
  });
}

/** @returns {Promise<string|null>} */
export async function getAuthEmail() {
  const token = await getAuthToken(false);
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const info = await res.json();
  return info.email || null;
}
