// test/native-host.test.js — unit tests for the native-messaging framing
// used by native-host/host.js (Chrome's 4-byte-little-endian-length-prefix
// + UTF-8 JSON protocol). Pure, no stdin/stdout involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeMessage,
  decodeMessages,
  createFrameAccumulator,
  MAX_MESSAGE_BYTES,
  FrameTooLargeError,
} from "../native-host/framing.js";

test("encodeMessage prefixes a 4-byte little-endian length", () => {
  const buf = encodeMessage({ hello: "world" });
  const json = JSON.stringify({ hello: "world" });
  assert.equal(buf.readUInt32LE(0), Buffer.byteLength(json, "utf8"));
  assert.equal(buf.subarray(4).toString("utf8"), json);
});

test("decodeMessages round-trips a single message", () => {
  const payload = {
    type: "sendTabs",
    items: [{ url: "https://example.com", title: "Example" }],
  };
  const encoded = encodeMessage(payload);
  const { messages, rest } = decodeMessages(encoded);
  assert.deepEqual(messages, [payload]);
  assert.equal(rest.length, 0);
});

test("decodeMessages parses multiple concatenated frames in one buffer", () => {
  const a = { type: "progress", message: "one" };
  const b = { type: "progress", message: "two" };
  const combined = Buffer.concat([encodeMessage(a), encodeMessage(b)]);
  const { messages, rest } = decodeMessages(combined);
  assert.deepEqual(messages, [a, b]);
  assert.equal(rest.length, 0);
});

test("decodeMessages leaves an incomplete trailing frame as `rest`", () => {
  const a = { type: "result", ok: true };
  const encodedA = encodeMessage(a);
  const encodedB = encodeMessage({
    type: "result",
    ok: false,
    error: "partial",
  });
  // Only feed half of the second message.
  const partial = Buffer.concat([
    encodedA,
    encodedB.subarray(0, encodedB.length - 3),
  ]);

  const { messages, rest } = decodeMessages(partial);
  assert.deepEqual(messages, [a]);
  assert.equal(rest.length, encodedB.length - 3);
});

test("decodeMessages waits when even the length header is incomplete", () => {
  const { messages, rest } = decodeMessages(Buffer.from([0x05, 0x00]));
  assert.deepEqual(messages, []);
  assert.equal(rest.length, 2);
});

test("createFrameAccumulator reassembles a message split across many small chunks", () => {
  const payload = {
    type: "sendTabs",
    items: new Array(20)
      .fill(0)
      .map((_, i) => ({ url: `https://x.test/${i}` })),
  };
  const encoded = encodeMessage(payload);

  const acc = createFrameAccumulator();
  const collected = [];
  // Feed it one byte at a time — the worst case for a streaming parser.
  for (let i = 0; i < encoded.length; i++) {
    collected.push(...acc.push(encoded.subarray(i, i + 1)));
  }

  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0], payload);
});

test("createFrameAccumulator handles two messages arriving back-to-back", () => {
  const a = { type: "progress", n: 1 };
  const b = { type: "progress", n: 2 };
  const acc = createFrameAccumulator();
  const collected = acc.push(
    Buffer.concat([encodeMessage(a), encodeMessage(b)]),
  );
  assert.deepEqual(collected, [a, b]);
});

test("decodeMessages round-trips non-ASCII content correctly (byte length, not char length)", () => {
  const payload = { title: "日本語のタイトル — café" };
  const encoded = encodeMessage(payload);
  const { messages } = decodeMessages(encoded);
  assert.deepEqual(messages, [payload]);
});

test("decodeMessages rejects a frame larger than MAX_MESSAGE_BYTES (DoS guard)", () => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0);
  assert.throws(() => decodeMessages(buf), FrameTooLargeError);
});

test("createFrameAccumulator throws on an oversized declared length", () => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(2 * 1024 * 1024 * 1024, 0); // claim 2GB
  const acc = createFrameAccumulator();
  assert.throws(() => acc.push(buf), FrameTooLargeError);
});
