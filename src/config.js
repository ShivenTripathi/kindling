// config.js
//
// Load/validate `~/.config/kindling/config.json`. Unknown top-level keys are
// rejected with a helpful message naming the offending key (fail fast on
// typos rather than silently ignoring a misconfigured field). Writes are
// atomic (write to a temp file, then rename) and create parent dirs.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * @typedef {Object} Config
 * @property {string} profileId          // Chrome profile dir name
 * @property {string} kindleEmail        // kindle.com address
 * @property {string} senderEmail        // approved Gmail sender
 * @property {number} staleHours         // default 48
 * @property {'oauth'|'smtp'} authMethod // default 'oauth'
 * @property {{block:string[], allow:string[]}} filters
 * @property {number} minWords           // article gate, default 300
 * @property {boolean} closeAfterSend    // default false
 * @property {number} scheduleHours      // launchd interval, default 6
 * @property {boolean} [disableWayback]  // skip archive.org fallback, default false
 */

const REQUIRED_FIELDS = [
  "profileId",
  "kindleEmail",
  "senderEmail",
  "staleHours",
  "authMethod",
  "filters",
  "minWords",
  "closeAfterSend",
  "scheduleHours",
];

// Optional fields: allowed in config but not required (older configs without
// them still validate; defaults are supplied by defaultConfig).
const OPTIONAL_FIELDS = ["disableWayback"];
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const ALLOWED_FILTER_FIELDS = new Set(["block", "allow"]);

// Amazon's Send-to-Kindle addresses end in one of these domains. Anchored at
// both ends with a whitespace/@-free local part so a value like
// "reader\r\nBcc: attacker@evil.com@kindle.com" can't pass validation and
// smuggle CRLF into the To: header / SMTP RCPT line downstream.
const KINDLE_DOMAIN_RE =
  /^[^\s@]+@(?:[a-z0-9-]+\.)*(?:kindle\.com|free\.kindle\.com)$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve standard XDG-ish macOS paths for Kindling's on-disk state.
 * @returns {{configPath:string, ledgerPath:string, dataDir:string}}
 */
export function paths() {
  const home = os.homedir();
  const configPath = path.join(home, ".config", "kindling", "config.json");
  const dataDir = path.join(home, ".local", "share", "kindling");
  const ledgerPath = path.join(dataDir, "ledger.json");
  return { configPath, ledgerPath, dataDir };
}

/**
 * Default config values. Note: `profileId`, `kindleEmail`, and `senderEmail`
 * have no safe default (they're user/machine-specific) — `kindling init`
 * must fill them in before this passes validation.
 * @returns {Config}
 */
export function defaultConfig() {
  return {
    profileId: "Default",
    kindleEmail: "",
    senderEmail: "",
    staleHours: 48,
    authMethod: "oauth",
    filters: { block: [], allow: [] },
    minWords: 300,
    closeAfterSend: false,
    scheduleHours: 6,
    disableWayback: false,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Validate a config object. Throws an Error with an actionable message
 * (naming the specific bad/unknown field) on the first problem found.
 * @param {unknown} config
 * @returns {asserts config is Config}
 */
export function validateConfig(config) {
  if (!isPlainObject(config)) {
    throw new Error("Config must be a JSON object.");
  }

  for (const key of Object.keys(config)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(
        `Unknown config key "${key}". Allowed keys: ${[...ALLOWED_FIELDS].join(", ")}.`,
      );
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in config)) {
      throw new Error(`Missing required config field "${field}".`);
    }
  }

  if (typeof config.profileId !== "string" || config.profileId.length === 0) {
    throw new Error(
      '"profileId" must be a non-empty string (a Chrome profile directory name).',
    );
  }

  if (
    typeof config.kindleEmail !== "string" ||
    !KINDLE_DOMAIN_RE.test(config.kindleEmail)
  ) {
    throw new Error(
      `"kindleEmail" must be an @kindle.com (or @free.kindle.com) address, got "${config.kindleEmail}".`,
    );
  }

  if (
    typeof config.senderEmail !== "string" ||
    !EMAIL_RE.test(config.senderEmail)
  ) {
    throw new Error(
      `"senderEmail" must be a valid email address, got "${config.senderEmail}".`,
    );
  }

  if (!isPositiveNumber(config.staleHours)) {
    throw new Error(
      `"staleHours" must be a positive number, got ${JSON.stringify(config.staleHours)}.`,
    );
  }

  if (!isPositiveNumber(config.scheduleHours)) {
    throw new Error(
      `"scheduleHours" must be a positive number, got ${JSON.stringify(config.scheduleHours)}.`,
    );
  }

  if (config.authMethod !== "oauth" && config.authMethod !== "smtp") {
    throw new Error(
      `"authMethod" must be "oauth" or "smtp", got "${config.authMethod}".`,
    );
  }

  if (!isPlainObject(config.filters)) {
    throw new Error(
      '"filters" must be an object with "block" and "allow" string arrays.',
    );
  }
  for (const key of Object.keys(config.filters)) {
    if (!ALLOWED_FILTER_FIELDS.has(key)) {
      throw new Error(
        `Unknown key "${key}" in "filters". Allowed keys: block, allow.`,
      );
    }
  }
  for (const field of ["block", "allow"]) {
    const list = config.filters[field];
    if (
      !Array.isArray(list) ||
      !list.every((item) => typeof item === "string")
    ) {
      throw new Error(`"filters.${field}" must be an array of strings.`);
    }
  }

  if (!isPositiveNumber(config.minWords)) {
    throw new Error(
      `"minWords" must be a positive number, got ${JSON.stringify(config.minWords)}.`,
    );
  }

  if (
    "disableWayback" in config &&
    typeof config.disableWayback !== "boolean"
  ) {
    throw new Error('"disableWayback" must be a boolean.');
  }
  if (typeof config.closeAfterSend !== "boolean") {
    throw new Error('"closeAfterSend" must be a boolean.');
  }
}

/**
 * Load and validate the config from disk.
 * @param {string} [configPath] defaults to `paths().configPath`
 * @returns {Promise<Config>}
 */
export async function loadConfig(configPath) {
  const resolvedPath = configPath || paths().configPath;

  let raw;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `No config found at ${resolvedPath}. Run \`kindling init\` to create one.`,
      );
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Config at ${resolvedPath} is not valid JSON: ${err.message}`,
    );
  }

  validateConfig(parsed);
  return parsed;
}

/**
 * Validate and atomically persist a config to disk (creates parent dirs).
 * @param {Config} config
 * @param {string} [configPath] defaults to `paths().configPath`
 * @returns {Promise<void>}
 */
export async function saveConfig(config, configPath) {
  validateConfig(config);
  const resolvedPath = configPath || paths().configPath;

  // Owner-only dir + file: config holds the user's Kindle/sender addresses.
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });

  const tmpPath = path.join(
    path.dirname(resolvedPath),
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  // mode 0o600 on the temp file is preserved through the atomic rename.
  await fs.writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, resolvedPath);
}
