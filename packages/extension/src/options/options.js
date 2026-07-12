// Kindling options page — settings bound to config via loadConfig/saveConfig.
import { getAuthToken, getAuthEmail, loadConfig, saveConfig } from "../adapters.js";

const $ = (id) => document.getElementById(id);

const els = {
  dashboardLink: $("dashboard-link"),
  form: $("settings-form"),
  kindleEmail: $("kindle-email"),
  senderEmail: $("sender-email"),
  reconnectGoogle: $("reconnect-google"),
  staleHours: $("stale-hours"),
  scheduleEnabled: $("schedule-enabled"),
  scheduleMinutes: $("schedule-minutes"),
  scheduleIntervalField: $("schedule-interval-field"),
  blockList: $("block-list"),
  allowList: $("allow-list"),
  disableWayback: $("disable-wayback"),
  llmProvider: $("llm-provider"),
  llmApiKey: $("llm-api-key"),
  llmBaseUrl: $("llm-base-url"),
  llmModel: $("llm-model"),
  saveBtn: $("save-btn"),
  savedConfirmation: $("saved-confirmation"),
  saveError: $("save-error"),
};

const DEFAULT_SCHEDULE_MINUTES = 360; // every 6h

let config = null;

els.dashboardLink.addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") }),
);

init();

async function init() {
  config = await loadConfig();
  populateForm(config);
  updateScheduleFieldVisibility();
}

function populateForm(cfg) {
  els.kindleEmail.value = cfg.kindleEmail || "";
  els.senderEmail.value = cfg.senderEmail || "";
  els.staleHours.value = cfg.staleHours ?? 48;

  els.scheduleEnabled.checked = !!cfg.scheduleEnabled;
  els.scheduleMinutes.value = cfg.scheduleMinutes || DEFAULT_SCHEDULE_MINUTES;

  const filters = cfg.filters || {};
  els.blockList.value = (filters.block || []).join("\n");
  els.allowList.value = (filters.allow || []).join("\n");

  els.disableWayback.checked = !!cfg.disableWayback;

  const llm = cfg.llm || {};
  els.llmProvider.value = llm.provider || "anthropic";
  els.llmApiKey.value = llm.apiKey || "";
  els.llmBaseUrl.value = llm.baseUrl || "";
  els.llmModel.value = llm.model || "";
}

function updateScheduleFieldVisibility() {
  els.scheduleIntervalField.style.display = els.scheduleEnabled.checked ? "" : "none";
}

els.scheduleEnabled.addEventListener("change", updateScheduleFieldVisibility);

els.reconnectGoogle.addEventListener("click", async () => {
  els.reconnectGoogle.disabled = true;
  const original = els.reconnectGoogle.textContent;
  els.reconnectGoogle.textContent = "Connecting…";
  try {
    await getAuthToken(true);
    const email = await getAuthEmail();
    if (email) els.senderEmail.value = email;
    showSaveError("");
  } catch (err) {
    showSaveError(`Couldn't connect to Google: ${(err && err.message) || err}`);
  } finally {
    els.reconnectGoogle.disabled = false;
    els.reconnectGoogle.textContent = original;
  }
});

function parseDomainList(text) {
  return text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

function isValidKindleEmail(value) {
  return /^[^\s@]+@(free\.)?kindle\.com$/.test(value.trim().toLowerCase());
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showSaveError("");
  els.savedConfirmation.hidden = true;

  const kindleEmail = els.kindleEmail.value.trim().toLowerCase();
  if (kindleEmail && !isValidKindleEmail(kindleEmail)) {
    showSaveError("The Kindle address should end in kindle.com or free.kindle.com.");
    els.kindleEmail.focus();
    return;
  }

  const staleHours = Number(els.staleHours.value);
  if (!Number.isFinite(staleHours) || staleHours <= 0) {
    showSaveError("“Send after” must be a positive number of hours.");
    els.staleHours.focus();
    return;
  }

  const scheduleEnabled = els.scheduleEnabled.checked;
  const scheduleMinutes = Number(els.scheduleMinutes.value) || DEFAULT_SCHEDULE_MINUTES;
  if (scheduleEnabled && scheduleMinutes < 15) {
    showSaveError("The schedule interval must be at least 15 minutes.");
    els.scheduleMinutes.focus();
    return;
  }

  const apiKey = els.llmApiKey.value.trim();
  const llm = apiKey
    ? {
        provider: els.llmProvider.value,
        apiKey,
        baseUrl: els.llmBaseUrl.value.trim() || undefined,
        model: els.llmModel.value.trim() || undefined,
      }
    : null;

  const next = {
    ...config,
    kindleEmail,
    senderEmail: els.senderEmail.value.trim(),
    staleHours,
    scheduleEnabled,
    scheduleMinutes,
    filters: {
      block: parseDomainList(els.blockList.value),
      allow: parseDomainList(els.allowList.value),
    },
    disableWayback: els.disableWayback.checked,
    llm,
  };

  els.saveBtn.disabled = true;
  els.saveBtn.textContent = "Saving…";
  try {
    await saveConfig(next);
    // Also tell the background service worker so tab tracking / badge / the
    // schedule pick up the change immediately.
    await chrome.runtime.sendMessage({ type: "SET_CONFIG", config: next }).catch(() => {});

    if (scheduleEnabled) {
      await chrome.runtime.sendMessage({ type: "SCHEDULE_INSTALL", everyMinutes: scheduleMinutes });
    } else {
      await chrome.runtime.sendMessage({ type: "SCHEDULE_UNINSTALL" });
    }

    config = next;
    els.savedConfirmation.hidden = false;
    window.clearTimeout(showSaveError._t);
    showSaveError._t = window.setTimeout(() => {
      els.savedConfirmation.hidden = true;
    }, 2500);
  } catch (err) {
    showSaveError(`Couldn't save: ${(err && err.message) || err}`);
  } finally {
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = "Save settings";
  }
});

function showSaveError(message) {
  if (!message) {
    els.saveError.hidden = true;
    els.saveError.textContent = "";
    return;
  }
  els.saveError.hidden = false;
  els.saveError.textContent = message;
}
