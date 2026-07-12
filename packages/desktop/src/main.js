// main.js — the Kindling desktop app UI. Loads the Chrome profile list, reads
// open tabs from the on-disk session file, tracks staleness via the shared
// ledger, and runs the shared runDigest pipeline (extraction, EPUB build,
// SMTP send) with the Tauri adapters wired in as ports.

import { runDigest } from "@kindling/core";
import {
  loadLedger,
  saveLedger,
  recordSnapshot,
  selectStale,
} from "@kindling/core/ledger";
import {
  tabsAdapter,
  listChromeProfiles,
  makeContentSource,
  makeSmtpSender,
  storage,
  loadConfig,
  saveConfig,
} from "./adapters.js";

const $ = (id) => document.getElementById(id);

const els = {
  profileSelect: $("profile-select"),
  settingsBtn: $("settings-btn"),
  settingsClose: $("settings-close"),
  settingsPanel: $("settings-panel"),
  settingsBackdrop: $("settings-backdrop"),
  settingsForm: $("settings-form"),
  settingsSaved: $("settings-saved"),

  sProfileSelect: $("s-profile-select"),
  sKindleEmail: $("s-kindle-email"),
  sSenderEmail: $("s-sender-email"),
  sSmtpHost: $("s-smtp-host"),
  sSmtpPort: $("s-smtp-port"),
  sSmtpUsername: $("s-smtp-username"),
  sSmtpPassword: $("s-smtp-password"),
  sStaleHours: $("s-stale-hours"),
  sMinWords: $("s-min-words"),
  sIntervalMinutes: $("s-interval-minutes"),

  statusBanner: $("status-banner"),
  sendAllToggle: $("send-all-toggle"),
  refreshBtn: $("refresh-btn"),
  emptyView: $("empty-view"),
  loadingView: $("loading-view"),
  tabList: $("tab-list"),
  progressView: $("progress-view"),
  progressFill: $("progress-fill"),
  progressLabel: $("progress-label"),
  resultView: $("result-view"),
  countLabel: $("count-label"),
  sendBtn: $("send-btn"),
};

/** @type {typeof import('./adapters.js').DEFAULT_CONFIG} */
let config = null;
/** @type {{id:string,name:string,email:string|null}[]} */
let profiles = [];
/** @type {{url:string,title:string}[]} */
let openTabs = [];
/** Rows currently rendered: {url,title,domain,ageMs,selected} */
let rows = [];
let intervalHandle = null;
// Guards against overlapping sends (manual button vs. the auto-run timer, or a
// second timer tick firing before a slow run finishes) — which would otherwise
// double-send the same articles and race the ledger write.
let sendInFlight = false;

init().catch((err) =>
  showBanner(`Failed to start: ${err && err.message}`, "error"),
);

async function init() {
  config = await loadConfig();
  profiles = await safeListProfiles();
  populateProfileSelects();
  wireEvents();
  await refresh();
  armInterval();
}

async function safeListProfiles() {
  try {
    return await listChromeProfiles();
  } catch (err) {
    showBanner(
      `Could not list Chrome profiles: ${err && err.message}`,
      "error",
    );
    return [];
  }
}

function populateProfileSelects() {
  const options = profiles.length
    ? profiles
    : [
        {
          id: config.profileId || "Default",
          name: config.profileId || "Default",
          email: null,
        },
      ];
  for (const select of [els.profileSelect, els.sProfileSelect]) {
    select.innerHTML = "";
    for (const p of options) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.email ? `${p.name} (${p.email})` : p.name;
      select.appendChild(opt);
    }
    select.value = config.profileId;
  }
}

function wireEvents() {
  els.profileSelect.addEventListener("change", async () => {
    config.profileId = els.profileSelect.value;
    els.sProfileSelect.value = config.profileId;
    await saveConfig(config);
    await refresh();
  });

  els.refreshBtn.addEventListener("click", () => refresh());
  els.sendAllToggle.addEventListener("change", () => renderRows());

  els.settingsBtn.addEventListener("click", () => openSettings());
  els.settingsClose.addEventListener("click", () => closeSettings());
  els.settingsBackdrop.addEventListener("click", () => closeSettings());

  els.settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await onSaveSettings();
  });

  els.sendBtn.addEventListener("click", () => onSend());
}

