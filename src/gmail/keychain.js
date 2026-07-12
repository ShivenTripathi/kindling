// keychain.js
//
// Thin wrappers over the macOS `security` CLI for storing OAuth refresh
// tokens / SMTP app passwords. Always uses `execFile` with an argv array —
// never a shell string — so a secret or account name can never be
// interpreted as shell syntax (no injection surface).
//
// Service name is always "kindling". Secrets are never logged and never appear
// in this process's argv: `setSecret` passes the secret to `security` over
// STDIN (the `-w` flag with no value makes `add-generic-password` prompt for
// it), so it is invisible to `ps`, and — critically — can never end up in a
// child-process error message (Node echoes the full argv in execFile errors),
// which on a locked keychain / SSH / disk-full failure would otherwise print
// the credential to the terminal. Secrets never touch a file, env var, or
// shell history.

import { spawn } from "node:child_process";

const SERVICE = "kindling";
const SECURITY_BIN = "/usr/bin/security";

// macOS `security` exits with this status when an item is not present in the
// keychain (errSecItemNotFound / -25300, surfaced by the CLI as status 44).
const NOT_FOUND_CODE = 44;

/**
 * @typedef {(args: string[], input?: string) => Promise<{stdout: string, stderr: string}>} SecurityRunner
 */

/**
 * Default runner: spawns the real `security` binary (argv array, no shell).
 * Optional `input` is written to the child's stdin (used to pass a secret
 * without ever placing it in argv). Error messages are constructed by us and
 * NEVER include argv or stdin, so a credential can't leak through an error.
 * @type {SecurityRunner}
 */
function defaultRunner(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      reject(new Error(`could not run security: ${err.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      // Build our own message — do NOT reuse Node's, which would contain argv.
      // stderr from `security` is safe (it describes the error, not the secret,
      // which only ever arrived via stdin).
      const wrapped = Object.assign(
        new Error(`security exited with code ${code}`),
        {
          code: typeof code === "number" ? code : undefined,
          stdout,
          stderr,
        },
      );
      reject(wrapped);
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function isNotFound(err) {
  if (!err) return false;
  if (err.code === NOT_FOUND_CODE) return true;
  const stderr = err.stderr || "";
  return /could not be found|item not found/i.test(stderr);
}

/**
 * Store (or overwrite) a secret under the "kindling" service.
 * @param {string} account
 * @param {string} secret
 * @param {SecurityRunner} [runner] injected for testing; defaults to the real `security` CLI
 * @returns {Promise<void>}
 */
export async function setSecret(account, secret, runner = defaultRunner) {
  if (!account) throw new Error("setSecret requires a non-empty account name.");
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("setSecret requires a non-empty secret string.");
  }
  // `-w` with NO value makes `security` prompt for the password on stdin
  // ("password data…" then "retype password…"), so we send it twice. The
  // secret never appears in argv.
  await runner(
    ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w"],
    `${secret}\n${secret}\n`,
  );
}

/**
 * Read a secret from the "kindling" service. Returns null if not found.
 * @param {string} account
 * @param {SecurityRunner} [runner]
 * @returns {Promise<string|null>}
 */
export async function getSecret(account, runner = defaultRunner) {
  if (!account) throw new Error("getSecret requires a non-empty account name.");
  try {
    const { stdout } = await runner([
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
    ]);
    return stdout.replace(/\r?\n$/, "");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new Error(
      `Keychain lookup failed for account "${account}": ${err.message}`,
    );
  }
}

/**
 * Delete a secret from the "kindling" service. No-op if it doesn't exist.
 * @param {string} account
 * @param {SecurityRunner} [runner]
 * @returns {Promise<void>}
 */
export async function deleteSecret(account, runner = defaultRunner) {
  if (!account)
    throw new Error("deleteSecret requires a non-empty account name.");
  try {
    await runner(["delete-generic-password", "-s", SERVICE, "-a", account]);
  } catch (err) {
    if (isNotFound(err)) return;
    throw new Error(
      `Keychain delete failed for account "${account}": ${err.message}`,
    );
  }
}

export const __internal = { SERVICE, isNotFound, defaultRunner };
