// send.js
//
// Builds an RFC-5322 MIME multipart message (short text/plain part + the
// EPUB as a base64 `application/epub+zip` attachment) and sends it through
// the Gmail API's `users.messages.send`. Requires only an access token with
// the `gmail.send` scope (see ./oauth.js).

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import crypto from "node:crypto";

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const DEFAULT_TEXT_BODY = "Your Kindling digest is attached. Happy reading!";
const BASE64_LINE_LENGTH = 76; // RFC 2045 line-length limit for base64 body content

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Wrap a base64 string at RFC 2045's 76-character line limit. */
function wrapBase64(str) {
  const lines = [];
  for (let i = 0; i < str.length; i += BASE64_LINE_LENGTH) {
    lines.push(str.slice(i, i + BASE64_LINE_LENGTH));
  }
  return lines.join("\r\n");
}

/** Reject a value containing CR/LF (or other control chars) before it is
 * interpolated into a mail header or SMTP command line — prevents header /
 * SMTP-command injection. Exported for reuse by the SMTP fallback. */
export function assertNoCrlf(value, field) {
  if (/[\x00-\x1f]/.test(String(value))) {
    throw new Error(
      `Invalid "${field}": control characters (e.g. CR/LF) are not allowed.`,
    );
  }
}

/** RFC 2047-encode a header value if it contains non-ASCII characters. */
function encodeHeaderValue(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Build the raw RFC-5322 MIME message (CRLF line endings) as a string.
 * @param {{from:string, to:string, subject:string, text?:string,
 *          attachmentBuffer:Buffer, attachmentName:string}} params
 * @returns {string}
 */
export function buildMimeMessage({
  from,
  to,
  subject,
  text = DEFAULT_TEXT_BODY,
  attachmentBuffer,
  attachmentName,
}) {
  if (!from || !to)
    throw new Error('buildMimeMessage requires both "from" and "to".');
  if (!attachmentBuffer || !attachmentName) {
    throw new Error(
      'buildMimeMessage requires "attachmentBuffer" and "attachmentName".',
    );
  }
  // Defense-in-depth: reject header/command injection at the boundary of these
  // exported functions, independent of caller-side validation. `subject` is
  // safe because encodeHeaderValue base64-encodes anything with control bytes.
  assertNoCrlf(from, "from");
  assertNoCrlf(to, "to");
  assertNoCrlf(attachmentName, "attachmentName");
  // The filename is placed inside Content-Disposition ...; filename="<name>".
  // A `"` (or `;`) would break out of the quoted value and inject extra
  // parameters, so reject them here (independent of the internal caller).
  if (/["\\;]/.test(attachmentName)) {
    throw new Error(
      'Invalid "attachmentName": must not contain quotes, backslashes, or semicolons.',
    );
  }

  const boundary = `kindling_${crypto.randomBytes(16).toString("hex")}`;

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject ?? "")}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${boundary}`,
    "Content-Type: application/epub+zip",
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(attachmentBuffer.toString("base64")),
    "",
    `--${boundary}--`,
    "",
  ];

  return lines.join("\r\n");
}

/**
 * Base64url-encode a raw MIME message for the Gmail API's `raw` field.
 * @param {string} mimeString
 * @returns {string}
 */
export function encodeMessageBase64Url(mimeString) {
  return base64url(Buffer.from(mimeString, "utf8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt, baseDelayMs) {
  return baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * @typedef {Object} SendOptions
 * @property {string} accessToken
 * @property {string} to
 * @property {string} from
 * @property {string} subject
 * @property {string} attachmentPath
 * @property {string} [attachmentName]
 * @property {string} [text]
 * @property {typeof fetch} [fetchImpl] injection seam for tests
 * @property {number} [maxAttempts]
 * @property {number} [baseDelayMs]
 */

/**
 * Send an email with one attachment via the Gmail API. Retries 429/5xx
 * responses (and network errors) with exponential backoff + jitter.
 * @param {SendOptions} opts
 * @returns {Promise<{id:string}>}
 */
export async function sendMail(opts) {
  const {
    accessToken,
    to,
    from,
    subject,
    attachmentPath,
    attachmentName,
    text = DEFAULT_TEXT_BODY,
    fetchImpl = fetch,
    maxAttempts = 4,
    baseDelayMs = 500,
  } = opts;

  if (!accessToken) throw new Error("sendMail requires an accessToken.");
  if (!to || !from) throw new Error('sendMail requires both "to" and "from".');
  if (!attachmentPath) throw new Error("sendMail requires an attachmentPath.");

  const attachmentBuffer = await readFile(attachmentPath);
  const name = attachmentName || basename(String(attachmentPath));
  const mime = buildMimeMessage({
    from,
    to,
    subject,
    text,
    attachmentBuffer,
    attachmentName: name,
  });
  const raw = encodeMessageBase64Url(mime);

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;
    let res;
    try {
      res = await fetchImpl(GMAIL_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      });
    } catch (err) {
      lastError = err;
      if (isLastAttempt) {
        throw new Error(
          `Gmail send failed after ${maxAttempts} attempts (network error): ${err.message}`,
        );
      }
      await sleep(backoffMs(attempt, baseDelayMs));
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      return { id: data.id };
    }

    const transient = res.status === 429 || res.status >= 500;
    if (transient && !isLastAttempt) {
      lastError = new Error(`HTTP ${res.status}`);
      await sleep(backoffMs(attempt, baseDelayMs));
      continue;
    }

    const bodyText = await safeText(res);
    throw new Error(
      `Gmail send failed: HTTP ${res.status} ${bodyText}`.trim() +
        (transient ? ` (exhausted ${maxAttempts} attempts)` : ""),
    );
  }

  throw lastError || new Error("Gmail send failed for an unknown reason.");
}

export const __internal = { wrapBase64, encodeHeaderValue, BASE64_LINE_LENGTH };
