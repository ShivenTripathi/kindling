// framing.js
//
// Chrome's native-messaging wire format: each message is a 4-byte
// little-endian length prefix followed by that many bytes of UTF-8 JSON.
// Pure, dependency-free, and testable in isolation (see
// test/native-host.test.js) — host.js is just this wired up to stdin/stdout.

// Chrome's protocol permits browser→host frames up to 4GB. We refuse anything
// that large so a compromised/buggy extension (or a pathologically large
// captured DOM) can't force us to buffer gigabytes before JSON.parse — a local
// memory-exhaustion DoS. 64MB is far more than any URL list + rawHtml needs.
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Thrown when a declared or accumulated frame exceeds MAX_MESSAGE_BYTES. */
export class FrameTooLargeError extends Error {
  constructor(size) {
    super(
      `native message of ${size} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte limit`,
    );
    this.name = "FrameTooLargeError";
  }
}

/**
 * Encode one JSON-serializable value as a length-prefixed frame.
 * @param {unknown} value
 * @returns {Buffer}
 */
export function encodeMessage(value) {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Decode as many complete length-prefixed messages as are fully present in
 * `buffer`. Returns the parsed messages plus whatever trailing bytes remain
 * (an incomplete frame to be completed by the next chunk).
 * @param {Buffer} buffer
 * @returns {{messages: unknown[], rest: Buffer}}
 */
export function decodeMessages(buffer) {
  const messages = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const len = buffer.readUInt32LE(offset);
    if (len > MAX_MESSAGE_BYTES) throw new FrameTooLargeError(len); // refuse before buffering the body
    if (buffer.length - offset - 4 < len) break; // frame incomplete; wait for more data
    const jsonBuf = buffer.subarray(offset + 4, offset + 4 + len);
    messages.push(JSON.parse(jsonBuf.toString("utf8")));
    offset += 4 + len;
  }

  return { messages, rest: buffer.subarray(offset) };
}

/**
 * A small stateful helper wrapping decodeMessages for stream consumers:
 * feed it raw chunks, get back completed messages as they arrive.
 * @returns {{push:(chunk:Buffer)=>unknown[]}}
 */
export function createFrameAccumulator() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, rest } = decodeMessages(buffer);
      buffer = rest;
      return messages;
    },
  };
}
