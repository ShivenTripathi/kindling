// filter.js
//
// URL normalization, dedupe, and the shipped exclusion list + user block/allow
// rules. Pure functions — no I/O, no network. The only "config" this module
// consumes is the `FilterRules` object the caller passes in (from
// `src/config.js`'s `filters` field); it never reads files itself.

// ---- Tracking query params ------------------------------------------------
//
// These are exact param names (or prefixes, for `utm_*`) that carry no
// meaning for content identity — they're purely for the sender's analytics.
// Stripping them means two shares of the same article (e.g. one from a
// newsletter, one from a tweet) normalize to the same ledger key instead of
// being treated as different tabs.
const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_eid",
  "mc_cid",
  "ref",
  "ref_src",
  "refsrc",
  "igshid",
  "igsh",
  "si", // YouTube/Spotify share-link id
  "_hsenc",
  "_hsmi",
  "vero_id",
  "yclid",
  "ocid",
  "spm",
  "WT.mc_id",
  "CMP",
]);

function isTrackingParam(name) {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_NAMES.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Canonical form for ledger keys & dedupe: lowercased host, strip fragment,
 * strip common tracking params (utm_*, fbclid, gclid…), strip trailing slash.
 * @param {string} url
 * @returns {string} */
export function normalizeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable URL at all (relative path, garbage string, ...) —
    // hand the caller back exactly what they gave us rather than throwing,
    // since normalization is best-effort and callers may screen it out later.
    return url;
  }

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();

  // Strip tracking params, but keep everything else (query params can be
  // load-bearing, e.g. ?id=123 on a docs page or ?p=2 for pagination).
  const keptParams = [...parsed.searchParams.entries()].filter(
    ([name]) => !isTrackingParam(name),
  );
  parsed.search = "";
  for (const [name, value] of keptParams) {
    parsed.searchParams.append(name, value);
  }

  let result = parsed.toString();

  // Strip a single trailing slash from the path, but never collapse the
  // root ("https://example.com/" must stay "https://example.com/", since
  // stripping it would produce "https://example.com" which URL re-parses
  // identically anyway — but we normalize explicitly for clarity/stability).
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    const withoutTrailingSlash = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
    result = parsed.toString();
  }

  return result;
}

// ---- Default exclusion list -----------------------------------------------
//
// Domains that are structurally never "an article to read later" — grouped
// by WHY, so the list stays maintainable and additions land in the right
// bucket instead of being appended ad hoc.
export const DEFAULT_EXCLUSIONS = [
  // -- Social feeds / messaging: infinite-scroll apps, not documents. A
  // "tab" here is a live session, not a piece of content worth an EPUB page.
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "threads.net",
  "tiktok.com",
  "reddit.com", // individual posts are fine via extraction, but the feed/home is not — see docs/interfaces.md extract gate for per-page quality scoring instead of a blanket exclude on submatches
  "web.whatsapp.com",
  "messenger.com",
  "discord.com",
  "slack.com",
  "telegram.org",

  // -- Webmail / productivity apps: session-based UI, never a static
  // article; also frequently contains sensitive personal data we should
  // never risk pulling into a digest.
  "mail.google.com",
  "docs.google.com",
  "drive.google.com",
  "calendar.google.com",
  "sheets.google.com",
  "slides.google.com",
  "outlook.com",
  "outlook.office.com",
  "outlook.office365.com",
  "notion.so",
  "trello.com",
  "asana.com",
  "linear.app",
  "jira.atlassian.com",
  "atlassian.net",

  // -- Streaming / media players: the tab is a video/audio player, not
  // readable text; extraction would either fail or produce garbage.
  "netflix.com",
  "youtube.com",
  "youtu.be",
  "hulu.com",
  "disneyplus.com",
  "spotify.com",
  "twitch.tv",
  "primevideo.com",

  // -- Code hosting / dev tool app pages: PR/issue/dashboard UI is
  // app-like, not an article. (READMEs and gists are borderline —
  // excluded by default; users can `kindling allow github.com` if they
  // specifically want repo docs in digests.)
  "github.com",
  "gitlab.com",
  "bitbucket.org",

  // -- Financial / checkout: never appropriate to snapshot or extract —
  // session-bound, sensitive, and explicitly a workflow, not content.
  "checkout.stripe.com",
  "paypal.com",
  "venmo.com",
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "amazon.com", // cart/order pages — product pages aren't "articles" either
  "accounts.google.com",

  // -- Search results / app shells: a search results page or account
  // console is a UI, not a document to read.
  "google.com",
  "accounts.youtube.com",
];

