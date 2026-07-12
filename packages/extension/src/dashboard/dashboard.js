// dashboard.js — the reading dashboard. An ordinary extension page (full DOM
// + chrome.*), computed entirely from the local ledger: no network calls, no
// remote code (MV3 forbids it), no chart library — every visual here is
// hand-built inline SVG/HTML.
import {
  chromeStorage,
  loadConfig,
  makeLlmProvider,
  makeGmailSender,
} from "../adapters.js";
import { computeInsights, tagTopics } from "@kindling/core/insights";
import { buildEpub } from "@kindling/core";
import {
  aggregateTopics,
  formatReadingTime,
  RANGE_PRESETS,
  digestHistory,
  summarizedItemsInRange,
} from "./topics.js";

const $ = (id) => document.getElementById(id);

const els = {
  settingsLink: $("settings-link"),
  emptyView: $("empty-view"),
  dashboardView: $("dashboard-view"),
  rangeBtns: /** @type {HTMLButtonElement[]} */ ([
    ...document.querySelectorAll(".range-btn"),
  ]),
  statBacklog: $("stat-backlog"),
  statSent: $("stat-sent"),
  statSentSub: $("stat-sent-sub"),
  statReopen: $("stat-reopen"),
  statMinutes: $("stat-minutes"),
  statStreak: $("stat-streak"),
  volumeWrap: $("volume-chart-wrap"),
  sourcesList: $("sources-list"),
  topicsChips: $("topics-chips"),
  digestList: $("digest-list"),
  aiPanel: $("ai-panel"),
  aiUpsell: $("ai-upsell"),
  aiUpsellLink: $("ai-upsell-link"),
  aiGenerateBtn: $("ai-generate-btn"),
  aiLoading: $("ai-loading"),
  aiError: $("ai-error"),
  aiResult: $("ai-result"),
  aiNarrative: $("ai-narrative"),
  aiSendBtn: $("ai-send-btn"),
  aiSendStatus: $("ai-send-status"),
};

els.settingsLink.addEventListener("click", () =>
  chrome.runtime.openOptionsPage(),
);
els.aiUpsellLink.addEventListener("click", () =>
  chrome.runtime.openOptionsPage(),
);
els.aiGenerateBtn.addEventListener("click", onGenerateMonthlyDigest);
els.aiSendBtn.addEventListener("click", onSendMonthlyDigest);

let ledger = { tabs: {}, digests: [] };
let currentRange = "month";
let config = null;
/** the last-generated narrative, kept around so "send to Kindle" can use it
 * without re-calling the model. */
let lastNarrative = "";

init();

async function init() {
  ledger = (await chromeStorage.get("ledger")) || { tabs: {}, digests: [] };
  config = await loadConfig();
  updateAiVisibility();

  const hasHistory =
    Object.keys(ledger.tabs ?? {}).length > 0 ||
    (ledger.digests ?? []).length > 0;
  if (!hasHistory) {
    els.emptyView.hidden = false;
    els.dashboardView.hidden = true;
    return;
  }

  els.emptyView.hidden = true;
  els.dashboardView.hidden = false;

  for (const btn of els.rangeBtns) {
    btn.addEventListener("click", () => {
      currentRange = btn.dataset.range;
      for (const b of els.rangeBtns)
        b.setAttribute("aria-selected", String(b === btn));
      render();
    });
  }

  render();
}

function render() {
  const rangeDays = RANGE_PRESETS[currentRange] ?? RANGE_PRESETS.month;
  const insights = computeInsights(ledger, { now: new Date(), rangeDays });

  renderStats(insights);
  renderVolumeChart(insights.volumeByDay);
  renderSources(insights.topSources);
  renderTopics();
  renderDigestHistory();
}

function renderStats(insights) {
  els.statBacklog.textContent = String(insights.backlog);
  els.statSent.textContent = String(insights.sentInRange);
  els.statSentSub.textContent = rangeLabel();
  els.statReopen.textContent = `${Math.round(insights.reopenRate * 100)}%`;
  els.statMinutes.textContent = formatReadingTime(insights.readingMinutes);
  els.statStreak.textContent = String(insights.streakDays);
}

function rangeLabel() {
  if (currentRange === "week") return "this week";
  if (currentRange === "all") return "all time";
  return "this month";
}

// ---- Volume chart (inline SVG bar chart, no library) -----------------------

