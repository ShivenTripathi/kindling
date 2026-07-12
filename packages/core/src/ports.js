// ports.js — the platform-capability interfaces the core pipeline depends on.
//
// Core code NEVER imports a Node- or browser-specific API directly. Instead it
// takes these ports as parameters, and each surface (extension, desktop, CLI)
// supplies concrete adapters:
//
//   ContentSource  — how you get an article's clean content
//                    · extension: capture the live, logged-in DOM
//                    · cli/desktop: the tiered SSRF-guarded fetcher
//   Sender         — how a built EPUB is emailed to the Kindle
//                    · GmailApiSender (fetch; token injected) — all surfaces
//                    · SmtpSender (node:tls) — cli/desktop only
//   Storage        — durable key/value for config + ledger
//                    · extension: chrome.storage.local ; cli/desktop: JSON files
//   Secrets        — durable secret store (the LLM key; OAuth tokens if not
//                    browser-managed) · extension: chrome.storage ; else Keychain
//   Scheduler      — run the pipeline on a timer
//                    · extension: chrome.alarms ; desktop: Tauri ; cli: launchd
//   Clock          — injectable now(), so time logic stays testable
//
// These are JSDoc typedefs (documentation + tsc checking); there is no runtime
// class to extend. An adapter is any object with the right shape.

/**
 * @typedef {Object} Article
 * @property {string} url
 * @property {string} title
 * @property {string} [byline]
 * @property {string} [siteName]
 * @property {string} [publishedTime]
 * @property {string} contentHtml   // sanitized article HTML (images/tables/code preserved)
 * @property {string} textContent   // plain text (word-count / gating / LLM input)
 * @property {number} wordCount
 * @property {string} [engine]      // which extractor won (diagnostic)
 * @property {number} [score]
 * @property {string} [source]      // 'dom-capture' | 'tier1' | 'tier2' | 'tier3'
 * @property {string} [summary]     // optional AI summary (set by runDigest when an LLM is configured)
 */

/**
 * A source of clean article content for a URL. Implementations must never throw
 * for a bad page — return {status:'skipped'|'failed', reason}.
 * @typedef {Object} ContentSource
 * @property {(url: string, opts?: object) => Promise<ContentResult>} getArticle
 */
/**
 * @typedef {Object} ContentResult
 * @property {'ok'|'skipped'|'failed'} status
 * @property {Article} [article]
 * @property {string} [reason]
 */

/**
 * Sends one email with a single EPUB attachment.
 * @typedef {Object} Sender
 * @property {(msg: OutgoingMail) => Promise<{id:string}>} send
 */
/**
 * @typedef {Object} OutgoingMail
 * @property {string} to               the kindle.com address
 * @property {string} from             approved sender
 * @property {string} subject
 * @property {Uint8Array} attachment   the .epub bytes
 * @property {string} attachmentName   e.g. "2026-07-12-a.epub"
 * @property {string} [text]
 */

/**
 * Durable key/value store. Values are JSON-serializable.
 * @typedef {Object} Storage
 * @property {(key: string) => Promise<any>} get
 * @property {(key: string, value: any) => Promise<void>} set
 * @property {(key: string) => Promise<void>} remove
 */

/**
 * Durable secret store (kept separate from Storage so adapters can back it with
 * the OS keychain / an encrypted store rather than plain settings).
 * @typedef {Object} Secrets
 * @property {(account: string) => Promise<string|null>} get
 * @property {(account: string, secret: string) => Promise<void>} set
 * @property {(account: string) => Promise<void>} remove
 */

/**
 * Runs a callback on a recurring interval (survives restarts where the platform
 * allows). `install` is idempotent for a given name.
 * @typedef {Object} Scheduler
 * @property {(name: string, everyMinutes: number) => Promise<void>} install
 * @property {(name: string) => Promise<void>} uninstall
 */

/**
 * @typedef {Object} Clock
 * @property {() => Date} now
 */

/** Default real clock. Adapters/tests may substitute a fake. @type {Clock} */
export const systemClock = { now: () => new Date() };

// This module intentionally exports only `systemClock`. The typedefs above are
// the contract; importing this file also pulls the JSDoc types into scope for
// `@type {import('../ports.js').Sender}`-style annotations elsewhere in core.
