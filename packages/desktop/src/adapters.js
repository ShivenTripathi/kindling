// adapters.js — implements @kindling/core's ports with Tauri APIs.
//
// Mirrors packages/extension/src/adapters.js's role: the seam between core's
// platform-agnostic pipeline and the desktop app. tabsAdapter reads Chrome's
// on-disk session files (via the Rust backend + @kindling/core/snss),
// makeContentSource fetches HTML natively (no CORS, via the http plugin),
// makeSmtpSender ships the EPUB over SMTP (app password) via the Rust
// backend, and `storage` persists config.json / ledger.json in the app's
// data dir via the fs plugin.

import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  readTextFile,
  writeTextFile,
  exists,
  mkdir,
  rename,
  remove,
} from "@tauri-apps/plugin-fs";
import { openTabsFromBytes } from "@kindling/core/snss";
import { screenUrl } from "@kindling/core/filter";
import { extractFromDocument } from "@kindling/core/extract";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Kindling/0.1";

// ---- tabs (Chrome session files, via the Rust backend) --------------------

export const tabsAdapter = {
  /** @param {string} profileId @returns {Promise<{url:string,title:string,windowId:number,tabId:number,index:number}[]>} */
  async readOpenTabs(profileId) {
    const bytes = await invoke("newest_session_bytes", { profileId });
    return openTabsFromBytes(Uint8Array.from(bytes));
  },
};

/** @returns {Promise<{id:string,name:string,email:string|null}[]>} */
export async function listChromeProfiles() {
  return invoke("list_chrome_profiles");
}

// ---- ContentSource (native fetch via the http plugin) ----------------------

/** @returns {import('@kindling/core/ports').ContentSource} */
export function makeContentSource() {
  return {
    async getArticle(url, opts = {}) {
      try {
        const { include, reason } = screenUrl(url);
        if (!include) {
          return { status: "skipped", reason };
        }

        const res = await tauriFetch(url, {
          headers: { "user-agent": USER_AGENT },
        });
        if (!res.ok) {
          return { status: "failed", reason: `HTTP ${res.status}` };
        }
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const minWords =
          typeof opts.minWords === "number" ? opts.minWords : 300;
        return extractFromDocument(doc, url, { minWords });
      } catch (err) {
        return {
          status: "failed",
          reason: `fetch failed: ${err && err.message}`,
        };
      }
    },
  };
}

// ---- Sender (SMTP via the Rust backend) ------------------------------------

/** Uint8Array → base64 string, chunked to avoid call-stack blowups on large
 * EPUBs (String.fromCharCode(...bigArray) can exceed argument limits). */
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** @param {{host:string,port:number,username:string,password:string}} smtpConfig
 * @returns {import('@kindling/core/ports').Sender} */
export function makeSmtpSender(smtpConfig) {
  return {
    async send(mail) {
      const attachmentB64 = bytesToBase64(mail.attachment);
      await invoke("send_smtp", {
        opts: {
          host: smtpConfig.host,
          port: smtpConfig.port,
          username: smtpConfig.username,
          password: smtpConfig.password,
          from: mail.from,
          to: mail.to,
          subject: mail.subject,
          bodyText: mail.text || "Your Kindling digest is attached.",
          attachmentB64,
          attachmentName: mail.attachmentName,
        },
      });
      return { id: mail.attachmentName };
    },
  };
}

// ---- Storage (config.json / ledger.json in the app data dir) ---------------

const FILES = {
  config: "config.json",
  ledger: "ledger.json",
};

let appDataDirPromise = null;
async function getAppDataDir() {
  if (!appDataDirPromise) appDataDirPromise = invoke("app_data_dir");
  return appDataDirPromise;
}

async function filePathFor(key) {
  const dir = await getAppDataDir();
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
  return `${dir}${sep}${FILES[key]}`;
}

/** @type {import('@kindling/core/ports').Storage} */
export const storage = {
  async get(key) {
    if (!(key in FILES)) return undefined;
    const dir = await getAppDataDir();
    if (!(await exists(dir))) return undefined;
    const path = await filePathFor(key);
    if (!(await exists(path))) return undefined;
    let text;
    try {
      text = await readTextFile(path);
    } catch {
      return undefined;
    }
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text);
    } catch (err) {
      // A corrupt (e.g. crash-truncated) file must not be silently treated as
      // "absent" — that would erase settings/history without a word. Surface it.
      throw new Error(
        `Your ${FILES[key]} is corrupt and couldn't be read (${err.message}). ` +
          `Move it aside from the app data folder to start fresh.`,
      );
    }
  },
  async set(key, value) {
    if (!(key in FILES)) return;
    const dir = await getAppDataDir();
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    const path = await filePathFor(key);
    // Atomic write: write a temp file then rename over the target, so a crash
    // mid-write can't leave a truncated config/ledger behind.
    const tmp = `${path}.tmp`;
    await writeTextFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, path);
  },
  async remove(key) {
    if (!(key in FILES)) return;
    const path = await filePathFor(key);
    if (await exists(path)) {
      await remove(path);
    }
  },
};

// ---- Config -----------------------------------------------------------------

export const DEFAULT_CONFIG = {
  profileId: "Default",
  kindleEmail: "",
  senderEmail: "",
  staleHours: 48,
  minWords: 300,
  filters: { block: [], allow: [] },
  smtp: {
    host: "smtp.gmail.com",
    port: 465,
    username: "",
    password: "",
  },
  intervalMinutes: 0,
};

/** @returns {Promise<typeof DEFAULT_CONFIG>} */
export async function loadConfig() {
  const stored = (await storage.get("config")) || {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    filters: { ...DEFAULT_CONFIG.filters, ...(stored.filters || {}) },
    smtp: { ...DEFAULT_CONFIG.smtp, ...(stored.smtp || {}) },
  };
}

/** @param {object} cfg */
export async function saveConfig(cfg) {
  await storage.set("config", cfg);
}