function renderVolumeChart(volumeByDay) {
  els.volumeWrap.innerHTML = "";

  if (!volumeByDay || volumeByDay.length === 0) {
    const p = document.createElement("p");
    p.className = "chart-empty";
    p.textContent = "No sends in this range yet.";
    els.volumeWrap.appendChild(p);
    return;
  }

  const max = Math.max(1, ...volumeByDay.map((d) => d.count));
  const total = volumeByDay.reduce((sum, d) => sum + d.count, 0);
  const n = volumeByDay.length;

  const width = 640;
  const height = 120;
  const barGap = 2;
  const barW = Math.max(1, width / n - barGap);
  const chartH = 96; // leave room for date labels below
  const labelEvery = Math.max(1, Math.ceil(n / 8)); // avoid label crowding

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `Sending volume: ${total} article${total === 1 ? "" : "s"} sent over ${n} day${n === 1 ? "" : "s"}, peak day ${max}.`,
  );

  volumeByDay.forEach((d, i) => {
    const barH = d.count === 0 ? 0 : Math.max(2, (d.count / max) * chartH);
    const x = i * (barW + barGap);
    const y = chartH - barH;

    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(barW));
    rect.setAttribute("height", String(barH || 1));
    rect.setAttribute("rx", "1.5");
    rect.setAttribute("class", "vol-bar");
    rect.setAttribute("opacity", d.count === 0 ? "0.18" : "1");
    rect.setAttribute("tabindex", "0");

    const title = document.createElementNS(svgNS, "title");
    title.textContent = `${d.date}: ${d.count} sent`;
    rect.appendChild(title);

    svg.appendChild(rect);

    if (i % labelEvery === 0 || i === n - 1) {
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", String(x + barW / 2));
      label.setAttribute("y", String(height - 4));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "vol-axis-label");
      label.textContent = shortDate(d.date);
      svg.appendChild(label);
    }
  });

  els.volumeWrap.appendChild(svg);
}

function shortDate(isoDay) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---- Top sources -------------------------------------------------------

function renderSources(topSources) {
  els.sourcesList.innerHTML = "";
  if (!topSources || topSources.length === 0) {
    els.sourcesList.appendChild(emptyNote("No sources yet."));
    return;
  }
  const max = Math.max(...topSources.map((s) => s.count));
  for (const { domain, count } of topSources) {
    const row = document.createElement("div");
    row.className = "source-row";

    const label = document.createElement("span");
    label.className = "source-domain";
    label.textContent = domain;
    label.title = domain;

    const track = document.createElement("span");
    track.className = "source-bar-track";
    const fill = document.createElement("span");
    fill.className = "source-bar-fill";
    fill.style.width = `${Math.max(4, (count / max) * 100)}%`;
    track.appendChild(fill);

    const countEl = document.createElement("span");
    countEl.className = "source-count";
    countEl.textContent = String(count);

    row.append(label, track, countEl);
    els.sourcesList.appendChild(row);
  }
}

// ---- Topics --------------------------------------------------------------

function renderTopics() {
  els.topicsChips.innerHTML = "";
  els.topicsChips.classList.add("topics-chips");
  const topics = aggregateTopics(ledger, tagTopics).slice(0, 8);
  if (topics.length === 0) {
    els.topicsChips.appendChild(emptyNote("No topics tagged yet."));
    return;
  }
  for (const { topic, count } of topics) {
    const chip = document.createElement("span");
    chip.className = "topic-chip";
    chip.innerHTML = `${escapeHtml(topic)} <span class="count">${count}</span>`;
    els.topicsChips.appendChild(chip);
  }
}

// ---- AI: monthly reading digest --------------------------------------------
// Optional, bring-your-own-key, local-only (see @kindling/core/llm). Shown
// only when config.llm has a key; otherwise a gentle upsell links to Settings.

function updateAiVisibility() {
  const hasKey = !!(config && config.llm && config.llm.apiKey);
  els.aiPanel.hidden = !hasKey;
  els.aiUpsell.hidden = hasKey;
}

async function onGenerateMonthlyDigest() {
  const llm = makeLlmProvider(config);
  if (!llm) {
    updateAiVisibility();
    return;
  }

  els.aiError.hidden = true;
  els.aiResult.hidden = true;
  els.aiSendStatus.textContent = "";
  els.aiGenerateBtn.disabled = true;
  els.aiLoading.hidden = false;

  try {
    const rangeDays = RANGE_PRESETS[currentRange] ?? RANGE_PRESETS.month;
    const items = summarizedItemsInRange(ledger, {
      now: new Date(),
      rangeDays,
    });
    if (items.length === 0) {
      throw new Error(
        "No summarized articles in this range yet — summaries are generated the next time you send a digest with AI insights on.",
      );
    }
    const narrative = await llm.synthesize(items, { period: rangeLabel() });
    lastNarrative = narrative;
    els.aiNarrative.textContent = narrative;
    els.aiResult.hidden = false;
    els.aiSendBtn.disabled = false;
    els.aiSendBtn.textContent = "Send this digest to my Kindle";
  } catch (err) {
    els.aiError.textContent = friendlyAiError(err);
    els.aiError.hidden = false;
  } finally {
    els.aiLoading.hidden = true;
    els.aiGenerateBtn.disabled = false;
  }
}