function openSettings() {
  els.sKindleEmail.value = config.kindleEmail || "";
  els.sSenderEmail.value = config.senderEmail || "";
  els.sSmtpHost.value = config.smtp.host || "";
  els.sSmtpPort.value = config.smtp.port || "";
  els.sSmtpUsername.value = config.smtp.username || "";
  els.sSmtpPassword.value = config.smtp.password || "";
  els.sStaleHours.value = config.staleHours;
  els.sMinWords.value = config.minWords;
  els.sIntervalMinutes.value = config.intervalMinutes || 0;
  els.sProfileSelect.value = config.profileId;
  els.settingsSaved.hidden = true;
  els.settingsPanel.hidden = false;
  els.settingsBackdrop.hidden = false;
  els.settingsBtn.setAttribute("aria-expanded", "true");
}

function closeSettings() {
  els.settingsPanel.hidden = true;
  els.settingsBackdrop.hidden = true;
  els.settingsBtn.setAttribute("aria-expanded", "false");
}

async function onSaveSettings() {
  config = {
    ...config,
    profileId: els.sProfileSelect.value,
    kindleEmail: els.sKindleEmail.value.trim(),
    senderEmail: els.sSenderEmail.value.trim(),
    staleHours: Number(els.sStaleHours.value) || 48,
    minWords: Number(els.sMinWords.value) || 300,
    intervalMinutes: Number(els.sIntervalMinutes.value) || 0,
    smtp: {
      host: els.sSmtpHost.value.trim(),
      port: Number(els.sSmtpPort.value) || 465,
      username: els.sSmtpUsername.value.trim(),
      password: els.sSmtpPassword.value,
    },
  };
  await saveConfig(config);
  els.profileSelect.value = config.profileId;
  els.settingsSaved.hidden = false;
  armInterval();
  await refresh();
}

// ---------------------------------------------------------------------------
// Tab list
// ---------------------------------------------------------------------------

async function refresh() {
  setLoading(true);
  try {
    openTabs = await tabsAdapter.readOpenTabs(config.profileId);
  } catch (err) {
    openTabs = [];
    showBanner(`Could not read open tabs: ${err && err.message}`, "error");
    setLoading(false);
    renderRows();
    return;
  }

  let ledger = await loadLedger(storage);
  const now = new Date();
  ledger = recordSnapshot(
    ledger,
    openTabs.map((t) => ({ url: t.url, title: t.title })),
    now,
  );
  await saveLedger(storage, ledger);

  const staleUrls = new Set(selectStale(ledger, config.staleHours, now));

  rows = openTabs
    .filter((t) => staleUrls.has(normalize(t.url)) || els.sendAllToggle.checked)
    .map((t) => {
      const rec = ledger.tabs[normalize(t.url)];
      const ageMs = rec ? now.getTime() - new Date(rec.firstSeen).getTime() : 0;
      return {
        url: t.url,
        title: t.title || t.url,
        domain: domainOf(t.url),
        ageMs,
        stale: staleUrls.has(normalize(t.url)),
        selected: true,
      };
    });

  setLoading(false);
  renderRows();
}

