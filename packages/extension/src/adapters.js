// adapters.js — implements @kindling/core's ports with chrome.* APIs.
//
// Shared by the popup (send-now) and the offscreen document (scheduled send).
// Every export here is the seam between core's platform-agnostic pipeline and
// MV3: chrome.storage for Storage, chrome.scripting + chrome.tabs for
// ContentSource, chrome.identity for auth, and createGmailApiSender (core)
// wired to a token getter for Sender.

import { createGmailApiSender } from "@kindling/core/send";
import { normalizeUrl } from "@kindling/core/filter";
import { createProvider } from "@kindling/core/llm";

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
  // Bring-your-own Google OAuth client id — enables the launchWebAuthFlow
  // send path on Edge/Firefox and past the shared client's ~100-user cap.
  // Empty → use Chrome's native shared-client flow.
  oauthClientId: "",
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

// ---- LLM (optional, bring-your-own-key, local-only) -------------------------

/** Build an LlmProvider from the user's saved config, or `null` when no key is
 * configured — callers (popup/offscreen send flows) pass this straight into
 * `runDigest`'s `ports.llm`; `runDigest` treats `null` as "skip AI, send
 * normally." Uses the global `fetch` (available in the popup and the
 * offscreen document — never called from the service worker, which has no
 * DOM but does have fetch; this helper is safe there too if ever needed).
 * @param {{llm?: import('@kindling/core/llm').LlmConfig|null}} config
 * @returns {import('@kindling/core/llm').LlmProvider|null} */
export function makeLlmProvider(config) {
  return createProvider((config && config.llm) || null);
}

// ---- Auth -------------------------------------------------------------------

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const SCOPES = [GMAIL_SEND_SCOPE, USERINFO_EMAIL_SCOPE];

// In-memory access-token cache for the launchWebAuthFlow path (Chrome's native
// getAuthToken does its own caching/refresh). Implicit-flow tokens are short-
// lived and can't be silently refreshed, so interactive re-consent may be
// needed after they expire — documented as a cross-browser limitation.
let webAuthCache = { token: "", expiresAt: 0 };

/**
 * Get a Gmail access token. Default path is Chrome's native
 * `chrome.identity.getAuthToken` (uses the manifest oauth2 client; supports
 * silent refresh). Falls back to `launchWebAuthFlow` when that API is absent
 * (Edge/Firefox) OR when a bring-your-own client id is configured
 * (`config.oauthClientId`) — the escape hatch past the shared client's
 * ~100-user cap.
 * @param {boolean} [interactive=true]
 * @returns {Promise<string>}
 */
export async function getAuthToken(interactive = true) {
  const config = await loadConfig();
  const byoClientId = config.oauthClientId && String(config.oauthClientId).trim();
  const nativeAvailable =
    typeof chrome !== "undefined" &&
    chrome.identity &&
    typeof chrome.identity.getAuthToken === "function";

  if (nativeAvailable && !byoClientId) {
    return getAuthTokenNative(interactive);
  }
  return getAuthTokenWebFlow(byoClientId, interactive);
}

/** Chrome's native token flow (shared manifest client). */
function getAuthTokenNative(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive, scopes: SCOPES }, (tokenResult) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const token = typeof tokenResult === "string" ? tokenResult : tokenResult && tokenResult.token;
      if (!token) {
        reject(new Error("no auth token returned"));
        return;
      }
      resolve(token);
    });
  });
}

/** Cross-browser / bring-your-own-client flow via launchWebAuthFlow (implicit
 * grant). Requires `config.oauthClientId`. */
async function getAuthTokenWebFlow(clientId, interactive) {
  const now = Date.now();
  if (webAuthCache.token && webAuthCache.expiresAt - 60_000 > now) {
    return webAuthCache.token;
  }
  if (!clientId) {
    throw new Error(
      "This browser needs a bring-your-own Google client: set an OAuth client ID in Kindling's settings (see the extension README).",
    );
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(clientId)}` +
    "&response_type=token" +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SCOPES.join(" "))}` +
    "&prompt=consent";

  const redirectUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (out) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!out) {
        reject(new Error("authorization was cancelled"));
        return;
      }
      resolve(out);
    });
  });

  const fragment = String(redirectUrl).split("#")[1] || "";
  const params = new URLSearchParams(fragment);
  const token = params.get("access_token");
  if (!token) throw new Error("no access token in the OAuth redirect");
  const expiresIn = Number(params.get("expires_in") || 3600) * 1000;
  webAuthCache = { token, expiresAt: Date.now() + expiresIn };
  return token;
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
