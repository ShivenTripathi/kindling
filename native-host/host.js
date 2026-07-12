#!/usr/bin/env node
// host.js — Kindling's native-messaging host.
//
// Chrome launches this process on demand (via com.kindling.host.json) and
// talks to it over stdin/stdout using the length-prefixed JSON framing in
// ./framing.js. It is the bridge between the extension (background.js)
// and the exact same pipeline modules the CLI uses (src/extract, src/epub,
// src/gmail, src/ledger, src/config) — "the extension is the premium
// front-end to the same local pipeline" (see CLAUDE.md).
//
// IMPORTANT: stdout is the protocol channel. Nothing may be written to it
// except framed messages — all logging goes to stderr, where Chrome logs
// native-host output for debugging (chrome://extensions -> Errors, or run
// this script directly with --stdio-debug to see it in a terminal).
//
// This process must never crash the pipe on a bad input or a failed
// article: every error is caught and reported back as a `result` message
// with `ok:false` (or partial success with `failedUrls`), matching
// invariant 5 in CLAUDE.md ("nothing silently dropped").

import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  encodeMessage,
  createFrameAccumulator,
  FrameTooLargeError,
} from "./framing.js";
import { paths, loadConfig } from "../src/config.js";
import {
  loadLedger,
  saveLedger,
  recordSnapshot,
  recordDigest,
} from "../src/ledger.js";
import { extract } from "../src/extract/index.js";
import { screenUrl } from "../src/filter.js";
import { buildEpub, splitForSizeLimit } from "../src/epub.js";
import { authorize, getAccessToken } from "../src/gmail/oauth.js";
import { sendMail } from "../src/gmail/send.js";
import { sendMailSmtp } from "../src/gmail/smtp.js";
import { getSecret } from "../src/gmail/keychain.js";

// Same Keychain keys `kindling init` writes under (see src/cli.js) — kept
// in sync manually since importing src/cli.js would execute its CLI
// entrypoint as a side effect.
const OAUTH_CLIENT_ID_KEY = "__oauth_client_id__";
const OAUTH_CLIENT_SECRET_KEY = "__oauth_client_secret__";

function writeMessage(obj) {
  process.stdout.write(encodeMessage(obj));
}

function logError(...args) {
  console.error("[kindling-host]", ...args);
}

/** Matches src/cli.js's digestId() scheme so `kindling history` output
 * stays consistent regardless of whether a digest came from the CLI or
 * the extension.
 * @param {Date} date @param {number} suffixIndex @returns {string} */
function digestId(date, suffixIndex) {
  const d = date.toISOString().slice(0, 10);
  return `${d}-${String.fromCharCode(97 + suffixIndex)}`;
}

async function oauthClient() {
  const clientId = await getSecret(OAUTH_CLIENT_ID_KEY);
  const clientSecret = await getSecret(OAUTH_CLIENT_SECRET_KEY);
  if (!clientId || !clientSecret) {
    throw new Error(
      "No Google OAuth client configured. Run `kindling init` first.",
    );
  }
  return { clientId, clientSecret };
}

/**
 * Run the full extract -> epub -> send -> ledger pipeline for a batch of
 * tabs handed over by the extension.
 * @param {{url:string, title:string, rawHtml?:string|null}[]} items
 * @param {(progress:Object)=>void} onProgress
 */