function normalize(url) {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatAge(ms) {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h open`;
  const days = Math.floor(hours / 24);
  return `${days}d open`;
}

function setLoading(isLoading) {
  els.loadingView.hidden = !isLoading;
  if (isLoading) {
    els.tabList.hidden = true;
    els.emptyView.hidden = true;
  }
}

function renderRows() {
  const list = els.sendAllToggle.checked
    ? openTabs.map((t) => {
        const existing = rows.find((r) => r.url === t.url);
        return (
          existing || {
            url: t.url,
            title: t.title || t.url,
            domain: domainOf(t.url),
            ageMs: 0,
            stale: false,
            selected: true,
          }
        );
      })
    : rows.filter((r) => r.stale);

  rows = list;

  els.tabList.innerHTML = "";
  if (rows.length === 0) {
    els.tabList.hidden = true;
    els.emptyView.hidden = false;
    updateCount();
    return;
  }
  els.emptyView.hidden = true;
  els.tabList.hidden = false;

  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "tab-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = row.selected;
    checkbox.addEventListener("change", () => {
      row.selected = checkbox.checked;
      updateCount();
    });

    const body = document.createElement("div");
    body.className = "tab-item-body";

    const title = document.createElement("div");
    title.className = "tab-item-title";
    title.textContent = row.title;
    title.title = row.url;

    const meta = document.createElement("div");
    meta.className = "tab-item-meta";
    const domainSpan = document.createElement("span");
    domainSpan.textContent = row.domain;
    const ageSpan = document.createElement("span");
    ageSpan.textContent =
      els.sendAllToggle.checked && !row.stale ? "open" : formatAge(row.ageMs);
    meta.append(domainSpan, ageSpan);

    body.append(title, meta);
    li.append(checkbox, body);
    els.tabList.appendChild(li);
  }

  updateCount();
}

function updateCount() {
  const selected = rows.filter((r) => r.selected).length;
  els.countLabel.textContent = rows.length
    ? `${selected} of ${rows.length} selected`
    : "";
  els.sendBtn.disabled = selected === 0 || !config.kindleEmail;
}

function showBanner(message, kind) {
  els.statusBanner.hidden = false;
  els.statusBanner.textContent = message;
  els.statusBanner.className = `banner ${kind || ""}`.trim();
}

function hideBanner() {
  els.statusBanner.hidden = true;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function onSend() {
  const urls = rows.filter((r) => r.selected).map((r) => r.url);
  if (urls.length === 0) return;
  if (!config.kindleEmail) {
    showBanner("Set your Kindle email address in Settings first.", "error");
    openSettings();
    return;
  }
  if (sendInFlight) {
    showBanner("A send is already in progress.", "info");
    return;
  }
  sendInFlight = true;

  hideBanner();
  els.resultView.hidden = true;
  els.sendBtn.disabled = true;
  els.progressView.hidden = false;
  els.progressFill.style.width = "10%";
  els.progressLabel.textContent = `Fetching and building ${urls.length} article(s)…`;

  const ports = {
    content: makeContentSource(),
    sender: makeSmtpSender(config.smtp),
    storage,
  };

  try {
    const report = await runDigest({
      urls,
      ports,
      config: {
        kindleEmail: config.kindleEmail,
        senderEmail: config.senderEmail,
        staleHours: config.staleHours,
        minWords: config.minWords,
        filters: config.filters,
        title: "Kindling Digest",
      },
    });
    els.progressFill.style.width = "100%";
    els.progressLabel.textContent = "Done.";
    renderResult(report);
    if (report.sent.length > 0) {
      showBanner(
        `Sent ${report.sent.length} article(s) to ${config.kindleEmail}.`,
        "success",
      );
    } else {
      showBanner("Nothing was sent — see the results below.", "error");
    }
    await refresh();
  } catch (err) {
    showBanner(`Send failed: ${err && err.message}`, "error");
  } finally {
    sendInFlight = false;
    els.sendBtn.disabled = false;
    els.progressView.hidden = true;
    updateCount();
  }
}

function renderResult(report) {
  els.resultView.hidden = false;
  const parts = [];
  parts.push(`<div><strong>Sent:</strong> ${report.sent.length}</div>`);
  if (report.skipped.length) {
    parts.push(
      `<div><strong>Skipped (${report.skipped.length}):</strong><ul>${report.skipped
        .map((s) => `<li>${escapeHtml(s.url)} — ${escapeHtml(s.reason)}</li>`)
        .join("")}</ul></div>`,
    );
  }
  if (report.failed.length) {
    parts.push(
      `<div><strong>Failed (${report.failed.length}):</strong><ul>${report.failed
        .map((f) => `<li>${escapeHtml(f.url)} — ${escapeHtml(f.reason)}</li>`)
        .join("")}</ul></div>`,
    );
  }
  els.resultView.innerHTML = parts.join("");
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ---------------------------------------------------------------------------
// "Run now" on a timer, while the window is open. True background/autostart
// scheduling is a follow-up (Tauri autostart plugin + a tray icon); this
// in-window interval covers the case where the app is left running.
// ---------------------------------------------------------------------------

function armInterval() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  const minutes = config.intervalMinutes;
  if (!minutes || minutes <= 0) return;
  intervalHandle = setInterval(() => {
    runScheduled().catch((err) =>
      showBanner(`Scheduled run failed: ${err && err.message}`, "error"),
    );
  }, minutes * 60_000);
}

/** The scheduled path: snapshot the currently open tabs into the ledger and
 * send whatever has crossed the staleness threshold — no explicit selection
 * required, unlike the manual "Send to Kindle" button. */
async function runScheduled() {
  if (!config.kindleEmail) return;
  if (sendInFlight) return; // a manual or previous scheduled send is still running
  sendInFlight = true;
  try {
    const tabs = await tabsAdapter.readOpenTabs(config.profileId);
    const ports = {
      content: makeContentSource(),
      sender: makeSmtpSender(config.smtp),
      storage,
    };
    const report = await runDigest({
      openTabs: tabs,
      ports,
      config: {
        kindleEmail: config.kindleEmail,
        senderEmail: config.senderEmail,
        staleHours: config.staleHours,
        minWords: config.minWords,
        filters: config.filters,
        title: "Kindling Digest",
      },
    });
    if (report.sent.length > 0) {
      showBanner(`Auto-run: sent ${report.sent.length} article(s).`, "success");
    }
    await refresh();
  } finally {
    sendInFlight = false;
  }
}
