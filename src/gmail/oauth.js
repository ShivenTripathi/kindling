// oauth.js
//
// OAuth2 loopback + PKCE flow for the `gmail.send` scope only (least
// privilege: this token can send mail and nothing else — it cannot read the
// inbox, list contacts, etc). Refresh tokens are persisted in the macOS
// Keychain via `./keychain.js`, never in a file or the repo.
//
// Deviation flagged for the integrator: to label the Keychain entry and show
// the user which account is connected (`kindling status`), we also need to
// learn the granted email address. Google only returns an `id_token` (or
// answers the userinfo endpoint with an address) if the `email` scope was
// requested alongside `gmail.send`. We request
// `https://www.googleapis.com/auth/gmail.send email` — the `email` scope
// only ever discloses the address itself, no additional Gmail/Drive/profile
// data — which we judge consistent with the "least-privilege secrets"
// invariant (that invariant is about avoiding a full-account password, not
// about suppressing the account's own address). If this is unacceptable,
// the alternative is to key the Keychain entry with an opaque local id
// instead of the email and skip the userinfo call entirely.
//
// Since `getAccessToken({clientId, clientSecret})` (per the interface
// contract) takes no account/email argument, we store one extra pointer
// entry in the Keychain — service "kindling", account "__default_account__"
// — whose "secret" is just the connected email address, so a later
// `getAccessToken` call (e.g. in a fresh process) can find which refresh
// token to use without the caller having to pass the email around.

import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as keychainDefault from "./keychain.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const SCOPE = `${GMAIL_SEND_SCOPE} email`;
const POINTER_ACCOUNT = "__default_account__";

// Default access-token lifetime assumption if Google omits `expires_in`
// (it never does in practice, but stay defensive).
const DEFAULT_TOKEN_TTL_MS = 3000 * 1000;
// Refresh a little early so callers never race an expiry.
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Derive the S256 PKCE code_challenge for a given verifier.
 * @param {string} verifier
 * @returns {string}
 */
export function deriveChallenge(verifier) {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

/**
 * Generate a fresh PKCE verifier/challenge pair (RFC 7636, S256).
 * @returns {{verifier: string, challenge: string}}
 */
export function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  return { verifier, challenge: deriveChallenge(verifier) };
}

/**
 * Build the Google consent screen URL.
 * @param {{clientId:string, redirectUri:string, state:string, codeChallenge:string}} params
 * @returns {string}
 */
export function buildAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Parse the loopback redirect request for `code`/`error`/`state`.
 * @param {string} reqUrl
 * @returns {{code: string|null, error: string|null, state: string|null}}
 */
export function parseCallback(reqUrl) {
  const url = new URL(reqUrl, "http://127.0.0.1");
  return {
    code: url.searchParams.get("code"),
    error: url.searchParams.get("error"),
    state: url.searchParams.get("state"),
  };
}

const SUCCESS_PAGE = `<!doctype html><html><head><title>Kindling connected</title></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;margin-top:15vh">
<h1>Kindling is connected</h1><p>You can close this tab and return to the terminal.</p>
</body></html>`;

function deniedPage(message) {
  return `<!doctype html><html><head><title>Kindling not connected</title></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;margin-top:15vh">
<h1>Kindling was not connected</h1><p>${message}</p><p>You can close this tab.</p>
</body></html>`;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Exchange an authorization code for tokens.
 * @param {{clientId:string, clientSecret:string, code:string, verifier:string,
 *          redirectUri:string, fetchImpl?: typeof fetch}} params
 * @returns {Promise<{access_token:string, refresh_token?:string, id_token?:string, expires_in?:number}>}
 */
export async function exchangeCodeForTokens({
  clientId,
  clientSecret,
  code,
  verifier,
  redirectUri,
  fetchImpl = fetch,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Google token exchange failed: HTTP ${res.status} ${await safeText(res)}`,
    );
  }
  return res.json();
}

/**
 * Refresh an access token using a stored refresh token.
 * @param {{clientId:string, clientSecret:string, refreshToken:string, fetchImpl?: typeof fetch}} params
 * @returns {Promise<{access_token:string, expires_in?:number}>}
 */
export async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Google token refresh failed: HTTP ${res.status} ${await safeText(res)}. ` +
        "Run `kindling init` to reconnect your Google account.",
    );
  }
  return res.json();
}

function decodeEmailFromIdToken(idToken) {
  try {
    const payload = idToken.split(".")[1];
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return JSON.parse(json).email ?? null;
  } catch {
    return null;
  }
}