// Any host containing "bank" as a path-safe token gets excluded generically
// (e.g. mybank.com, onlinebanking.chase.com) in addition to the explicit
// list above, since banking sites vary a lot by institution and we'd rather
// over-exclude than risk pulling financial data into a digest.
const BANK_HOST_PATTERN = /bank/i;

function isBankHost(hostname) {
  return BANK_HOST_PATTERN.test(hostname);
}

// Strip the `[...]` wrapper the WHATWG URL parser puts around IPv6 literal
// hostnames, so the IP helpers below see a bare address string.
function stripIpv6Brackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLocalHost(hostname) {
  const h = stripIpv6Brackets(hostname);
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (h.endsWith(".local")) return true;
  return false;
}

// True for a private/loopback/link-local IPv4 address given its four octets.
function isPrivateIpv4(o1, o2) {
  if (o1 === 0) return true; // 0.0.0.0/8 — "this host"/any-interface, routes to loopback
  if (o1 === 10) return true;
  if (o1 === 127) return true; // loopback
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 169 && o2 === 254) return true; // link-local
  return false;
}

// RFC 1918 private ranges + loopback + 0.0.0.0/8 + link-local (169.254/16) +
// IPv6 loopback (::1), unique-local (fc00::/7), link-local (fe80::/10), and
// IPv4-mapped IPv6 (::ffff:a.b.c.d) which can smuggle a loopback/private v4.
function isPrivateOrLinkLocalIp(hostname) {
  const h = stripIpv6Brackets(hostname).toLowerCase();

  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [o1, o2] = ipv4.slice(1).map(Number);
    return isPrivateIpv4(o1, o2);
  }

  // IPv4-mapped IPv6: dotted form (::ffff:127.0.0.1) or the hex form the URL
  // parser canonicalizes to (::ffff:7f00:1). Extract the embedded v4 and check.
  const mappedDotted = h.match(
    /::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (mappedDotted) {
    const [o1, o2] = mappedDotted.slice(1).map(Number);
    return isPrivateIpv4(o1, o2);
  }
  const mappedHex = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    // The high 16 bits carry the first two IPv4 octets, which is all
    // isPrivateIpv4 needs to classify the range.
    const hi = parseInt(mappedHex[1], 16);
    const o1 = (hi >> 8) & 0xff;
    const o2 = hi & 0xff;
    return isPrivateIpv4(o1, o2);
  }

  if (h.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return false;
}

/**
 * @typedef {Object} FilterRules
 * @property {string[]} [block]  // extra domains to exclude
 * @property {string[]} [allow]  // domains to force-include even if in defaults
 */

// True if `hostname` is `domain` or a subdomain of it (suffix match on
// dot boundaries — "news.ycombinator.com" matches "ycombinator.com" but
// "notycombinator.com" does not).
function hostMatchesDomain(hostname, domain) {
  const h = hostname.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith("." + d);
}

function matchesAnyDomain(hostname, domains) {
  return domains.some((domain) => hostMatchesDomain(hostname, domain));
}

/** Should this URL be considered for sending (pre-extraction gate)?
 * Excludes non-http(s), localhost/private IPs, and blocked domains.
 * @param {string} url
 * @param {FilterRules} [rules]
 * @returns {{include:boolean, reason:string}} */
export function screenUrl(url, rules = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { include: false, reason: "not a web page" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { include: false, reason: "not a web page" };
  }

  // A trailing dot denotes an equivalent fully-qualified name to a resolver
  // (`facebook.com.` == `facebook.com`), so strip it before any host check —
  // otherwise it silently bypasses the exclusion/block list.
  const hostname = parsed.hostname.replace(/\.$/, "");

  if (isLocalHost(hostname) || isPrivateOrLinkLocalIp(hostname)) {
    return { include: false, reason: "local/private address" };
  }

  const allow = rules.allow || [];
  if (matchesAnyDomain(hostname, allow)) {
    return { include: true, reason: "allowed by user rule" };
  }

  if (isBankHost(hostname)) {
    return { include: false, reason: "excluded domain: banking site" };
  }

  const block = [...DEFAULT_EXCLUSIONS, ...(rules.block || [])];
  const matched = block.find((domain) => hostMatchesDomain(hostname, domain));
  if (matched) {
    return { include: false, reason: `excluded domain: ${matched}` };
  }

  return { include: true, reason: "ok" };
}

/** Dedupe a list of URLs by normalized form, preserving first occurrence.
 * @param {string[]} urls
 * @returns {string[]} */
export function dedupe(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(url);
  }
  return result;
}
