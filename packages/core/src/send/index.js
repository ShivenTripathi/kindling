// send/index.js
//
// Sender port + Gmail API implementation. Builds an RFC-5322 MIME multipart
// message (short text/plain part + the EPUB as a base64 `application/epub+zip`
// attachment) and sends it through the Gmail API's `users.messages.send`.
// Requires only an access token with the `gmail.send` scope; the token is
// supplied by an injected `getToken()` (chrome.identity in the extension, an
// OAuth refresh flow in cli/desktop).
//
// Browser-safe: no `node:*` imports. Base64 encoding uses `btoa`/TextEncoder
// (falling back to Node's global `Buffer` when present, which is not an
// import) and MIME boundaries are generated from injectable randomness rather
// than `node:crypto`.

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const DEFAULT_TEXT_BODY = "Your Kindling digest is attached. Happy reading!";
const BASE64_LINE_LENGTH = 76; // RFC 2045 line-length limit for base64 body content

let boundaryCounter = 0;

/**
 * Encode raw bytes as a base64 string. Works in both Node (20+) and the
 * browser without ever importing `node:buffer` — uses the global `Buffer`
 * when it happens to exist (Node), otherwise `btoa` (browser).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000; // avoid blowing the call stack on String.fromCharCode.apply
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  // eslint-disable-next-line no-undef -- btoa is a browser/Node 18+ global
  return btoa(binary);
}

/** UTF-8 encode a string, then base64-encode the bytes. */
function utf8ToBase64(str) {
  return bytesToBase64(new TextEncoder().encode(str));
}

/** Base64url-encode raw bytes (RFC 4648 §5): `+`→`-`, `/`→`_`, no padding. */
function base64url(bytes) {
  return bytesToBase64(bytes)
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
 * interpolated into a mail header — prevents header injection. Exported for
 * reuse elsewhere (e.g. an SMTP fallback in cli/desktop). */
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
  return `=?UTF-8?B?${utf8ToBase64(value)}?=`;
}

/**
 * Generate a MIME boundary that's unique-enough without relying on
 * cryptographic randomness (a boundary just needs to not collide with the
 * message content). Injectable `rand` (defaults to `Math.random`) plus a
 * module-level counter keep it unique across calls in the same process; pass
 * an explicit `boundary` to `buildMimeMessage` for deterministic tests.
 */
function defaultBoundary(rand = Math.random) {
  const rnd = rand().toString(36).slice(2) + rand().toString(36).slice(2);
  return `kindling_${Date.now().toString(36)}_${boundaryCounter++}_${rnd}`;
}

/**
 * Build the raw RFC-5322 MIME message (CRLF line endings) as a string.
 * @param {{from:string, to:string, subject:string, text?:string,
 *          attachment:Uint8Array, attachmentName:string, boundary?:string,
 *          rand?:()=>number}} params
 * @returns {string}
 */
export function buildMimeMessage({
  from,
  to,
  subject,
  text = DEFAULT_TEXT_BODY,
  attachment,
  attachmentName,
  boundary,
  rand,
}) {
  if (!from || !to)
    throw new Error('buildMimeMessage requires both "from" and "to".');
  if (!attachment || !attachmentName) {
    throw new Error(
      'buildMimeMessage requires "attachment" and "attachmentName".',
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

  const mimeBoundary = boundary || defaultBoundary(rand);

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject ?? "")}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mimeBoundary}"`,
    "",
    `--${mimeBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${mimeBoundary}`,
    "Content-Type: application/epub+zip",
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(bytesToBase64(attachment)),
    "",
    `--${mimeBoundary}--`,
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
  return base64url(new TextEncoder().encode(mimeString));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter. `rng` is injectable (defaults to
 * `Math.random`) so tests can make delays deterministic. */
function backoffMs(attempt, baseDelayMs, rng = Math.random) {
  return baseDelayMs * 2 ** attempt + rng() * baseDelayMs;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Create a Gmail-API-backed Sender (see `../ports.js`).
 * @param {{getToken:()=>Promise<string>, fetchImpl?:typeof fetch,
 *          maxAttempts?:number, baseDelayMs?:number, rng?:()=>number,
 *          boundary?:string}} deps
 * @returns {import('../ports.js').Sender}
 */
export function createGmailApiSender(deps) {
  const {
    getToken,
    fetchImpl = fetch,
    maxAttempts = 4,
    baseDelayMs = 500,
    rng = Math.random,
    boundary,
  } = deps || {};
  if (typeof getToken !== "function") {
    throw new Error("createGmailApiSender requires a getToken() function.");
  }

  return {
    /**
     * @param {import('../ports.js').OutgoingMail} mail
     * @returns {Promise<{id:string}>}
     */
    async send(mail) {
      const { to, from, subject, attachment, attachmentName, text } = mail;

      const mime = buildMimeMessage({
        from,
        to,
        subject,
        text,
        attachment,
        attachmentName,
        boundary,
        rand: rng,
      });
      const raw = encodeMessageBase64Url(mime);
      const accessToken = await getToken();
      if (!accessToken) {
        throw new Error("createGmailApiSender: getToken() returned no token.");
      }

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
          await sleep(backoffMs(attempt, baseDelayMs, rng));
          continue;
        }

        if (res.ok) {
          const data = await res.json();
          return { id: data.id };
        }

        const transient = res.status === 429 || res.status >= 500;
        if (transient && !isLastAttempt) {
          lastError = new Error(`HTTP ${res.status}`);
          await sleep(backoffMs(attempt, baseDelayMs, rng));
          continue;
        }

        const bodyText = await safeText(res);
        throw new Error(
          `Gmail send failed: HTTP ${res.status} ${bodyText}`.trim() +
            (transient ? ` (exhausted ${maxAttempts} attempts)` : ""),
        );
      }

      throw lastError || new Error("Gmail send failed for an unknown reason.");
    },
  };
}
