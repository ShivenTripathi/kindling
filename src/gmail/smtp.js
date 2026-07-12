// smtp.js
//
// Documented, opt-in fallback for accounts that can't/won't use OAuth:
// SMTP-over-implicit-TLS to smtp.gmail.com:465, authenticated with a Gmail
// **app password** (never the account's real password) stored in Keychain.
//
// Dependency decision: implemented with node:tls only, no nodemailer.
// Justification — the CLAUDE.md quality bar says "prefer zero/small
// dependencies; justify each new one." This fallback only ever needs to
// speak to one server (smtp.gmail.com), over one transport (implicit TLS,
// port 465 — no STARTTLS negotiation to implement), with one auth mechanism
// (AUTH LOGIN, which Gmail always advertises). That is a small, stable
// surface — a hand-rolled client is under 150 lines and fully unit-testable
// against a fake socket, whereas nodemailer pulls in its own MIME builder,
// connection pool, DKIM/OAuth2 support, and multiple transport strategies
// we don't need (we already have a MIME builder in ./send.js shared with
// the Gmail API path). If this fallback ever needs to support arbitrary
// SMTP providers/mechanisms, nodemailer would become the better trade.

import tls from "node:tls";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import * as keychainDefault from "./keychain.js";
import { buildMimeMessage, assertNoCrlf } from "./send.js";

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;

function connectDefault(host, port) {
  return tls.connect({ host, port, servername: host });
}

/**
 * Read one complete SMTP response (possibly multi-line, e.g. "250-...\r\n250 ...")
 * from a socket, resolving once a line with a space (not `-`) after the code arrives.
 * @param {import('node:net').Socket} socket
 * @returns {Promise<{code:number, text:string}>}
 */
function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buf = "";
    function onData(chunk) {
      buf += chunk.toString("utf8");
      const lines = buf.split("\r\n").filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: buf });
      }
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/**
 * Send one command (a line, CRLF appended for you) and wait for the response.
 * @param {import('node:net').Socket} socket
 * @param {string} line
 * @returns {Promise<{code:number, text:string}>}
 */
function command(socket, line) {
  socket.write(`${line}\r\n`);
  return readResponse(socket);
}

async function expect(socket, line, expectedCode, label) {
  const res = await command(socket, line);
  if (res.code !== expectedCode) {
    throw new Error(
      `SMTP ${label || line.split(" ")[0]} failed: expected ${expectedCode}, got "${res.text.trim()}"`,
    );
  }
  return res;
}

/** Byte-stuff lines starting with "." per RFC 5321 section 4.5.2. */
function dotStuff(mimeString) {
  return mimeString
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

/**
 * @typedef {Object} SmtpSendOptions
 * @property {string} to
 * @property {string} from     // also the SMTP AUTH account and Keychain lookup key
 * @property {string} subject
 * @property {string} attachmentPath
 * @property {string} [attachmentName]
 * @property {string} [text]
 * @property {string} [account] // Keychain account for the app password; defaults to `from`
 * @property {typeof keychainDefault} [keychain] injection seam for tests
 * @property {(host:string, port:number) => import('node:net').Socket} [connect] injection seam for tests
 */

/**
 * Send an email with one attachment via SMTP-over-TLS using a Gmail app
 * password stored in Keychain. Opt-in fallback only (see docs) — OAuth is
 * the default send path.
 * @param {SmtpSendOptions} opts
 * @returns {Promise<{id:string}>}
 */
export async function sendMailSmtp(opts) {
  const {
    to,
    from,
    subject,
    attachmentPath,
    attachmentName,
    text = "Your Kindling digest is attached. Happy reading!",
    account = from,
    keychain = keychainDefault,
    connect = connectDefault,
  } = opts;

  if (!to || !from)
    throw new Error('sendMailSmtp requires both "to" and "from".');
  if (!attachmentPath)
    throw new Error("sendMailSmtp requires an attachmentPath.");
  // These go straight onto the SMTP wire (MAIL FROM / RCPT TO / AUTH) — reject
  // CRLF so they can't inject additional SMTP commands.
  assertNoCrlf(from, "from");
  assertNoCrlf(to, "to");
  assertNoCrlf(account, "account");

  const appPassword = await keychain.getSecret(account);
  if (!appPassword) {
    throw new Error(
      `No SMTP app password found in Keychain for "${account}". Generate one at ` +
        "https://myaccount.google.com/apppasswords and store it (see docs) before using the SMTP fallback.",
    );
  }

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

  const socket = connect(SMTP_HOST, SMTP_PORT);
  try {
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("connect", resolve); // fake sockets in tests may not emit secureConnect
      socket.once("error", reject);
    });

    await readResponse(socket); // greeting (220)
    await expect(socket, "EHLO localhost", 250, "EHLO");
    await expect(socket, "AUTH LOGIN", 334, "AUTH LOGIN");
    await expect(
      socket,
      Buffer.from(account, "utf8").toString("base64"),
      334,
      "AUTH username",
    );
    await expect(
      socket,
      Buffer.from(appPassword, "utf8").toString("base64"),
      235,
      "AUTH password",
    );
    await expect(socket, `MAIL FROM:<${from}>`, 250, "MAIL FROM");
    await expect(socket, `RCPT TO:<${to}>`, 250, "RCPT TO");
    await expect(socket, "DATA", 354, "DATA");

    socket.write(`${dotStuff(mime)}\r\n.\r\n`);
    const finalRes = await readResponse(socket);
    if (finalRes.code !== 250) {
      throw new Error(`SMTP message rejected: ${finalRes.text.trim()}`);
    }

    await command(socket, "QUIT");
    return { id: extractMessageId(finalRes.text) || randomUUID() };
  } finally {
    socket.end();
  }
}

function extractMessageId(responseText) {
  const match =
    responseText.match(/queued as ([^\s\r\n]+)/i) ||
    responseText.match(/([A-Za-z0-9]{10,})/);
  return match ? match[1] : null;
}

export const __internal = { readResponse, dotStuff, extractMessageId };
