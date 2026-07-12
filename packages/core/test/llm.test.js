import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../src/llm/index.js";

const FAKE_KEY = "sk-test-do-not-use-1234567890";

/** Build a stub fetchImpl that records calls and returns a fixed response. */
function stubFetch({ status = 200, statusText = "OK", json, text } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: async () => {
        if (json === undefined) throw new Error("no json body configured");
        return json;
      },
      text: async () => (text !== undefined ? text : JSON.stringify(json ?? {})),
    };
  };
  return { fetchImpl, calls };
}

describe("createProvider", () => {
  test("returns null with no config", () => {
    assert.equal(createProvider(undefined), null);
  });

  test("returns null when apiKey is missing", () => {
    assert.equal(createProvider({ provider: "anthropic" }), null);
    assert.equal(createProvider({ provider: "anthropic", apiKey: "" }), null);
  });

  test("throws on unknown provider", () => {
    assert.throws(() => createProvider({ provider: "bogus", apiKey: "x" }));
  });

  test("openai-compatible without baseUrl throws", () => {
    assert.throws(() =>
      createProvider({ provider: "openai-compatible", apiKey: "x" }),
    );
  });
});

describe("AnthropicProvider", () => {
  test("summarize sends correct request shape and parses response", async () => {
    const { fetchImpl, calls } = stubFetch({
      json: { content: [{ text: "A tight summary." }] },
    });
    const provider = createProvider(
      { provider: "anthropic", apiKey: FAKE_KEY, model: "claude-3-5-haiku-latest" },
      { fetchImpl },
    );
    assert.ok(provider);

    const result = await provider.summarize("Some article text.", {
      maxWords: 80,
    });

    assert.equal(result, "A tight summary.");
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init.headers["x-api-key"], FAKE_KEY);
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    assert.equal(init.headers["anthropic-dangerous-direct-browser-access"], undefined);

    const body = JSON.parse(init.body);
    assert.equal(body.model, "claude-3-5-haiku-latest");
    assert.equal(body.messages[0].role, "user");
    assert.match(body.messages[0].content, /Some article text\./);
  });

  test("sends browser-access header only when browserDirect is set", async () => {
    const { fetchImpl, calls } = stubFetch({
      json: { content: [{ text: "ok" }] },
    });
    const provider = createProvider(
      { provider: "anthropic", apiKey: FAKE_KEY, browserDirect: true },
      { fetchImpl },
    );
    await provider.summarize("text");
    assert.equal(
      calls[0].init.headers["anthropic-dangerous-direct-browser-access"],
      "true",
    );
  });

  test("respects custom baseUrl", async () => {
    const { fetchImpl, calls } = stubFetch({
      json: { content: [{ text: "ok" }] },
    });
    const provider = createProvider(
      {
        provider: "anthropic",
        apiKey: FAKE_KEY,
        baseUrl: "https://proxy.example.com/",
      },
      { fetchImpl },
    );
    await provider.summarize("text");
    assert.equal(calls[0].url, "https://proxy.example.com/v1/messages");
  });

  test("info reflects provider/model and browserUsable=true", () => {
    const { fetchImpl } = stubFetch({});
    const provider = createProvider(
      { provider: "anthropic", apiKey: FAKE_KEY, model: "claude-x" },
      { fetchImpl },
    );
    assert.deepEqual(provider.info, {
      provider: "anthropic",
      model: "claude-x",
      browserUsable: true,
    });
  });

  test("classify parses a comma-separated list", async () => {
    const { fetchImpl } = stubFetch({
      json: { content: [{ text: "science, biology, genetics" }] },
    });
    const provider = createProvider(
      { provider: "anthropic", apiKey: FAKE_KEY },
      { fetchImpl },
    );
    const tags = await provider.classify("Some article about gene editing.");
    assert.deepEqual(tags, ["science", "biology", "genetics"]);
  });

  test("classify parses a JSON array response", async () => {
    const { fetchImpl } = stubFetch({
      json: { content: [{ text: '["dev", "javascript"]' }] },
    });
    const provider = createProvider(
      { provider: "anthropic", apiKey: FAKE_KEY },
      { fetchImpl },
    );
    const tags = await provider.classify("Some dev article.");
    assert.deepEqual(tags, ["dev", "javascript"]);
  });

  test("synthesize builds a narrative from items", async () => {
    const { fetchImpl, calls } = stubFetch({
      json: { content: [{ text: "You read a lot about science this month." }] },
    });
    const provider = createProvider(
      { provider: "anthropic", apiKey: FAKE_KEY },
      { fetchImpl },
    );
    const out = await provider.synthesize(
      [
        { title: "Article A", summary: "Summary A" },
        { title: "Article B", summary: "Summary B" },
      ],
      { period: "June 2026" },
    );
    assert.equal(out, "You read a lot about science this month.");
    const body = JSON.parse(calls[0].init.body);
    assert.match(body.messages[0].content, /June 2026/);
    assert.match(body.messages[0].content, /Article A/);
  });

  test("non-2xx response throws a clear, key-free error", async () => {
    const { fetchImpl } = stubFetch({
      status: 401,
      statusText: "Unauthorized",
      text: "invalid x-api-key",
    });
    const provider = createProvider(
      { provider: "anthropic", apiKey: FAKE_KEY },
      { fetchImpl },
    );
    await assert.rejects(
      () => provider.summarize("text"),
      (err) => {
        assert.match(err.message, /401/);
        assert.ok(!err.message.includes(FAKE_KEY));
        return true;
      },
    );
  });

  test("network error throws a clear, key-free error", async () => {
    const fetchImpl = async () => {
      throw new Error(`connection reset, key=${FAKE_KEY}`);
    };
    const provider = createProvider(
      { provider: "anthropic", apiKey: FAKE_KEY },
      { fetchImpl },
    );
    await assert.rejects(
      () => provider.summarize("text"),
      (err) => {
        assert.ok(!err.message.includes(FAKE_KEY));
        return true;
      },
    );
  });
});

