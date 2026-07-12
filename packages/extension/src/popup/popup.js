// Kindling popup — the primary UX. Onboarding (first run) + the stale-tab
// list + the "send now" flow. Runs `runDigest` directly (this is a DOM
// context: DOMParser/XMLSerializer are available as globals).
import {
  chromeStorage,
  makeContentSource,
  makeGmailSender,
  makeLlmProvider,
  getAuthToken,
  getAuthEmail,
  loadConfig,
  saveConfig,
} from "../adapters.js";
import { runDigest } from "@kindling/core";

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const els = {
  settingsLink: $("settings-link"),
  dashboardLink: $("dashboard-link"),

  onboarding: $("onboarding-view"),
  obKindleEmail: $("ob-kindle-email"),
  obConnect: $("ob-connect"),
  obSenderEmail: $("ob-sender-email"),
  obContinue: $("ob-continue"),
  obError: $("ob-error"),

  loading: $("loading-view"),
  empty: $("empty-view"),

  listView: $("list-view"),
  lastSentBanner: $("last-sent-banner"),
  sendErrorBanner: $("send-error-banner"),
  sendErrorMessage: $("send-error-message"),
  sendErrorReconnect: $("send-error-reconnect"),
  sendErrorSettings: $("send-error-settings"),
  sendErrorDismiss: $("send-error-dismiss"),
  selectAll: $("select-all"),
  countLabel: $("count-label"),
  tabList: $("tab-list"),

  footer: $("footer"),
  closeAfterSend: $("close-after-send"),
  sendBtn: $("send-btn"),
};

/** @type {{url:string,title:string,ageMs:number,stale:boolean}[]} */
let tabs = [];
/** current config, kept in sync with storage */
let config = null;

