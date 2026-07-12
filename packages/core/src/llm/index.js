// src/llm/index.js — swappable LLM provider router.
//
// DESIGN PRINCIPLE (load-bearing, do not weaken): bring-your-own-key,
// local-only. The ONLY outbound network bytes this module ever sends go to
// the single endpoint named in the caller-supplied `config` (Anthropic's API,
// or an OpenAI-compatible endpoint the user configured — OpenAI, OpenRouter,
// a local Ollama/LM Studio server, etc). There is no Kindling server in the
// path, ever — this module talks directly from the user's machine/browser to
// the provider they chose, with the key they supplied.
//
// If no key is configured, `createProvider` returns `null` and callers fall
// back to local-only analysis (see src/insights/index.js's tagTopics, which
// needs no network at all).
//
// Browser-safe: no `node:*` imports. The only network primitive used is
// `fetch`, and even that is never called directly — it's always the
// `fetchImpl` passed in (or the global `fetch` as a default), so tests can
// inject a stub and never hit a real API.

/**
 * @typedef {Object} LlmConfig
 * @property {'anthropic'|'openai-compatible'} provider
 * @property {string} apiKey
 * @property {string} [baseUrl]   // openai-compatible: OpenAI/OpenRouter/Ollama/LM Studio; required for that transport
 * @property {string} [model]
 * @property {boolean} [browserDirect]  // set the Anthropic browser-access header
 */

/**
 * @typedef {Object} LlmProviderInfo
 * @property {string} provider
 * @property {string} model
 * @property {boolean} browserUsable
 */

/**
 * @typedef {Object} LlmProvider
 * @property {(text:string, opts?:{maxWords?:number}) => Promise<string>} summarize
 * @property {(text:string, opts?:{taxonomy?:string[]}) => Promise<string[]>} classify
 * @property {(items:{title:string,summary:string}[], opts?:{period?:string}) => Promise<string>} synthesize
 * @property {LlmProviderInfo} info
 */

// ---------------------------------------------------------------------------
// Constants — model defaults and prompts live here, in one place, so they're
// easy to audit and override. Every model default is overridable via
// `config.model`.

const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_OPENAI_COMPAT_MODEL = "gpt-4o-mini";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

// Cap input length before it's sent anywhere — keeps requests small/cheap and
// bounds worst-case payload size regardless of how large an article is.
const MAX_INPUT_CHARS = 12000;
const MAX_SYNTHESIZE_ITEMS = 40;

const MAX_TOKENS = {
  summarize: 400,
  classify: 120,
  synthesize: 700,
};

const PROMPTS = {
  summarize: (text, maxWords) =>
    `Summarize the following article in at most ${maxWords} words. ` +
    `Be concrete and information-dense; skip generic preamble like "This article discusses". ` +
    `Respond with only the summary text, no heading or quotes.\n\n---\n${text}`,

  classify: (text, taxonomy) =>
    `Assign 1-4 short topic tags to the following article text.` +
    (taxonomy && taxonomy.length
      ? ` Prefer tags from this taxonomy when they fit: ${taxonomy.join(", ")}. You may use a different tag if none fit.`
      : "") +
    ` Respond with ONLY a comma-separated list of lowercase tags (e.g. "science, biology"). ` +
    `No explanation, no numbering, no extra text.\n\n---\n${text}`,

  synthesize: (items, period) =>
    `Here is a list of articles someone read over ${period}, as JSON:\n\n` +
    `${JSON.stringify(items)}\n\n` +
    `Write a short (150-250 word), warm, specific narrative connecting what they read — ` +
    `note any recurring themes or threads across articles. This will be sent to their ` +
    `Kindle as part of a monthly reading digest. Respond with only the narrative text.`,
};

/** @param {string} text @param {number} [max] */
function truncate(text, max = MAX_INPUT_CHARS) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Parse a model's tag-list response into a clean string[]. Robust to a bare
 * comma-separated list, a JSON array, or a markdown/numbered variant.
 * @param {string} raw
 * @returns {string[]}
 */