async function fetchUserInfoEmail(accessToken, fetchImpl) {
  const res = await fetchImpl(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.email ?? null;
}

function openBrowser(url, opener) {
  if (opener) return opener(url);
  return new Promise((resolve, reject) => {
    execFile("open", [url], (err) => (err ? reject(err) : resolve()));
  });
}

function waitForCallback(server, expectedState) {
  return new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const { code, error, state } = parseCallback(req.url);
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(deniedPage(`Google reported: ${error}`));
        reject(
          Object.assign(new Error(`Consent was not granted (${error}).`), {
            code: "oauth_denied",
          }),
        );
        return;
      }
      // Reject any callback whose state doesn't match the one we generated.
      // Without this, a page the user has open could hit the loopback server
      // with its own authorization code and bind Kindling to the wrong account
      // (OAuth login-CSRF / code injection).
      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          deniedPage("State mismatch — ignoring an unexpected callback."),
        );
        reject(
          Object.assign(
            new Error("OAuth state mismatch; aborting for safety."),
            { code: "oauth_state_mismatch" },
          ),
        );
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(deniedPage("No authorization code was received."));
        reject(
          new Error("OAuth callback did not include an authorization code."),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_PAGE);
      resolve(code);
    });
    server.on("error", reject);
  });
}

/**
 * Run the one-time loopback+PKCE consent flow, store the refresh token in
 * Keychain, and return the granted account email.
 * @param {{clientId:string, clientSecret:string}} client
 * @param {{fetchImpl?: typeof fetch, opener?: (url:string)=>Promise<void>,
 *          keychain?: typeof keychainDefault, port?: number}} [deps] injection seam for tests
 * @returns {Promise<{email:string}>}
 */
export async function authorize(client, deps = {}) {
  const { clientId, clientSecret } = client;
  if (!clientId || !clientSecret) {
    throw new Error("authorize() requires both clientId and clientSecret.");
  }
  const {
    fetchImpl = fetch,
    opener,
    keychain = keychainDefault,
    port = 0,
  } = deps;

  const { verifier, challenge } = generatePkce();
  const state = base64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback server failed to bind to a TCP port.");
  }
  const actualPort = address.port;
  const redirectUri = `http://127.0.0.1:${actualPort}`;

  const authUrl = buildAuthUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
  });
  const callbackPromise = waitForCallback(server, state);

  let code;
  try {
    // Await both together so `callbackPromise`'s handler is attached
    // immediately — otherwise a callback that arrives while we're still
    // awaiting the browser open would momentarily be an unhandled rejection.
    [, code] = await Promise.all([
      openBrowser(authUrl, opener),
      callbackPromise,
    ]);
  } catch (err) {
    if (err.code === "oauth_denied") {
      throw new Error(
        "Google consent was denied — Kindling was not granted permission to send mail. Run `kindling init` again to retry.",
      );
    }
    throw err;
  } finally {
    server.close();
  }

  const tokens = await exchangeCodeForTokens({
    clientId,
    clientSecret,
    code,
    verifier,
    redirectUri,
    fetchImpl,
  });

  let email = tokens.id_token ? decodeEmailFromIdToken(tokens.id_token) : null;
  if (!email) {
    email = await fetchUserInfoEmail(tokens.access_token, fetchImpl);
  }
  if (!email) {
    throw new Error(
      "Could not determine the granted Google account email from the OAuth response.",
    );
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token (this usually means the account already granted access once). " +
        "Revoke prior access at https://myaccount.google.com/permissions and run `kindling init` again.",
    );
  }

  await keychain.setSecret(email, tokens.refresh_token);
  await keychain.setSecret(POINTER_ACCOUNT, email);

  return { email };
}

/** @type {Map<string, {accessToken: string, expiresAt: number}>} */
const tokenCache = new Map();

/**
 * Get a valid access token, refreshing silently using the stored refresh
 * token. Caches the access token in-memory until shortly before it expires.
 * @param {{clientId:string, clientSecret:string}} client
 * @param {{fetchImpl?: typeof fetch, keychain?: typeof keychainDefault, now?: () => number}} [deps]
 * @returns {Promise<string>}
 */
export async function getAccessToken(client, deps = {}) {
  const { clientId, clientSecret } = client;
  if (!clientId || !clientSecret) {
    throw new Error(
      "getAccessToken() requires both clientId and clientSecret.",
    );
  }
  const {
    fetchImpl = fetch,
    keychain = keychainDefault,
    now = () => Date.now(),
  } = deps;

  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > now() + EXPIRY_SAFETY_MARGIN_MS) {
    return cached.accessToken;
  }

  const email = await keychain.getSecret(POINTER_ACCOUNT);
  if (!email) {
    throw new Error(
      "No Google account connected yet. Run `kindling init` to connect your Google account.",
    );
  }
  const refreshToken = await keychain.getSecret(email);
  if (!refreshToken) {
    throw new Error(
      "No stored Google refresh token found. Run `kindling init` to connect your Google account.",
    );
  }

  const tokens = await refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken,
    fetchImpl,
  });
  const ttlMs = tokens.expires_in
    ? tokens.expires_in * 1000
    : DEFAULT_TOKEN_TTL_MS;
  tokenCache.set(clientId, {
    accessToken: tokens.access_token,
    expiresAt: now() + ttlMs,
  });
  return tokens.access_token;
}

/** Test-only: clear the in-memory access-token cache. */
export function _clearAccessTokenCache() {
  tokenCache.clear();
}

export const __internal = { POINTER_ACCOUNT, SCOPE, decodeEmailFromIdToken };
