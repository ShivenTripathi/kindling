import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  loadConfig,
  saveConfig,
  defaultConfig,
  paths,
  validateConfig,
} from "../src/config.js";

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "kindling-config-test-"));
}

function validConfig(overrides = {}) {
  return {
    ...defaultConfig(),
    profileId: "Default",
    kindleEmail: "reader_abc123@kindle.com",
    senderEmail: "me@gmail.com",
    ...overrides,
  };
}

test("paths() returns XDG-style macOS paths under the real home dir", () => {
  const { configPath, ledgerPath, dataDir } = paths();
  const home = os.homedir();
  assert.equal(
    configPath,
    path.join(home, ".config", "kindling", "config.json"),
  );
  assert.equal(dataDir, path.join(home, ".local", "share", "kindling"));
  assert.equal(
    ledgerPath,
    path.join(home, ".local", "share", "kindling", "ledger.json"),
  );
});

test("defaultConfig() passes validation once user-specific fields are filled in", () => {
  const cfg = validConfig();
  assert.doesNotThrow(() => validateConfig(cfg));
});

test("saveConfig then loadConfig round-trips through a temp dir (never touches real config)", async (t) => {
  const dir = await makeTmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "nested", "config.json");

  const cfg = validConfig({ staleHours: 72 });
  await saveConfig(cfg, configPath);

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded, cfg);
});

test("saveConfig creates parent directories", async (t) => {
  const dir = await makeTmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "a", "b", "c", "config.json");

  await saveConfig(validConfig(), configPath);
  const stat = await fs.stat(configPath);
  assert.ok(stat.isFile());
});

test("saveConfig writes atomically (no leftover temp file, final file valid JSON)", async (t) => {
  const dir = await makeTmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");

  await saveConfig(validConfig(), configPath);

  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ["config.json"]);
  const raw = await fs.readFile(configPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("loadConfig throws an actionable error when the file is missing", async (t) => {
  const dir = await makeTmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "missing.json");

  await assert.rejects(
    () => loadConfig(configPath),
    /No config found.*kindling init/s,
  );
});

test("loadConfig throws on invalid JSON", async (t) => {
  const dir = await makeTmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, "{ not json", "utf8");

  await assert.rejects(() => loadConfig(configPath), /not valid JSON/);
});

test("rejects unknown top-level keys, naming the bad key", () => {
  const cfg = { ...validConfig(), extraField: "oops" };
  assert.throws(() => validateConfig(cfg), /Unknown config key "extraField"/);
});

test("rejects unknown filters sub-keys, naming the bad key", () => {
  const cfg = validConfig({ filters: { block: [], allow: [], deny: ["x"] } });
  assert.throws(() => validateConfig(cfg), /Unknown key "deny" in "filters"/);
});

test("rejects missing required fields", () => {
  const cfg = validConfig();
  delete cfg.staleHours;
  assert.throws(
    () => validateConfig(cfg),
    /Missing required config field "staleHours"/,
  );
});

test("rejects non-positive staleHours", () => {
  assert.throws(
    () => validateConfig(validConfig({ staleHours: 0 })),
    /"staleHours" must be a positive number/,
  );
  assert.throws(
    () => validateConfig(validConfig({ staleHours: -5 })),
    /"staleHours" must be a positive number/,
  );
  assert.throws(
    () => validateConfig(validConfig({ staleHours: "a lot" })),
    /"staleHours" must be a positive number/,
  );
});

test("rejects non-positive scheduleHours", () => {
  assert.throws(
    () => validateConfig(validConfig({ scheduleHours: 0 })),
    /"scheduleHours" must be a positive number/,
  );
});

test("rejects non-positive minWords", () => {
  assert.throws(
    () => validateConfig(validConfig({ minWords: -1 })),
    /"minWords" must be a positive number/,
  );
});

test("rejects an authMethod outside {oauth, smtp}", () => {
  assert.throws(
    () => validateConfig(validConfig({ authMethod: "imap" })),
    /"authMethod" must be "oauth" or "smtp"/,
  );
});

test("rejects a kindleEmail not on the kindle.com domain", () => {
  assert.throws(
    () => validateConfig(validConfig({ kindleEmail: "reader@gmail.com" })),
    /"kindleEmail" must be an @kindle\.com/,
  );
});

test("accepts free.kindle.com addresses", () => {
  assert.doesNotThrow(() =>
    validateConfig(validConfig({ kindleEmail: "reader_abc@free.kindle.com" })),
  );
});

test("rejects an invalid senderEmail", () => {
  assert.throws(
    () => validateConfig(validConfig({ senderEmail: "not-an-email" })),
    /"senderEmail" must be a valid email address/,
  );
});

test("rejects closeAfterSend that is not a boolean", () => {
  assert.throws(
    () => validateConfig(validConfig({ closeAfterSend: "false" })),
    /"closeAfterSend" must be a boolean/,
  );
});

test("rejects filters.block/allow entries that are not strings", () => {
  assert.throws(
    () =>
      validateConfig(validConfig({ filters: { block: [1, 2], allow: [] } })),
    /"filters\.block" must be an array of strings/,
  );
});

test("saveConfig rejects an invalid config before writing anything to disk", async (t) => {
  const dir = await makeTmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");

  await assert.rejects(() =>
    saveConfig(validConfig({ authMethod: "bogus" }), configPath),
  );
  await assert.rejects(() => fs.stat(configPath));
});
