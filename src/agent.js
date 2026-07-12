// launchd LaunchAgent management — schedules `kindling run` to fire every
// `scheduleHours` in the background, surviving reboots. macOS-only; no root.
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

export const LAUNCH_AGENT_LABEL = "com.kindling.agent";

/** Absolute path to the installed LaunchAgent plist. */
export function plistPath() {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LAUNCH_AGENT_LABEL}.plist`,
  );
}

/** Absolute path to this package's CLI entrypoint. */
function cliPath() {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/** Escape a string for safe interpolation into XML text content. A path with
 * `&`, `<`, or `>` (or a crafted `</string>…` sequence) would otherwise corrupt
 * the plist or inject additional keys that change what launchd executes. */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render the LaunchAgent plist XML.
 * @param {Object} o
 * @param {string} o.nodePath      absolute path to the node binary
 * @param {string} o.script        absolute path to cli.js
 * @param {number} o.intervalSec   seconds between runs
 * @param {string} o.logPath       stdout/stderr log file
 * @returns {string}
 */
export function renderPlist({ nodePath, script, intervalSec, logPath }) {
  const node = escapeXml(nodePath);
  const scriptPath = escapeXml(script);
  const log = escapeXml(logPath);
  const interval = Math.trunc(Number(intervalSec)); // integer seconds only
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${scriptPath}</string>
    <string>run</string>
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/**
 * Install (or reinstall) the LaunchAgent that runs `kindling run` on a timer.
 * @param {Object} opts
 * @param {number} opts.scheduleHours
 * @param {string} opts.logPath
 * @returns {Promise<{plist:string}>}
 */
export async function installAgent({ scheduleHours, logPath }) {
  const target = plistPath();
  const xml = renderPlist({
    nodePath: process.execPath,
    script: cliPath(),
    intervalSec: Math.max(1, Math.round(scheduleHours * 3600)),
    logPath,
  });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, xml, "utf8");

  // Reload: unload any prior instance (ignore errors), then load.
  await execFileAsync("launchctl", ["unload", target]).catch(() => {});
  await execFileAsync("launchctl", ["load", target]);
  return { plist: target };
}

/**
 * Uninstall the LaunchAgent.
 * @returns {Promise<{removed:boolean}>}
 */
export async function uninstallAgent() {
  const target = plistPath();
  await execFileAsync("launchctl", ["unload", target]).catch(() => {});
  try {
    await unlink(target);
    return { removed: true };
  } catch (err) {
    if (err && err.code === "ENOENT") return { removed: false };
    throw err;
  }
}
