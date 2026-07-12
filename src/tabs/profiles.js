// profiles.js
//
// Discover Chrome profiles on this machine and locate the newest session
// file for ONE explicitly-chosen profile.
//
// CRITICAL invariant (see CLAUDE.md #2 Profile isolation): only ONE
// explicitly-selected profile is ever read for tabs. `listProfiles` reads
// only metadata (`Local State`, each profile's `Preferences`) to let the user
// pick a profile - it never touches any profile's `Sessions/` directory.
// `readProfileTabs` then reads session data for exactly the one requested
// profile id, and nothing else.
//
// Chrome on macOS lays out profile data as:
//   ~/Library/Application Support/Google/Chrome/
//     Local State                 <- JSON, has profile.info_cache
//     Default/                    <- a profile dir
//       Preferences                <- JSON, may have account_info
//       Sessions/Session_<ts>       <- SNSS session files
//     Profile 1/
//       Preferences
//       Sessions/Session_<ts>
//     ...
//
// `Local State`'s `profile.info_cache` maps profile *directory name* (e.g.
// "Default", "Profile 1") to metadata including a human-readable `name` and
// (often) a `user_name` that is the signed-in account's email. Each profile's
// own `Preferences` file, when the profile is signed in to a Google account,
// additionally carries `account_info: [{ email, ... }]`, which is preferred
// when present since it's the more authoritative/live source.

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readOpenTabs } from "./snss.js";

/**
 * @typedef {Object} ChromeProfile
 * @property {string} id            // directory name, e.g. "Default", "Profile 1"
 * @property {string} displayName   // human name from Preferences, e.g. "Personal"
 * @property {string|null} email    // signed-in account email, if any
 * @property {string} path          // absolute path to the profile dir
 */

/** Default macOS location of Chrome's user data dir. */
function defaultChromeRoot() {
  return path.join(
    homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
}

/**
 * Best-effort read of a signed-in account email from a profile's
 * `Preferences` file. Returns null on any error or if not present - this is
 * metadata discovery, not a hard requirement.
 * @param {string} profilePath
 * @returns {Promise<string|null>}
 */
async function readAccountEmail(profilePath) {
  try {
    const raw = await readFile(path.join(profilePath, "Preferences"), "utf8");
    const prefs = JSON.parse(raw);
    const accountInfo = prefs && prefs.account_info;
    if (
      Array.isArray(accountInfo) &&
      accountInfo.length > 0 &&
      accountInfo[0].email
    ) {
      return accountInfo[0].email;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List available Chrome profiles on this machine (macOS paths).
 * Reads only `Local State` and each profile's `Preferences` (metadata) -
 * never a profile's `Sessions/` directory.
 * @param {string} [chromeRoot] override for testing
 * @returns {Promise<ChromeProfile[]>}
 */
export async function listProfiles(chromeRoot) {
  const root = chromeRoot || defaultChromeRoot();

  let localState;
  try {
    const raw = await readFile(path.join(root, "Local State"), "utf8");
    localState = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Unable to read Chrome's "Local State" file at ${path.join(root, "Local State")}. ` +
        `Is Chrome installed and has it been run at least once? (${err.message})`,
    );
  }

  const infoCache =
    localState && localState.profile && localState.profile.info_cache;
  if (!infoCache || typeof infoCache !== "object") {
    return [];
  }

  const profiles = [];
  for (const [id, info] of Object.entries(infoCache)) {
    const profilePath = path.join(root, id);
    const displayName = (info && (info.name || info.shortcut_name)) || id;
    const localStateEmail = (info && info.user_name) || null;
    const email =
      (await readAccountEmail(profilePath)) || localStateEmail || null;

    profiles.push({
      id,
      displayName,
      email,
      path: profilePath,
    });
  }

  return profiles;
}

/**
 * Absolute path to the newest current-session file for one profile.
 * @param {string} profilePath
 * @returns {Promise<string|null>}
 */
export async function newestSessionFile(profilePath) {
  const sessionsDir = path.join(profilePath, "Sessions");

  let entries;
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return null;
  }

  let newest = null;
  let newestMtime = -Infinity;
  for (const name of entries) {
    if (!name.startsWith("Session_")) continue;
    const full = path.join(sessionsDir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs > newestMtime) {
      newestMtime = st.mtimeMs;
      newest = full;
    }
  }

  return newest;
}

/**
 * Convenience: open tabs for exactly one profile (by id).
 * Never reads or touches any other profile's data.
 * @param {string} profileId
 * @param {string} [chromeRoot]
 * @returns {Promise<import('./snss.js').OpenTab[]>}
 */
export async function readProfileTabs(profileId, chromeRoot) {
  const root = chromeRoot || defaultChromeRoot();
  const profilePath = path.join(root, profileId);

  // Confirm the profile actually exists per Local State before reading
  // anything under its directory, so a typo'd profileId fails loudly with an
  // actionable message rather than silently reading nothing (or worse,
  // reading some other profile by accident).
  const profiles = await listProfiles(root);
  const match = profiles.find((p) => p.id === profileId);
  if (!match) {
    const known = profiles.map((p) => p.id).join(", ") || "(none found)";
    throw new Error(
      `Unknown Chrome profile "${profileId}" under ${root}. Known profiles: ${known}`,
    );
  }

  const sessionFile = await newestSessionFile(profilePath);
  if (!sessionFile) {
    throw new Error(
      `No session file found for profile "${profileId}" (looked in ${path.join(profilePath, "Sessions")}). ` +
        `Open Chrome with this profile at least once, then try again.`,
    );
  }

  return readOpenTabs(sessionFile);
}
