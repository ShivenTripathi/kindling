#!/usr/bin/env node
// install.js — installs (or removes) the Chrome native-messaging host
// manifest for Kindling, on macOS.
//
// Usage:
//   node native-host/install.js <EXTENSION_ID>   # install/update
//   node native-host/install.js                  # install with a placeholder ID (fix later)
//   node native-host/install.js --uninstall       # remove the manifest
//
// Why a generated wrapper script instead of pointing straight at host.js:
// the native-messaging manifest's "path" field takes exactly one
// executable with no argument list, and GUI-launched Chrome often has a
// minimal PATH that may not include `node` (especially with nvm/volta).
// So this writes a tiny shell wrapper that hardcodes the absolute path to
// the Node binary that ran this installer (`process.execPath`) and to
// host.js, and points the manifest at that wrapper instead.

import { readFile, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST_NAME = "com.kindling.host";
const NATIVE_HOSTS_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts",
);
const MANIFEST_DEST = path.join(NATIVE_HOSTS_DIR, `${HOST_NAME}.json`);
const WRAPPER_PATH = path.join(__dirname, "run-host.sh");
const TEMPLATE_PATH = path.join(__dirname, "com.kindling.host.json");

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function writeWrapper() {
  const nodePath = process.execPath;
  const hostJsPath = path.join(__dirname, "host.js");
  const script = `#!/bin/bash\nexec "${nodePath}" "${hostJsPath}"\n`;
  await writeFile(WRAPPER_PATH, script, { mode: 0o755 });
  await chmod(WRAPPER_PATH, 0o755);
  return WRAPPER_PATH;
}

async function install(extensionId) {
  if (process.platform !== "darwin") {
    log(
      `This installer only knows the macOS NativeMessagingHosts path. On other`,
    );
    log(
      `platforms, see: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location`,
    );
    process.exitCode = 1;
    return;
  }

  const wrapperPath = await writeWrapper();
  log(`Wrote host wrapper: ${wrapperPath}`);

  const template = JSON.parse(await readFile(TEMPLATE_PATH, "utf8"));
  const manifest = {
    ...template,
    path: wrapperPath,
    allowed_origins: [
      `chrome-extension://${extensionId || "__EXTENSION_ID__"}/`,
    ],
  };

  await mkdir(NATIVE_HOSTS_DIR, { recursive: true });
  await writeFile(
    MANIFEST_DEST,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  log(`Wrote native-messaging host manifest: ${MANIFEST_DEST}`);

  if (!extensionId) {
    log("");
    log("⚠️  No extension ID given yet — the manifest above has a placeholder");
    log(
      "   allowed_origins entry and Chrome will refuse to connect until it is real.",
    );
  }

  log("");
  log("Next steps:");
  log("  1. Open chrome://extensions in Chrome.");
  log('  2. Enable "Developer mode" (top-right toggle).');
  log('  3. Click "Load unpacked" and select the extension/ directory:');
  log(`       ${path.join(__dirname, "..", "extension")}`);
  log("  4. Copy the extension ID shown on its card.");
  if (!extensionId) {
    log("  5. Re-run: node native-host/install.js <EXTENSION_ID>");
  } else {
    log(`  5. Confirm it matches what was just installed: ${extensionId}`);
  }
  log("");
  log(
    "Kindling never sends anything to a server — the native host runs locally",
  );
  log("and only reuses src/ (extract -> epub -> Gmail send -> ledger).");
}

async function uninstall() {
  try {
    await rm(MANIFEST_DEST, { force: true });
    log(`Removed ${MANIFEST_DEST}`);
  } catch (err) {
    log(`Could not remove ${MANIFEST_DEST}: ${err.message}`);
  }
  try {
    await rm(WRAPPER_PATH, { force: true });
    log(`Removed ${WRAPPER_PATH}`);
  } catch (err) {
    log(`Could not remove ${WRAPPER_PATH}: ${err.message}`);
  }
  log(
    "Native-messaging host uninstalled. The extension itself must be removed",
  );
  log("separately from chrome://extensions if you no longer want it.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--uninstall")) {
    await uninstall();
    return;
  }
  const extensionId = args.find((a) => !a.startsWith("--"));
  await install(extensionId);
}

main();
