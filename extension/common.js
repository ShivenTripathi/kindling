// common.js
//
// Small pure-function helpers shared by background.js, popup/popup.js and
// history/history.js. Deliberately dependency-free (no bundler, no build
// step — Web Store review reads exactly the source you see here) and kept
// in lockstep, conceptually, with src/filter.js's normalizeUrl() and
// src/ledger.js's Ledger shape, so the extension's local ledger-analogue
// reads the same way the CLI's does even though the two runtimes can't
// share code (one is a browser service worker, the other Node).

// Mirrors src/filter.js's TRACKING_PARAM_* lists closely enough to dedupe
// the same "same article, different share link" cases the CLI handles.
const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_NAMES = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_eid', 'mc_cid',
  'ref', 'ref_src', 'refsrc', 'igshid', 'igsh', 'si',
  '_hsenc', '_hsmi', 'vero_id', 'yclid', 'ocid', 'spm',
  'wt.mc_id', 'cmp',
]);

function isTrackingParam(name) {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_NAMES.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Canonical form used as the storage key: lowercased host, no fragment,
 * no tracking params, no trailing slash.
 * @param {string} url
 * @returns {string} */
export function normalizeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();

  const kept = [...parsed.searchParams.entries()].filter(([name]) => !isTrackingParam(name));
  parsed.search = '';
  for (const [name, value] of kept) parsed.searchParams.append(name, value);

  let out = parsed.toString();
  if (out.endsWith('/') && parsed.pathname === '/' && !parsed.search) {
    out = out.replace(/\/$/, '');
  } else if (out.endsWith('/') && parsed.search === '') {
    out = out.replace(/\/$/, '');
  }
  return out;
}

/** Only http(s) pages are trackable/sendable — chrome://, file://, etc. are excluded.
 * @param {string} url
 * @returns {boolean} */
export function isTrackableUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Mirror of src/filter.js's DEFAULT_EXCLUSIONS — app-like / sensitive domains
// that are never good digest material. KEEP IN SYNC with src/filter.js. The
// two runtimes (browser service worker vs. Node) can't share code, so this is
// duplicated deliberately. The native host re-applies the authoritative Node
// screen (src/filter.js screenUrl) before sending; this copy keeps such tabs
// from being tracked or offered in the popup in the first place.
const DEFAULT_EXCLUSIONS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
  'threads.net', 'tiktok.com', 'reddit.com', 'web.whatsapp.com', 'messenger.com',
  'discord.com', 'slack.com', 'telegram.org',
  'mail.google.com', 'docs.google.com', 'drive.google.com', 'calendar.google.com',
  'sheets.google.com', 'slides.google.com', 'outlook.com', 'outlook.office.com',
  'outlook.office365.com', 'notion.so', 'trello.com', 'asana.com', 'linear.app',
  'jira.atlassian.com', 'atlassian.net',
  'netflix.com', 'youtube.com', 'youtu.be', 'hulu.com', 'disneyplus.com',
  'spotify.com', 'twitch.tv', 'primevideo.com',
  'github.com', 'gitlab.com', 'bitbucket.org',
  'checkout.stripe.com', 'paypal.com', 'venmo.com', 'chase.com',
  'bankofamerica.com', 'wellsfargo.com', 'amazon.com', 'accounts.google.com',
  'google.com', 'accounts.youtube.com',
];

function hostMatchesDomain(hostname, domain) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase();
  return h === d || h.endsWith('.' + d);
}

function isLocalOrPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [o1, o2] = m.slice(1).map(Number);
    if (o1 === 0 || o1 === 10 || o1 === 127) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 169 && o2 === 254) return true;
  }
  if (h.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return false;
}

/** Whether a URL is worth tracking/offering as a Kindle candidate: an http(s)
 * page that isn't an excluded/sensitive/app domain or a local address. Mirrors
 * src/filter.js's screenUrl (the native host applies that authoritative gate
 * again before actually sending).
 * @param {string} url @returns {boolean} */
export function isSendableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/\.$/, '');
  if (isLocalOrPrivateHost(host)) return false;
  if (/bank/i.test(host)) return false;
  if (DEFAULT_EXCLUSIONS.some((d) => hostMatchesDomain(host, d))) return false;
  return true;
}

/** @param {string} url @returns {string} */
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Human age string like "3d", "5h", "12m" from a duration in ms.
 * @param {number} ms
 * @returns {string} */
export function formatAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** @param {number} hours @returns {number} */
export function hoursToMs(hours) {
  return hours * 60 * 60 * 1000;
}

/** A short, human digest id like "2026-07-08-a", matching src/cli.js's scheme.
 * @param {Date} date @param {number} suffixIndex @returns {string} */
export function digestId(date, suffixIndex) {
  const d = date.toISOString().slice(0, 10);
  return `${d}-${String.fromCharCode(97 + suffixIndex)}`;
}

export const DEFAULT_SETTINGS = {
  staleHours: 48,
  closeAfterSend: false,
};

export const STORAGE_KEY = 'kindling_state';

/** @returns {{tabs: Object, digests: Array, settings: typeof DEFAULT_SETTINGS}} */
export function emptyState() {
  return { tabs: {}, digests: [], settings: { ...DEFAULT_SETTINGS } };
}