function friendlyAiError(err) {
  const msg = (err && err.message) || String(err);
  if (/429|rate.?limit|quota/i.test(msg)) {
    return "Try again — the free tier is busy right now.";
  }
  if (/network|fetch/i.test(msg)) {
    return "A network error stopped the request. Check your connection and try again.";
  }
  return `Couldn't generate a digest: ${msg}`;
}

async function onSendMonthlyDigest() {
  if (!lastNarrative || !config || !config.kindleEmail) {
    els.aiSendStatus.textContent =
      config && config.kindleEmail
        ? ""
        : "Add a Kindle address in Settings first.";
    return;
  }

  els.aiSendBtn.disabled = true;
  els.aiSendBtn.textContent = "Sending…";
  els.aiSendStatus.textContent = "";

  try {
    const period = rangeLabel();
    const wordCount = lastNarrative.split(/\s+/).filter(Boolean).length;
    const article = {
      url: "kindling://monthly",
      title: `Your reading — ${period}`,
      contentHtml: `<p>${escapeHtml(lastNarrative).replace(/\n+/g, "</p><p>")}</p>`,
      textContent: lastNarrative,
      wordCount,
    };
    const built = await buildEpub([article], { title: "Your reading" });
    const sender = makeGmailSender();
    await sender.send({
      to: config.kindleEmail,
      from: config.senderEmail,
      subject: `Your reading — ${period}`,
      attachment: built.bytes,
      attachmentName: "monthly-digest.epub",
    });
    els.aiSendStatus.textContent = "Sent to your Kindle.";
  } catch (err) {
    els.aiSendStatus.textContent = `Couldn't send: ${(err && err.message) || err}`;
  } finally {
    els.aiSendBtn.disabled = false;
    els.aiSendBtn.textContent = "Send this digest to my Kindle";
  }
}

// ---- Digest history --------------------------------------------------------

function renderDigestHistory() {
  els.digestList.innerHTML = "";
  const digests = digestHistory(ledger);
  if (digests.length === 0) {
    const li = document.createElement("li");
    li.appendChild(emptyNote("No digests sent yet."));
    els.digestList.appendChild(li);
    return;
  }

  for (const digest of digests) {
    const li = document.createElement("li");
    li.className = "digest-item";

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.className = "digest-summary";

    const date = document.createElement("span");
    date.className = "digest-date";
    date.textContent = formatDigestDate(digest.sentAt);

    const meta = document.createElement("span");
    meta.className = "digest-meta";
    const reopenedCount = digest.urls.filter((u) => u.reopened).length;
    meta.textContent = `${digest.articles} article${digest.articles === 1 ? "" : "s"} · ${(digest.sizeBytes / 1024).toFixed(0)} KB${
      reopenedCount > 0 ? ` · ${reopenedCount} reopened` : ""
    }`;

    summary.append(date, meta);
    details.appendChild(summary);

    const urlList = document.createElement("ul");
    urlList.className = "digest-urls";
    for (const { url, reopened } of digest.urls) {
      const record = ledger.tabs?.[url];
      const item = document.createElement("li");

      const row = document.createElement("div");
      row.className = "digest-url-row";

      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = record?.title || url;

      row.appendChild(link);
      if (reopened) {
        const badge = document.createElement("span");
        badge.className = "reopened-badge";
        badge.textContent = "↺ reopened";
        row.appendChild(badge);
      }
      item.appendChild(row);

      // AI summary, when one was generated at send time (config.llm was set).
      if (record?.summary) {
        const summaryP = document.createElement("p");
        summaryP.className = "digest-url-summary";
        summaryP.textContent = record.summary;
        item.appendChild(summaryP);
      }

      urlList.appendChild(item);
    }
    details.appendChild(urlList);
    li.appendChild(details);
    els.digestList.appendChild(li);
  }
}

function formatDigestDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function emptyNote(text) {
  const p = document.createElement("p");
  p.className = "panel-empty";
  p.textContent = text;
  return p;
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
