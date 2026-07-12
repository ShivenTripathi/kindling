// popup.js — the "Send N tabs to Kindle" surface.
import { domainOf } from '../common.js';

const $ = (id) => document.getElementById(id);

const els = {
  banner: $('permission-banner'),
  enableCapture: $('enable-capture'),
  dismissBanner: $('dismiss-banner'),
  loading: $('loading'),
  empty: $('empty'),
  listView: $('list-view'),
  tabList: $('tab-list'),
  selectAll: $('select-all'),
  selectAllLabel: $('select-all-label'),
  countLabel: $('count-label'),
  progressView: $('progress-view'),
  progressMessage: $('progress-message'),
  progressLog: $('progress-log'),
  resultView: $('result-view'),
  resultMessage: $('result-message'),
  resultLog: $('result-log'),
  resultDone: $('result-done'),
  closeAfterSend: $('close-after-send'),
  sendBtn: $('send-btn'),
};

/** @type {Array<{url:string, title:string, domain:string, ageLabel:string, tabId:number}>} */
let staleTabs = [];
const checkedUrls = new Set();

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function showState(name) {
  for (const el of [els.loading, els.empty, els.listView, els.progressView, els.resultView]) {
    el.hidden = el.id !== name;
  }
}

function renderList() {
  els.tabList.innerHTML = '';
  for (const tab of staleTabs) {
    const li = document.createElement('li');
    li.className = 'tab-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checkedUrls.has(tab.url);
    checkbox.setAttribute('aria-label', `Include ${tab.title}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) checkedUrls.add(tab.url);
      else checkedUrls.delete(tab.url);
      syncSelectAll();
      syncSendButton();
    });

    const info = document.createElement('div');
    info.className = 'tab-info';
    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;
    title.title = tab.url;
    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    meta.textContent = tab.domain;
    info.append(title, meta);

    const age = document.createElement('span');
    age.className = 'tab-age';
    age.textContent = tab.ageLabel;

    li.append(checkbox, info, age);
    els.tabList.appendChild(li);
  }
  els.countLabel.textContent = `${staleTabs.length} stale`;
}

function syncSelectAll() {
  els.selectAll.checked = staleTabs.length > 0 && checkedUrls.size === staleTabs.length;
  els.selectAll.indeterminate = checkedUrls.size > 0 && checkedUrls.size < staleTabs.length;
}

function syncSendButton() {
  els.sendBtn.disabled = checkedUrls.size === 0;
  els.sendBtn.textContent =
    checkedUrls.size > 0 ? `Send ${checkedUrls.size} tab${checkedUrls.size === 1 ? '' : 's'} to Kindle` : 'Send to Kindle';
}

async function loadStaleTabs() {
  showState('loading');
  const res = await send({ type: 'getStaleTabs' });
  if (!res || !res.ok) {
    els.empty.querySelector('.empty-title').textContent = 'Could not load tabs.';
    showState('empty');
    return;
  }
  staleTabs = res.tabs.map((t) => ({ ...t, domain: t.domain || domainOf(t.url) }));
  checkedUrls.clear();
  staleTabs.forEach((t) => checkedUrls.add(t.url)); // default checked

  if (staleTabs.length === 0) {
    showState('empty');
    return;
  }
  renderList();
  syncSelectAll();
  syncSendButton();
  showState('list-view');
}

async function loadSettings() {
  const res = await send({ type: 'getSettings' });
  if (res && res.ok) {
    els.closeAfterSend.checked = !!res.settings.closeAfterSend;
  }
  const perm = await send({ type: 'hasHostPermission' });
  els.banner.hidden = !!(perm && perm.granted) || localStorage.getItem('kindling_banner_dismissed') === '1';
}

els.selectAll.addEventListener('change', () => {
  checkedUrls.clear();
  if (els.selectAll.checked) staleTabs.forEach((t) => checkedUrls.add(t.url));
  renderList();
  syncSendButton();
});

els.enableCapture.addEventListener('click', async () => {
  const res = await send({ type: 'requestHostPermission' });
  if (res && res.granted) {
    els.banner.hidden = true;
  }
});

els.dismissBanner.addEventListener('click', () => {
  localStorage.setItem('kindling_banner_dismissed', '1');
  els.banner.hidden = true;
});

els.closeAfterSend.addEventListener('change', () => {
  send({ type: 'setSettings', settings: { closeAfterSend: els.closeAfterSend.checked } });
});

function appendProgressLine(text) {
  const li = document.createElement('li');
  li.textContent = text;
  els.progressLog.appendChild(li);
  els.progressLog.scrollTop = els.progressLog.scrollHeight;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'sendProgress' && !els.progressView.hidden) {
    const p = msg.progress;
    if (p.stage === 'capture') appendProgressLine(`Capturing rendered page: ${p.url}`);
    else if (p.message) appendProgressLine(p.message);
  }
});

els.sendBtn.addEventListener('click', async () => {
  const urls = [...checkedUrls];
  if (urls.length === 0) return;

  showState('progress-view');
  els.progressLog.innerHTML = '';
  els.progressMessage.textContent = `Sending ${urls.length} tab${urls.length === 1 ? '' : 's'}…`;

  const opts = { closeAfterSend: els.closeAfterSend.checked };
  const res = await send({ type: 'sendTabs', urls, opts });

  showState('result-view');
  els.resultLog.innerHTML = '';

  if (!res || !res.ok) {
    els.resultMessage.textContent = 'Something went wrong.';
    appendResultLine((res && res.error) || 'Unknown error', false);
    return;
  }

  const result = res.result;
  if (!result.ok) {
    els.resultMessage.textContent = `Couldn't send: ${result.error || 'unknown error'}`;
  } else {
    els.resultMessage.textContent = `Sent ${result.sentUrls.length} article${result.sentUrls.length === 1 ? '' : 's'} to your Kindle.`;
  }
  for (const url of result.sentUrls || []) appendResultLine(url, true);
  for (const f of result.failedUrls || []) appendResultLine(`${f.url} — ${f.reason}`, false);
});

function appendResultLine(text, ok) {
  const li = document.createElement('li');
  li.className = ok ? 'status-ok' : 'status-fail';
  li.append(document.createTextNode(` ${text}`));
  els.resultLog.appendChild(li);
}

els.resultDone.addEventListener('click', () => {
  loadStaleTabs();
});

loadSettings();
loadStaleTabs();