describe("OpenAiCompatProvider", () => {
  test("summarize sends correct request shape and parses response", async () => {
    const { fetchImpl, calls } = stubFetch({
      json: { choices: [{ message: { content: "A tight summary." } }] },
    });
    const provider = createProvider(
      {
        provider: "openai-compatible",
        apiKey: FAKE_KEY,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      { fetchImpl },
    );
    const result = await provider.summarize("Some article text.");
    assert.equal(result, "A tight summary.");

    const { url, init } = calls[0];
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(init.headers.authorization, `Bearer ${FAKE_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-4o-mini");
  });

  test("classify parses a list from an OpenAI-compatible response", async () => {
    const { fetchImpl } = stubFetch({
      json: { choices: [{ message: { content: "news, politics" } }] },
    });
    const provider = createProvider(
      {
        provider: "openai-compatible",
        apiKey: FAKE_KEY,
        baseUrl: "http://localhost:11434/v1",
      },
      { fetchImpl },
    );
    const tags = await provider.classify("Some article.");
    assert.deepEqual(tags, ["news", "politics"]);
  });

  test("browserUsable is true for localhost (Ollama/LM Studio)", () => {
    const { fetchImpl } = stubFetch({});
    const provider = createProvider(
      {
        provider: "openai-compatible",
        apiKey: FAKE_KEY,
        baseUrl: "http://localhost:11434/v1",
      },
      { fetchImpl },
    );
    assert.equal(provider.info.browserUsable, true);
  });

  test("browserUsable is true for OpenRouter", () => {
    const { fetchImpl } = stubFetch({});
    const provider = createProvider(
      {
        provider: "openai-compatible",
        apiKey: FAKE_KEY,
        baseUrl: "https://openrouter.ai/api/v1",
      },
      { fetchImpl },
    );
    assert.equal(provider.info.browserUsable, true);
  });

  test("browserUsable is false for api.openai.com", () => {
    const { fetchImpl } = stubFetch({});
    const provider = createProvider(
      {
        provider: "openai-compatible",
        apiKey: FAKE_KEY,
        baseUrl: "https://api.openai.com/v1",
      },
      { fetchImpl },
    );
    assert.equal(provider.info.browserUsable, false);
  });

  test("non-2xx response throws a clear, key-free error", async () => {
    const { fetchImpl } = stubFetch({
      status: 429,
      statusText: "Too Many Requests",
      text: "rate limited",
    });
    const provider = createProvider(
      {
        provider: "openai-compatible",
        apiKey: FAKE_KEY,
        baseUrl: "https://api.openai.com/v1",
      },
      { fetchImpl },
    );
    await assert.rejects(
      () => provider.summarize("text"),
      (err) => {
        assert.match(err.message, /429/);
        assert.ok(!err.message.includes(FAKE_KEY));
        return true;
      },
    );
  });
});

describe("Gemini transport (free tier)", () => {
  test("returns null with no key", () => {
    assert.equal(createProvider({ provider: "gemini", apiKey: "" }), null);
  });

  test("summarize: correct URL, model, body shape; parses response", async () => {
    const { fetchImpl, calls } = stubFetch({
      json: { candidates: [{ content: { parts: [{ text: "a summary" }] } }] },
    });
    const p = createProvider(
      { provider: "gemini", apiKey: "AIza-secret-key" },
      { fetchImpl },
    );
    assert.deepEqual(p.info, { provider: "gemini", model: "gemini-2.5-flash-lite", browserUsable: true });
    const out = await p.summarize("some long article text");
    assert.equal(out, "a summary");
    const { url, init } = calls[0];
    assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash-lite:generateContent\?key=/);
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.contents[0].parts[0].text.length > 0, true);
    assert.equal(typeof body.generationConfig.maxOutputTokens, "number");
  });

  test("honors a custom model", async () => {
    const { fetchImpl, calls } = stubFetch({
      json: { candidates: [{ content: { parts: [{ text: "x" }] } }] },
    });
    const p = createProvider(
      { provider: "gemini", apiKey: "k", model: "gemini-2.5-flash" },
      { fetchImpl },
    );
    await p.summarize("t");
    assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent/);
    assert.equal(p.info.model, "gemini-2.5-flash");
  });

  test("an error (e.g. 429 free-tier limit) never leaks the api key", async () => {
    const { fetchImpl } = stubFetch({ status: 429, statusText: "Too Many Requests", text: "quota" });
    const p = createProvider(
      { provider: "gemini", apiKey: "AIza-SUPER-SECRET" },
      { fetchImpl },
    );
    await assert.rejects(p.summarize("t"), (err) => {
      assert.ok(!String(err.message).includes("AIza-SUPER-SECRET"), "key must not appear in the error");
      return true;
    });
  });
});