async function handleSendTabs(items, onProgress) {
  const now = new Date();
  const cfg = await loadConfig();
  const { ledgerPath, dataDir } = paths();

  const articles = [];
  const failedUrls = [];

  // Cap rawHtml to bound jsdom memory/CPU on a pathologically large captured DOM.
  const MAX_RAW_HTML_BYTES = 25 * 1024 * 1024;

  for (const item of items) {
    // Validate the item shape at the trust boundary (don't rely on downstream
    // modules to reject malformed input).
    if (!item || typeof item.url !== "string" || item.url.length === 0) {
      failedUrls.push({
        url: String(item && item.url),
        reason: "malformed item (missing url)",
      });
      continue;
    }
    // Authoritative gate: re-apply the same exclusion/SSRF screen the CLI uses,
    // so the extension's rendered-DOM path can NEVER send a banking/webmail/
    // financial/local tab even though the popup might have offered it.
    const screen = screenUrl(item.url, cfg.filters);
    if (!screen.include) {
      failedUrls.push({ url: item.url, reason: `excluded: ${screen.reason}` });
      onProgress({
        type: "progress",
        stage: "extract",
        url: item.url,
        message: `Skipped ${item.url}: ${screen.reason}`,
      });
      continue;
    }
    let rawHtml;
    if (typeof item.rawHtml === "string") {
      rawHtml =
        Buffer.byteLength(item.rawHtml, "utf8") <= MAX_RAW_HTML_BYTES
          ? item.rawHtml
          : undefined;
    }

    onProgress({
      type: "progress",
      stage: "extract",
      url: item.url,
      message: `Extracting ${item.url}…`,
    });
    let result;
    try {
      result = await extract(item.url, {
        minWords: cfg.minWords,
        rawHtml,
        disableWayback: cfg.disableWayback,
      });
    } catch (err) {
      result = { status: "failed", reason: `unexpected error: ${err.message}` };
    }

    if (result.status === "ok") {
      articles.push(result.article);
      onProgress({
        type: "progress",
        stage: "extract",
        url: item.url,
        message: `Extracted "${result.article.title}" (${result.article.wordCount}w, ${result.article.engine}, ${result.article.fetchTier})`,
      });
    } else {
      failedUrls.push({ url: item.url, reason: result.reason });
      onProgress({
        type: "progress",
        stage: "extract",
        url: item.url,
        message: `Skipped ${item.url}: ${result.reason}`,
      });
    }
  }

  if (articles.length === 0) {
    return {
      ok: false,
      error: "No articles could be extracted from the selected tabs.",
      sentUrls: [],
      failedUrls,
    };
  }

  await mkdir(dataDir, { recursive: true });
  const groups = splitForSizeLimit(articles);
  const accessToken =
    cfg.authMethod === "oauth"
      ? await getAccessToken(await oauthClient())
      : null;

  const title = "Tab Digest";
  const sentUrls = [];
  let lastDigestId = null;
  let totalSizeBytes = 0;
  let totalArticleCount = 0;

  for (let i = 0; i < groups.length; i++) {
    const id = digestId(now, i);
    const outPath = path.join(dataDir, `${id}.epub`);

    onProgress({
      type: "progress",
      stage: "build",
      url: null,
      message: `Building ${id}.epub…`,
    });
    const built = await buildEpub(groups[i], {
      outPath,
      title,
      date: now,
      failedUrls: i === 0 ? failedUrls.map((f) => f.url) : [],
    });

    onProgress({
      type: "progress",
      stage: "send",
      url: null,
      message: `Sending ${id}.epub to ${cfg.kindleEmail}…`,
    });
    const subject = groups.length > 1 ? `${title} ${id}` : title;
    if (cfg.authMethod === "oauth") {
      await sendMail({
        accessToken,
        to: cfg.kindleEmail,
        from: cfg.senderEmail,
        subject,
        attachmentPath: built.path,
        attachmentName: `${id}.epub`,
      });
    } else {
      await sendMailSmtp({
        to: cfg.kindleEmail,
        from: cfg.senderEmail,
        subject,
        attachmentPath: built.path,
        attachmentName: `${id}.epub`,
      });
    }

    const groupUrls = groups[i].map((a) => a.url);
    sentUrls.push(...groupUrls);
    lastDigestId = id;
    totalSizeBytes += built.sizeBytes;
    totalArticleCount += built.articleCount;

    // Reuse the CLI's own ledger functions so the extension and the CLI
    // share one ledger, one source of truth for `kindling status`/`history`.
    let ledger = await loadLedger(ledgerPath);
    ledger = recordSnapshot(
      ledger,
      groups[i].map((a) => ({ url: a.url, title: a.title })),
      now,
    );
    ledger = recordDigest(
      ledger,
      {
        id,
        sentAt: now.toISOString(),
        articles: built.articleCount,
        sizeBytes: built.sizeBytes,
        urls: groupUrls,
      },
      now,
    );
    await saveLedger(ledgerPath, ledger);

    onProgress({
      type: "progress",
      stage: "send",
      url: null,
      message: `Sent ${id}.epub (${(built.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${built.articleCount} articles).`,
    });
  }

  return {
    ok: true,
    digestId: lastDigestId,
    articleCount: totalArticleCount,
    sizeBytes: totalSizeBytes,
    sentUrls,
    failedUrls,
  };
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") {
    writeMessage({ type: "result", ok: false, error: "Malformed request." });
    return;
  }

  if (msg.type === "sendTabs") {
    try {
      const result = await handleSendTabs(
        Array.isArray(msg.items) ? msg.items : [],
        (progress) => writeMessage(progress),
      );
      writeMessage({ type: "result", ...result });
    } catch (err) {
      logError("sendTabs failed:", err);
      writeMessage({
        type: "result",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        sentUrls: [],
        failedUrls: (msg.items || []).map((i) => ({
          url: i.url,
          reason: "pipeline error, see host log",
        })),
      });
    }
    return;
  }

  if (msg.type === "ping") {
    writeMessage({ type: "result", ok: true, pong: true });
    return;
  }

  writeMessage({
    type: "result",
    ok: false,
    error: `Unknown message type: ${msg.type}`,
  });
}

function main() {
  const acc = createFrameAccumulator();

  process.stdin.on("data", (chunk) => {
    let messages;
    try {
      messages = acc.push(chunk);
    } catch (err) {
      // A framing error (oversized or malformed length) desyncs the stream —
      // we can't know where the next frame begins — so report and disconnect
      // rather than keep buffering a growing, un-parseable input.
      logError("Fatal framing error, disconnecting:", err);
      try {
        writeMessage({
          type: "result",
          ok: false,
          error:
            err instanceof FrameTooLargeError
              ? err.message
              : "malformed native message",
        });
      } catch {
        /* stdout may be gone */
      }
      process.exit(1);
    }
    for (const msg of messages) {
      handleMessage(msg).catch((err) =>
        logError("Unhandled error handling message:", err),
      );
    }
  });

  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", (err) => {
    logError("stdin error:", err);
    process.exit(1);
  });

  // Surface anything unexpected on stderr instead of letting it crash the
  // pipe silently — Chrome just sees the process exit either way, but this
  // makes `chrome://extensions` -> Errors -> host stderr actionable.
  process.on("uncaughtException", (err) => logError("uncaughtException:", err));
  process.on("unhandledRejection", (err) =>
    logError("unhandledRejection:", err),
  );
}

main();
