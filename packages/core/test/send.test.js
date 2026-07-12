import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createGmailApiSender,
  buildMimeMessage,
  encodeMessageBase64Url,
  bytesToBase64,
  assertNoCrlf,
} from "../src/send/index.js";

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function makeAttachment(bytes = [0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]) {
  return new Uint8Array(bytes);
}

function decodeRawToMime(raw) {
  // undo base64url -> base64 -> utf8 string, mirroring encodeMessageBase64Url
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function extractAttachmentBase64(mime) {
  const marker = "Content-Transfer-Encoding: base64\r\n\r\n";
  const start = mime.lastIndexOf(marker) + marker.length;
  const end = mime.indexOf("\r\n\r\n--", start);
  const boundaryLineEnd = mime.indexOf("\r\n--", start);
  const section = mime.slice(start, boundaryLineEnd);
  return section.replace(/\r\n/g, "");
}

describe("buildMimeMessage", () => {
  test("includes To/From/Subject/Content-Disposition filename and a base64 attachment part", () => {
    const attachment = makeAttachment();
    const mime = buildMimeMessage({
      from: "sender@example.com",
      to: "kindle@kindle.com",
      subject: "My Digest",
      attachment,
      attachmentName: "2026-07-12-a.epub",
      boundary: "fixedboundary",
    });

    assert.match(mime, /^From: sender@example\.com\r\n/);
    assert.match(mime, /To: kindle@kindle\.com\r\n/);
    assert.match(mime, /Subject: My Digest\r\n/);
    assert.match(
      mime,
      /Content-Disposition: attachment; filename="2026-07-12-a\.epub"/,
    );
    assert.match(mime, /Content-Type: application\/epub\+zip/);

    const b64 = extractAttachmentBase64(mime);
    const decoded = Buffer.from(b64, "base64");
    assert.deepEqual(new Uint8Array(decoded), attachment);
  });

  test("RFC-2047 encodes a non-ASCII subject", () => {
    const mime = buildMimeMessage({
      from: "sender@example.com",
      to: "kindle@kindle.com",
      subject: "Café Digest",
      attachment: makeAttachment(),
      attachmentName: "a.epub",
      boundary: "b",
    });
    assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  });

  test("rejects CRLF in to/from", () => {
    assert.throws(() =>
      buildMimeMessage({
        from: "sender@example.com\r\nBcc: evil@example.com",
        to: "kindle@kindle.com",
        subject: "x",
        attachment: makeAttachment(),
        attachmentName: "a.epub",
      }),
    );
    assert.throws(() =>
      buildMimeMessage({
        from: "sender@example.com",
        to: "kindle@kindle.com\r\nBcc: evil@example.com",
        subject: "x",
        attachment: makeAttachment(),
        attachmentName: "a.epub",
      }),
    );
  });

  test("rejects CRLF in attachmentName", () => {
    assert.throws(() =>
      buildMimeMessage({
        from: "sender@example.com",
        to: "kindle@kindle.com",
        subject: "x",
        attachment: makeAttachment(),
        attachmentName: "evil\r\nX-Injected: yes.epub",
      }),
    );
  });

  test("rejects quotes, semicolons, and backslashes in attachmentName", () => {
    for (const bad of ['evil".epub', "evil;x=1.epub", "evil\\path.epub"]) {
      assert.throws(() =>
        buildMimeMessage({
          from: "sender@example.com",
          to: "kindle@kindle.com",
          subject: "x",
          attachment: makeAttachment(),
          attachmentName: bad,
        }),
      );
    }
  });

  test("requires from/to and attachment/attachmentName", () => {
    assert.throws(() =>
      buildMimeMessage({
        to: "kindle@kindle.com",
        subject: "x",
        attachment: makeAttachment(),
        attachmentName: "a.epub",
      }),
    );
    assert.throws(() =>
      buildMimeMessage({
        from: "sender@example.com",
        to: "kindle@kindle.com",
        subject: "x",
        attachmentName: "a.epub",
      }),
    );
  });
});

describe("assertNoCrlf", () => {
  test("rejects control characters", () => {
    assert.throws(() => assertNoCrlf("a\r\nb", "field"));
  });
  test("allows clean strings", () => {
    assert.doesNotThrow(() => assertNoCrlf("clean value", "field"));
  });
});

describe("bytesToBase64 / encodeMessageBase64Url", () => {
  test("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const b64 = bytesToBase64(bytes);
    assert.deepEqual(new Uint8Array(Buffer.from(b64, "base64")), bytes);
  });

  test("produces a URL-safe, unpadded encoding of a mime string", () => {
    const raw = encodeMessageBase64Url("hello world >>> ??? +++ ///");
    assert.ok(!raw.includes("+"));
    assert.ok(!raw.includes("/"));
    assert.ok(!raw.includes("="));
    assert.equal(decodeRawToMime(raw), "hello world >>> ??? +++ ///");
  });
});