function parseTagList(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];

  // Try JSON array first (some models wrap the list in JSON despite instructions).
  const jsonMatch = s.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const tags = parsed.map((t) => String(t).trim()).filter(Boolean);
        if (tags.length) return dedupeTags(tags);
      }
    } catch {
      // fall through to comma-splitting
    }
  }

  const tags = s
    .split(/[,\n]/)
    .map((t) =>
      t
        .replace(/^[\s\-*\d.)]+/, "") // strip bullets/numbering
        .replace(/["'.]+$/, "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

  return dedupeTags(tags);
}

/** @param {string[]} tags */
function dedupeTags(tags) {
  return [...new Set(tags)];
}

/**
 * Build a clear, key-free error from a failed HTTP response or network error.
 * Never includes the apiKey — only ever reads status/statusText/body text.
 * @param {string} providerName
 * @param {Response} [response]
 * @param {string} [bodyText]
 */
function httpError(providerName, response, bodyText) {
  if (response) {
    const snippet = (bodyText || "").slice(0, 300);
    return new Error(
      `${providerName} request failed: ${response.status} ${response.statusText}` +
        (snippet ? ` — ${snippet}` : ""),
    );
  }
  return new Error(`${providerName} request failed: network error`);
}

/**
 * @param {string} providerName
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<any>}
 */
async function postJson(providerName, fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    // Network-level failure (DNS, connection refused, CORS, etc). Never leak
    // the request init (which may contain the key) into the error message.
    throw httpError(providerName);
  }

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      // ignore — best-effort only
    }
    throw httpError(providerName, response, bodyText);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${providerName} request failed: invalid JSON response`);
  }
}

// ---------------------------------------------------------------------------
// Anthropic transport

/**
 * @param {LlmConfig} config
 * @param {typeof fetch} fetchImpl
 * @returns {LlmProvider}
 */
function createAnthropicProvider(config, fetchImpl) {
  const baseUrl = (config.baseUrl || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
  const model = config.model || DEFAULT_ANTHROPIC_MODEL;
  const url = `${baseUrl}/v1/messages`;

  /** @param {string} prompt @param {number} maxTokens */
  async function complete(prompt, maxTokens) {
    /** @type {Record<string,string>} */
    const headers = {
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
    if (config.browserDirect) {
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }

    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const json = await postJson("Anthropic", fetchImpl, url, {
      method: "POST",
      headers,
      body,
    });

    const text = json?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("Anthropic request failed: unexpected response shape");
    }
    return text;
  }

  return {
    async summarize(text, opts = {}) {
      const maxWords = opts.maxWords ?? 120;
      const prompt = PROMPTS.summarize(truncate(text), maxWords);
      const out = await complete(prompt, MAX_TOKENS.summarize);
      return out.trim();
    },
    async classify(text, opts = {}) {
      const prompt = PROMPTS.classify(truncate(text), opts.taxonomy);
      const out = await complete(prompt, MAX_TOKENS.classify);
      return parseTagList(out);
    },
    async synthesize(items, opts = {}) {
      const period = opts.period ?? "this month";
      const capped = (items ?? []).slice(0, MAX_SYNTHESIZE_ITEMS).map((i) => ({
        title: truncate(i.title, 200),
        summary: truncate(i.summary, 600),
      }));
      const prompt = PROMPTS.synthesize(capped, period);
      const out = await complete(prompt, MAX_TOKENS.synthesize);
      return out.trim();
    },
    info: { provider: "anthropic", model, browserUsable: true },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible transport (OpenAI, OpenRouter, Ollama, LM Studio, ...)

/**
 * Heuristic for whether an OpenAI-compatible baseUrl can be called directly
 * from a browser origin without hitting a CORS wall or leaking a hosted key:
 *   - localhost / 127.0.0.1 hosts (Ollama, LM Studio, any local server) — the
 *     request never leaves the machine, so it's always browser-usable.
 *   - openrouter.ai — publicly documented as CORS-friendly for browser use.
 *   - everything else (notably api.openai.com) — OpenAI's API does not send
 *     permissive CORS headers for browser-origin requests, so `false` here
 *     lets the UI route those calls through the desktop tier (a Node/Tauri
 *     process, not a Kindling server) instead of failing silently in-browser.
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isBrowserUsableOpenAiCompatHost(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
    return true;
  }
  return false;
}

/**
 * @param {LlmConfig} config
 * @param {typeof fetch} fetchImpl
 * @returns {LlmProvider}
 */
function createOpenAiCompatProvider(config, fetchImpl) {
  if (!config.baseUrl) {
    throw new Error(
      "openai-compatible provider requires config.baseUrl (e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://localhost:11434/v1)",
    );
  }
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const model = config.model || DEFAULT_OPENAI_COMPAT_MODEL;
  const url = `${baseUrl}/chat/completions`;

  /** @param {string} prompt @param {number} maxTokens */
  async function complete(prompt, maxTokens) {
    const headers = {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    };

    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const json = await postJson("OpenAI-compatible", fetchImpl, url, {
      method: "POST",
      headers,
      body,
    });

    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error(
        "OpenAI-compatible request failed: unexpected response shape",
      );
    }
    return text;
  }

  return {
    async summarize(text, opts = {}) {
      const maxWords = opts.maxWords ?? 120;
      const prompt = PROMPTS.summarize(truncate(text), maxWords);
      const out = await complete(prompt, MAX_TOKENS.summarize);
      return out.trim();
    },
    async classify(text, opts = {}) {
      const prompt = PROMPTS.classify(truncate(text), opts.taxonomy);
      const out = await complete(prompt, MAX_TOKENS.classify);
      return parseTagList(out);
    },
    async synthesize(items, opts = {}) {
      const period = opts.period ?? "this month";
      const capped = (items ?? []).slice(0, MAX_SYNTHESIZE_ITEMS).map((i) => ({
        title: truncate(i.title, 200),
        summary: truncate(i.summary, 600),
      }));
      const prompt = PROMPTS.synthesize(capped, period);
      const out = await complete(prompt, MAX_TOKENS.synthesize);
      return out.trim();
    },
    info: {
      provider: "openai-compatible",
      model,
      browserUsable: isBrowserUsableOpenAiCompatHost(baseUrl),
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point

/**
 * Create an LLM provider from user-supplied, bring-your-own-key config.
 *
 * Returns `null` when no key is configured — callers must treat that as "do
 * local-only analysis" (see src/insights/index.js's tagTopics), never as an
 * error. This is deliberate: Kindling has no server, so "no key" is the
 * default, expected state, not a failure.
 *
 * @param {LlmConfig} config
 * @param {{fetchImpl?: typeof fetch}} [deps]
 * @returns {LlmProvider|null}
 */
export function createProvider(config, deps = {}) {
  if (!config || !config.apiKey) return null;

  const fetchImpl = deps.fetchImpl || fetch;

  if (config.provider === "anthropic") {
    return createAnthropicProvider(config, fetchImpl);
  }
  if (config.provider === "openai-compatible") {
    return createOpenAiCompatProvider(config, fetchImpl);
  }
  throw new Error(`Unknown llm provider: ${String(config.provider)}`);
}