els.settingsLink.addEventListener("click", () =>
  chrome.runtime.openOptionsPage(),
);
els.dashboardLink.addEventListener("click", () =>
  chrome.tabs.create({
    url: chrome.runtime.getURL("dashboard/dashboard.html"),
  }),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();

async function init() {
  config = await loadConfig();
  if (!config.kindleEmail) {
    showOnboarding();
  } else {
    await enterMain();
  }
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
function showOnboarding() {
  els.onboarding.hidden = false;
  els.loading.hidden = true;
  els.footer.hidden = true;
  els.obKindleEmail.value = config.kindleEmail || "";
  updateObContinue();
}

function isValidKindleEmail(value) {
  const v = value.trim().toLowerCase();
  return /^[^\s@]+@(free\.)?kindle\.com$/.test(v);
}

let connectedSenderEmail = "";

function updateObContinue() {
  const kindleOk = isValidKindleEmail(els.obKindleEmail.value);
  els.obContinue.disabled = !(kindleOk && connectedSenderEmail);
}

els.obKindleEmail.addEventListener("input", () => {
  els.obError.hidden = true;
  updateObContinue();
});

els.obConnect.addEventListener("click", async () => {
  els.obError.hidden = true;
  els.obConnect.disabled = true;
  els.obConnect.textContent = "Connecting…";
  try {
    await getAuthToken(true);
    const email = await getAuthEmail();
    connectedSenderEmail = email || "";
    if (connectedSenderEmail) {
      els.obSenderEmail.textContent = connectedSenderEmail;
      els.obSenderEmail.hidden = false;
      els.obConnect.textContent = "Reconnect";
    } else {
      throw new Error("Could not read the connected Google account's email.");
    }
  } catch (err) {
    showObError(friendlyAuthError(err));
    els.obConnect.textContent = "Connect Google (send-only)";
  } finally {
    els.obConnect.disabled = false;
    updateObContinue();
  }
});

els.obContinue.addEventListener("click", async () => {
  const kindleEmail = els.obKindleEmail.value.trim().toLowerCase();
  if (!isValidKindleEmail(kindleEmail)) {
    showObError(
      "That doesn't look like a Send-to-Kindle address — it should end in kindle.com.",
    );
    return;
  }
  if (!connectedSenderEmail) {
    showObError("Connect Google first so Kindling knows who to send mail as.");
    return;
  }
  els.obContinue.disabled = true;
  els.obContinue.textContent = "Saving…";
  try {
    config = { ...config, kindleEmail, senderEmail: connectedSenderEmail };
    await saveConfig(config);
    els.onboarding.hidden = true;
    await enterMain();
  } catch (err) {
    showObError(
      err && err.message
        ? err.message
        : "Could not save your settings. Try again.",
    );
    els.obContinue.disabled = false;
    els.obContinue.textContent = "Get started";
  }
});

function showObError(message) {
  els.obError.textContent = message;
  els.obError.hidden = false;
}

function friendlyAuthError(err) {
  const msg = (err && err.message) || String(err);
  if (/not signed in|no accounts|OAuth2 not granted/i.test(msg)) {
    return "No Google account is signed in to Chrome — sign in, then try connecting again.";
  }
  return `Couldn't connect to Google: ${msg}`;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------
async function enterMain() {
  els.onboarding.hidden = true;
  els.loading.hidden = false;
  els.empty.hidden = true;
  els.listView.hidden = true;
  els.footer.hidden = true;

  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  } catch (err) {
    els.loading.textContent =
      "Couldn't reach Kindling's background service. Try reopening the popup.";
    return;
  }

  config = state.config;
  tabs = (state.tabs || []).filter((t) => t.stale);

  els.loading.hidden = true;
  els.closeAfterSend.checked = !!config.closeAfterSend;

  // Surface the last background/scheduled run so it's never a silent black box.
  try {
    const last = await chromeStorage.get("lastScheduledReport");
    if (last && last.error) {
      showSendError(`Last scheduled run failed: ${last.error}`);
    } else if (last && last.sent > 0) {
      els.lastSentBanner.hidden = false;
      els.lastSentBanner.textContent = `✅ Auto-run sent ${last.sent} article${last.sent === 1 ? "" : "s"} on ${new Date(last.at).toLocaleString()}.`;
    }
  } catch {
    /* non-fatal */
  }

  if (tabs.length === 0) {
    els.empty.hidden = false;
    els.footer.hidden = true;
    return;
  }

  renderTabList();
  els.listView.hidden = false;
  els.footer.hidden = false;
}

function formatAge(ageMs) {
  const hours = ageMs / 3_600_000;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  return `${Math.round(hours / 24)}d`;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function renderTabList() {
  els.tabList.innerHTML = "";
  for (const tab of tabs) {
    const li = document.createElement("li");
    li.className = "tab-item";
    li.dataset.url = tab.url;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.className = "tab-checkbox";
    checkbox.setAttribute("aria-label", `Send "${tab.title || tab.url}"`);
    checkbox.addEventListener("change", updateSendButton);

    const info = document.createElement("div");
    info.className = "tab-info";

    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url;
    title.title = tab.title || tab.url;

    const meta = document.createElement("div");
    meta.className = "tab-meta";
    meta.textContent = domainOf(tab.url);

    const status = document.createElement("div");
    status.className = "tab-status";

    info.append(title, meta, status);

    const age = document.createElement("div");
    age.className = "tab-age";
    age.textContent = formatAge(tab.ageMs);

    li.append(checkbox, info, age);
    els.tabList.appendChild(li);
  }
  updateSendButton();
}

function checkedRows() {
  return Array.from(els.tabList.querySelectorAll(".tab-item"));
}

function checkedUrls() {
  return checkedRows()
    .filter((li) => li.querySelector(".tab-checkbox").checked)
    .map((li) => li.dataset.url);
}

function updateSendButton() {
  const n = checkedUrls().length;
  els.sendBtn.textContent = n > 0 ? `Send ${n} to Kindle` : "Send to Kindle";
  els.sendBtn.disabled = n === 0;
  els.countLabel.textContent = `${n} of ${tabs.length} selected`;

  const allChecked = checkedRows().every(
    (li) => li.querySelector(".tab-checkbox").checked,
  );
  els.selectAll.checked = tabs.length > 0 && allChecked;
}

els.selectAll.addEventListener("change", () => {
  const checked = els.selectAll.checked;
  checkedRows().forEach((li) => {
    li.querySelector(".tab-checkbox").checked = checked;
  });
  updateSendButton();
});

els.closeAfterSend.addEventListener("change", async () => {
  config = { ...config, closeAfterSend: els.closeAfterSend.checked };
  try {
    await chrome.runtime.sendMessage({ type: "SET_CONFIG", config });
  } catch {
    // best-effort; the popup still works this session even if persistence fails
  }
});

function setRowStatus(url, kind, text) {
  const li = els.tabList.querySelector(
    `.tab-item[data-url="${CSS.escape(url)}"]`,
  );
  if (!li) return;
  const status = li.querySelector(".tab-status");
  status.className = `tab-status status-${kind}`;
  status.textContent = text;
}

// ---------------------------------------------------------------------------
// Send flow
// ---------------------------------------------------------------------------
els.sendBtn.addEventListener("click", onSend);

async function onSend() {
  const urls = checkedUrls();
  if (urls.length === 0) return;

  // Extraction reads the content of the tabs you send via chrome.scripting,
  // which needs host access. We keep that OUT of the install-time permissions
  // (nothing granted up front) and request it here, on this user gesture, the
  // first time you send. Without it, every extraction would fail.
  try {
    const granted = await chrome.permissions.request({
      origins: ["http://*/*", "https://*/*"],
    });
    if (!granted) {
      showSendError(
        "Kindling needs permission to read the pages you send. Click Send again and choose Allow.",
      );
      return;
    }
  } catch (err) {
    showSendError(`Could not request page access: ${err && err.message}`);
    return;
  }

  hideSendError();
  els.lastSentBanner.hidden = true;
  els.sendBtn.disabled = true;
  els.selectAll.disabled = true;
  const originalLabel = els.sendBtn.textContent;
  els.sendBtn.textContent = "Sending…";

  checkedRows().forEach((li) => {
    const cb = li.querySelector(".tab-checkbox");
    cb.disabled = true;
    if (cb.checked) setRowStatus(li.dataset.url, "sending", "sending…");
  });

  const ports = {
    content: makeContentSource(),
    sender: makeGmailSender(),
    storage: chromeStorage,
    llm: makeLlmProvider(config),
  };

  let report;
  try {
    report = await runDigest({ urls, ports, config });
  } catch (err) {
    checkedRows().forEach((li) => {
      li.querySelector(".tab-checkbox").disabled = false;
    });
    els.selectAll.disabled = false;
    els.sendBtn.disabled = false;
    els.sendBtn.textContent = originalLabel;
    showSendError(err);
    return;
  }

  // Reconcile per-row status.
  for (const url of report.sent) setRowStatus(url, "ok", "sent");
  for (const { url, reason } of report.failed)
    setRowStatus(url, "fail", reason || "failed");
  for (const { url, reason } of report.skipped)
    setRowStatus(url, "skip", reason || "skipped");

  checkedRows().forEach((li) => {
    li.querySelector(".tab-checkbox").disabled = false;
  });
  els.selectAll.disabled = false;

  if (report.sent.length > 0) {
    showLastSentBanner(report);
    if (config.closeAfterSend) {
      await closeTabsFor(report.sent);
    }
    // Remove sent rows from the working set and re-render.
    tabs = tabs.filter((t) => !report.sent.includes(t.url));
    if (tabs.length === 0) {
      els.listView.hidden = true;
      els.footer.hidden = true;
      els.empty.hidden = false;
      els.empty.querySelector(".empty-title").textContent = "All sent.";
      els.empty.querySelector(".empty-sub").textContent =
        "Nice — your Kindle digest is on its way. Check back once more tabs go stale.";
      return;
    }
    renderTabList();
  } else {
    els.sendBtn.disabled = false;
  }
  els.sendBtn.textContent = "Send to Kindle";
  updateSendButton();

  if (
    report.sent.length === 0 &&
    (report.failed.length > 0 || report.skipped.length > 0)
  ) {
    showSendError(
      new Error(
        "Nothing was sent — every selected tab was skipped or failed. See the status next to each tab.",
      ),
    );
  }
}

function showLastSentBanner(report) {
  els.lastSentBanner.hidden = false;
  const n = report.sent.length;
  const sizeKb = report.digests.reduce((sum, d) => sum + d.sizeBytes, 0) / 1024;
  els.lastSentBanner.textContent = `✅ Sent ${n} article${n === 1 ? "" : "s"} to your Kindle (${sizeKb.toFixed(0)} KB).`;
}

async function closeTabsFor(sentUrls) {
  const sentSet = new Set(sentUrls);
  try {
    const openTabs = await chrome.tabs.query({});
    const ids = openTabs
      .filter((t) => t.url && sentSet.has(t.url) && t.id != null)
      .map((t) => t.id);
    if (ids.length > 0) await chrome.tabs.remove(ids);
  } catch {
    // Non-fatal: the email already sent successfully; closing tabs is a nicety.
  }
}

function showSendError(err) {
  const msg = (err && err.message) || String(err);
  els.sendErrorMessage.textContent = friendlySendError(msg);
  const needsReconnect = /auth|token|401|403|unauthor/i.test(msg);
  els.sendErrorReconnect.hidden = !needsReconnect;
  els.sendErrorBanner.hidden = false;
}

function friendlySendError(msg) {
  if (/auth|token|401|403|unauthor/i.test(msg)) {
    return "Kindling couldn't send as your Google account — the connection may have expired.";
  }
  if (/kindleEmail|no.*kindle.*address/i.test(msg)) {
    return "No Kindle address is configured yet. Add one in Settings.";
  }
  if (/network|fetch/i.test(msg)) {
    return "A network error stopped the send. Check your connection and try again.";
  }
  return `Something went wrong: ${msg}`;
}

function hideSendError() {
  els.sendErrorBanner.hidden = true;
}

els.sendErrorDismiss.addEventListener("click", hideSendError);
els.sendErrorSettings.addEventListener("click", () =>
  chrome.runtime.openOptionsPage(),
);
els.sendErrorReconnect.addEventListener("click", async () => {
  els.sendErrorReconnect.disabled = true;
  try {
    await getAuthToken(true);
    hideSendError();
  } catch (err) {
    els.sendErrorMessage.textContent = friendlyAuthError(err);
  } finally {
    els.sendErrorReconnect.disabled = false;
  }
});