describe("createGmailApiSender", () => {
  const attachment = makeAttachment();
  const baseMail = {
    to: "kindle@kindle.com",
    from: "sender@example.com",
    subject: "Digest",
    attachment,
    attachmentName: "digest.epub",
  };

  test("posts to the Gmail send URL with a Bearer token and the raw message", async () => {
    let capturedUrl, capturedInit;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "msg-123" }),
      };
    };
    const sender = createGmailApiSender({
      getToken: async () => "test-access-token",
      fetchImpl,
    });

    const result = await sender.send(baseMail);

    assert.equal(result.id, "msg-123");
    assert.equal(capturedUrl, GMAIL_SEND_URL);
    assert.equal(capturedInit.method, "POST");
    assert.equal(
      capturedInit.headers.Authorization,
      "Bearer test-access-token",
    );
    const body = JSON.parse(capturedInit.body);
    assert.ok(typeof body.raw === "string" && body.raw.length > 0);

    const mime = decodeRawToMime(body.raw);
    assert.match(mime, /To: kindle@kindle\.com/);
    assert.match(mime, /From: sender@example\.com/);
    assert.match(mime, /Subject: Digest/);
    assert.match(
      mime,
      /Content-Disposition: attachment; filename="digest\.epub"/,
    );
    const b64 = extractAttachmentBase64(mime);
    assert.deepEqual(new Uint8Array(Buffer.from(b64, "base64")), attachment);
  });

  test("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) {
        return { ok: false, status: 429, text: async () => "rate limited" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ok-after-retry" }),
      };
    };
    const sender = createGmailApiSender({
      getToken: async () => "tok",
      fetchImpl,
      baseDelayMs: 1,
      rng: () => 0,
    });

    const result = await sender.send(baseMail);
    assert.equal(result.id, "ok-after-retry");
    assert.equal(calls, 3);
  });

  test("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 503, text: async () => "unavailable" };
      }
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) };
    };
    const sender = createGmailApiSender({
      getToken: async () => "tok",
      fetchImpl,
      baseDelayMs: 1,
      rng: () => 0,
    });

    const result = await sender.send(baseMail);
    assert.equal(result.id, "ok");
    assert.equal(calls, 2);
  });

  test("does not retry on a 4xx (non-429) error", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 400, text: async () => "bad request" };
    };
    const sender = createGmailApiSender({
      getToken: async () => "tok",
      fetchImpl,
      baseDelayMs: 1,
      rng: () => 0,
    });

    await assert.rejects(() => sender.send(baseMail), /HTTP 400/);
    assert.equal(calls, 1);
  });

  test("throws a clear error after exhausting retries", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 500, text: async () => "server error" };
    };
    const sender = createGmailApiSender({
      getToken: async () => "tok",
      fetchImpl,
      maxAttempts: 3,
      baseDelayMs: 1,
      rng: () => 0,
    });

    await assert.rejects(
      () => sender.send(baseMail),
      /Gmail send failed.*HTTP 500.*exhausted 3 attempts/s,
    );
    assert.equal(calls, 3);
  });

  test("throws a clear error after exhausted network-error retries", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error("ECONNRESET");
    };
    const sender = createGmailApiSender({
      getToken: async () => "tok",
      fetchImpl,
      maxAttempts: 2,
      baseDelayMs: 1,
      rng: () => 0,
    });

    await assert.rejects(
      () => sender.send(baseMail),
      /Gmail send failed after 2 attempts \(network error\)/,
    );
    assert.equal(calls, 2);
  });

  test("rejects mail with CRLF in the to/from/attachmentName before any fetch", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ id: "x" }) };
    };
    const sender = createGmailApiSender({
      getToken: async () => "tok",
      fetchImpl,
    });

    await assert.rejects(() =>
      sender.send({ ...baseMail, to: "kindle@kindle.com\r\nBcc: evil@x.com" }),
    );
    assert.equal(calls, 0);
  });

  test("rejects quote/semicolon in attachmentName before any fetch", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ id: "x" }) };
    };
    const sender = createGmailApiSender({
      getToken: async () => "tok",
      fetchImpl,
    });

    await assert.rejects(() =>
      sender.send({ ...baseMail, attachmentName: 'evil";x=1.epub' }),
    );
    assert.equal(calls, 0);
  });

  test("requires getToken to be a function", () => {
    assert.throws(() => createGmailApiSender({}));
  });
});
