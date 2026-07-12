#!/usr/bin/env node
// Kindling CLI — wires the pipeline modules together.
// Pipeline: snapshot → ledger reconcile → selectStale → screen/dedupe →
// extract → gate → buildEpub (split if needed) → send → recordDigest → save.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { mkdir } from "node:fs/promises";

import { Command } from "commander";
import {
  paths,
  defaultConfig,
  loadConfig,
  saveConfig,
  validateConfig,
} from "./config.js";
import { listProfiles, readProfileTabs } from "./tabs/profiles.js";
import {
  loadLedger,
  saveLedger,
  recordSnapshot,
  selectStale,
  recordDigest,
} from "./ledger.js";
import { screenUrl, dedupe } from "./filter.js";
import { extract } from "./extract/index.js";
import { buildEpub, splitForSizeLimit } from "./epub.js";
import { authorize, getAccessToken } from "./gmail/oauth.js";
import { sendMail } from "./gmail/send.js";
import { sendMailSmtp } from "./gmail/smtp.js";
import { setSecret, getSecret } from "./gmail/keychain.js";
import { installAgent, uninstallAgent, plistPath } from "./agent.js";

const OAUTH_CLIENT_ID_KEY = "__oauth_client_id__";
const OAUTH_CLIENT_SECRET_KEY = "__oauth_client_secret__";

/** A short, human digest id like "2026-07-08-a". */
function digestId(date, suffixIndex) {
  const d = date.toISOString().slice(0, 10);
  return `${d}-${String.fromCharCode(97 + suffixIndex)}`;
}

function log(msg) {
  stdout.write(`${msg}\n`);
}

/** Resolve the OAuth client credentials the user configured during `init`. */
async function oauthClient() {
  const clientId = await getSecret(OAUTH_CLIENT_ID_KEY);
  const clientSecret = await getSecret(OAUTH_CLIENT_SECRET_KEY);
  if (!clientId || !clientSecret) {
    throw new Error(
      "No Google OAuth client configured. Run `kindling init` and follow the " +
        "SETUP.md steps to create a desktop OAuth client first.",
    );
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function cmdInit() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q, dflt) => {
    const a = (await rl.question(dflt ? `${q} [${dflt}]: ` : `${q}: `)).trim();
    return a || dflt || "";
  };
  // Like ask(), but suppresses terminal echo so a secret isn't visible on
  // screen or captured in scrollback / session recordings.
  const askHidden = async (q) => {
    // _writeToOutput/output are internal readline members (not in the public
    // type) — cast to reach them for echo suppression.
    const rli = /** @type {any} */ (rl);
    const muted = { on: false };
    const orig = rli._writeToOutput?.bind(rl);
    rli._writeToOutput = (str) => {
      // Write the prompt and control sequences, but swallow the echoed secret.
      if (muted.on && !/[\r\n]/.test(str)) return;
      rli.output.write(str);
    };
    try {
      const p = rl.question(`${q}: `);
      muted.on = true; // start muting only after the prompt is drawn
      const a = await p;
      rli.output.write("\n");
      return a.trim();
    } finally {
      rli._writeToOutput = orig || ((str) => rli.output.write(str));
    }
  };
  try {
    log("\n🔥 Kindling setup\n");

    const profiles = await listProfiles();
    if (profiles.length === 0) {
      log("No Chrome profiles found. Is Google Chrome installed?");
      return;
    }
    log("Chrome profiles found:");
    profiles.forEach((p, i) => {
      log(
        `  ${i + 1}. ${p.displayName} (${p.id})${p.email ? ` — ${p.email}` : ""}`,
      );
    });
    log(
      "\nSelect ONLY your personal profile — Kindling never reads any other one.",
    );
    const pick = await ask("Profile number", "1");
    const profile = profiles[Number(pick) - 1] || profiles[0];

    const cfg = defaultConfig();
    cfg.profileId = profile.id;
    cfg.kindleEmail = await ask("Your Send-to-Kindle address (…@kindle.com)");
    cfg.senderEmail = await ask(
      "Your approved sender Gmail address",
      profile.email || "",
    );
    cfg.staleHours = Number(
      await ask("Send tabs left open for how many hours?", "48"),
    );
    const auth = await ask("Send via (oauth/smtp)", "oauth");
    cfg.authMethod = auth === "smtp" ? "smtp" : "oauth";

    validateConfig(cfg);
    const { configPath, dataDir } = paths();
    await mkdir(dataDir, { recursive: true });
    await saveConfig(cfg, configPath);
    log(`\nSaved config to ${configPath}`);

    if (cfg.authMethod === "oauth") {
      log(
        '\nGoogle OAuth — see SETUP.md to create a "Desktop app" OAuth client.',
      );
      const clientId = await ask("OAuth client ID");
      const clientSecret = await askHidden(
        "OAuth client secret (input hidden)",
      );
      await setSecret(OAUTH_CLIENT_ID_KEY, clientId);
      await setSecret(OAUTH_CLIENT_SECRET_KEY, clientSecret);
      log("\nOpening your browser to grant send-only access…");
      const { email } = await authorize({ clientId, clientSecret });
      log(`Connected as ${email}. Refresh token stored in your Keychain.`);
    } else {
      log("\nSMTP fallback selected. Create a Gmail app password (SETUP.md).");
      const appPw = await askHidden("Gmail app password (input hidden)");
      await setSecret(cfg.senderEmail, appPw);
      log("App password stored in your Keychain.");
    }
    log("\n✅ Setup complete. Try:  kindling run --dry-run\n");
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// snapshot — read tabs, reconcile ledger, persist
// ---------------------------------------------------------------------------
async function snapshot(cfg, ledgerPath, now) {
  const tabs = await readProfileTabs(cfg.profileId);
  let ledger = await loadLedger(ledgerPath);
  ledger = recordSnapshot(ledger, tabs, now);
  await saveLedger(ledgerPath, ledger);
  return { tabs, ledger };
}

async function cmdSnapshot() {
  const cfg = await loadConfig();
  const { ledgerPath } = paths();
  const { tabs } = await snapshot(cfg, ledgerPath, new Date());
  log(`Snapshotted ${tabs.length} open tabs from profile "${cfg.profileId}".`);
}

// ---------------------------------------------------------------------------
// run — the full pipeline
// ---------------------------------------------------------------------------
async function cmdRun(opts) {
  const now = new Date();
  const cfg = await loadConfig();
  const { ledgerPath } = paths();

  const { ledger } = await snapshot(cfg, ledgerPath, now);

  // Select stale, then screen + dedupe.
  const stale = selectStale(ledger, cfg.staleHours, now);
  const screened = [];
  const skipped = [];
  for (const url of dedupe(stale)) {
    const { include, reason } = screenUrl(url, cfg.filters);
    if (include) screened.push(url);
    else skipped.push({ url, reason });
  }

  log(
    `\n${stale.length} tabs open ≥ ${cfg.staleHours}h · ${screened.length} candidate(s) after filtering.`,
  );
  for (const s of skipped) log(`  skip  ${s.url}  (${s.reason})`);
  if (screened.length === 0) {
    log("\nNothing to send.");
    return;
  }

  const { articles, failedUrls } = await extractAll(screened, cfg);
  if (articles.length === 0) {
    log("\nNo articles could be extracted. Nothing sent.");
    return;
  }

  const title = "Tab Digest";
  log(
    `\n${articles.length} article(s) ready for "${title} · ${now.toDateString()}".`,
  );

  if (opts.dryRun) {
    log("\n--dry-run: stopping before build & send. Would include:");
    articles.forEach((a) => log(`  • ${a.title}  —  ${a.url}`));
    if (failedUrls.length)
      log(
        `  (${failedUrls.length} couldn't be fetched; they'd be listed on an end page)`,
      );
    return;
  }

  await buildAndSend(articles, failedUrls, cfg, ledgerPath, now, title);
  log("\n✅ Done.");
}

/** Fetch + extract a list of URLs, logging per-URL outcome.
 * @returns {Promise<{articles: import('./extract/index.js').Article[], failedUrls: string[]}>} */
async function extractAll(urls, cfg) {
  const articles = [];
  const failedUrls = [];
  for (const url of urls) {
    stdout.write(`  fetch ${url} … `);
    const result = await extract(url, {
      minWords: cfg.minWords,
      disableWayback: cfg.disableWayback,
    });
    if (result.status === "ok") {
      articles.push(result.article);
      log(
        `ok (${result.article.wordCount}w, ${result.article.engine}, ${result.article.fetchTier})`,
      );
    } else {
      failedUrls.push(url);
      log(`${result.status} (${result.reason})`);
    }
  }
  return { articles, failedUrls };
}

/** Build the digest EPUB(s) (splitting for the 50MB cap), send each, and
 * record them in the ledger. Shared by `run` and `send`. */
async function buildAndSend(articles, failedUrls, cfg, ledgerPath, now, title) {
  const { dataDir } = paths();
  await mkdir(dataDir, { recursive: true });
  const groups = splitForSizeLimit(articles);
  const accessToken =
    cfg.authMethod === "oauth"
      ? await getAccessToken(await oauthClient())
      : null;

  for (let i = 0; i < groups.length; i++) {
    const id = digestId(now, i);
    const outPath = path.join(dataDir, `${id}.epub`);
    const built = await buildEpub(groups[i], {
      outPath,
      title,
      date: now,
      failedUrls: i === 0 ? failedUrls : [],
    });
    log(
      `Built ${built.path} (${(built.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${built.articleCount} articles).`,
    );

    const subject = groups.length > 1 ? `${title} ${id}` : title;
    const mail = {
      to: cfg.kindleEmail,
      from: cfg.senderEmail,
      subject,
      attachmentPath: built.path,
      attachmentName: `${id}.epub`,
    };
    if (cfg.authMethod === "oauth") await sendMail({ ...mail, accessToken });
    else await sendMailSmtp(mail);
    log(`Sent to ${cfg.kindleEmail}.`);

    let updated = await loadLedger(ledgerPath);
    updated = recordDigest(
      updated,
      {
        id,
        sentAt: now.toISOString(),
        articles: built.articleCount,
        sizeBytes: built.sizeBytes,
        urls: groups[i].map((a) => a.url),
      },
      now,
    );
    await saveLedger(ledgerPath, updated);
  }
}

// ---------------------------------------------------------------------------
// send <url...> — ad-hoc "send these now", bypassing the staleness gate
// ---------------------------------------------------------------------------
async function cmdSend(urls) {
  const now = new Date();
  const cfg = await loadConfig();
  const { ledgerPath } = paths();

  const candidates = [];
  for (const url of dedupe(urls)) {
    const { include, reason } = screenUrl(url, cfg.filters);
    if (include) candidates.push(url);
    else log(`  skip ${url}  (${reason})`);
  }
  if (candidates.length === 0) {
    log("No sendable URLs.");
    return;
  }

  const { articles, failedUrls } = await extractAll(candidates, cfg);
  if (articles.length === 0) {
    log("\nNo articles could be extracted. Nothing sent.");
    return;
  }
  await buildAndSend(articles, failedUrls, cfg, ledgerPath, now, "Kindling");
  log("\n✅ Done.");
}

// ---------------------------------------------------------------------------
// status / history
// ---------------------------------------------------------------------------
async function cmdStatus() {
  const cfg = await loadConfig();
  const { ledgerPath, configPath } = paths();
  const ledger = await loadLedger(ledgerPath);
  const now = new Date();
  const tracked = Object.keys(ledger.tabs).length;
  const sent = Object.values(ledger.tabs).filter((t) => t.sentAt).length;
  const stale = selectStale(ledger, cfg.staleHours, now).length;
  log(`Config:   ${configPath}`);
  log(`Profile:  ${cfg.profileId}   →  ${cfg.kindleEmail}`);
  log(`Threshold: ${cfg.staleHours}h   Auth: ${cfg.authMethod}`);
  log(
    `Ledger:   ${tracked} URLs tracked, ${sent} sent, ${stale} stale & unsent, ${ledger.digests.length} digests.`,
  );
}

async function cmdHistory() {
  const { ledgerPath } = paths();
  const ledger = await loadLedger(ledgerPath);
  if (ledger.digests.length === 0) {
    log("No digests sent yet.");
    return;
  }
  for (const d of ledger.digests.slice().reverse()) {
    log(
      `\n${d.id}  ·  ${new Date(d.sentAt).toLocaleString()}  ·  ${d.articles} articles`,
    );
    for (const url of d.urls) {
      const rec =
        ledger.tabs[url] ||
        ledger.tabs[Object.keys(ledger.tabs).find((k) => k === url)];
      const reopened = rec && rec.reopenedAt && rec.reopenedAt.length;
      log(
        `   ${reopened ? "↺" : " "} ${url}${reopened ? `  (reopened ${rec.reopenedAt.length}×)` : ""}`,
      );
    }
  }
  log("\n↺ = you reopened this after it was sent.");
}

// ---------------------------------------------------------------------------
// block / allow
// ---------------------------------------------------------------------------
async function cmdFilterRule(kind, domain) {
  const cfg = await loadConfig();
  const list = cfg.filters[kind];
  if (!list.includes(domain)) list.push(domain);
  const { configPath } = paths();
  await saveConfig(cfg, configPath);
  log(`Added "${domain}" to ${kind} list.`);
}

// ---------------------------------------------------------------------------
// agent install / uninstall (launchd)
// ---------------------------------------------------------------------------
async function cmdAgentInstall() {
  const cfg = await loadConfig();
  const { dataDir } = paths();
  await mkdir(dataDir, { recursive: true });
  const logPath = path.join(dataDir, "agent.log");
  const { plist } = await installAgent({
    scheduleHours: cfg.scheduleHours,
    logPath,
  });
  log(`Scheduled: Kindling will run every ${cfg.scheduleHours}h.`);
  log(`  LaunchAgent: ${plist}`);
  log(`  Logs:        ${logPath}`);
  log("Disable anytime with:  kindling agent uninstall");
}

async function cmdAgentUninstall() {
  const { removed } = await uninstallAgent();
  log(
    removed
      ? `Removed scheduled agent (${plistPath()}).`
      : "No scheduled agent was installed.",
  );
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------
function buildProgram() {
  const program = new Command();
  program
    .name("kindling")
    .description("Send stale Chrome tabs to your Kindle as an EPUB digest.");
  program
    .command("init")
    .description("Interactive setup (profile, Kindle address, auth).")
    .action(cmdInit);
  program
    .command("snapshot")
    .description("Record currently-open tabs into the ledger.")
    .action(cmdSnapshot);
  program
    .command("run")
    .description("Run the full pipeline; --dry-run to preview without sending.")
    .option(
      "--dry-run",
      "Show what would be sent, without building or sending.",
    )
    .action((o) => cmdRun({ dryRun: !!o.dryRun }));
  program
    .command("status")
    .description("Show config and ledger summary.")
    .action(cmdStatus);
  program
    .command("history")
    .description("Show sent digests and reopened tabs.")
    .action(cmdHistory);
  program
    .command("send <url...>")
    .description(
      "Extract and send specific URLs now, ignoring the staleness gate.",
    )
    .action(cmdSend);
  program
    .command("block <domain>")
    .description("Never send this domain.")
    .action((d) => cmdFilterRule("block", d));
  program
    .command("allow <domain>")
    .description("Always allow this domain.")
    .action((d) => cmdFilterRule("allow", d));

  const agent = program
    .command("agent")
    .description("Manage the scheduled background run (launchd).");
  agent
    .command("install")
    .description("Run Kindling automatically on a timer.")
    .action(cmdAgentInstall);
  agent
    .command("uninstall")
    .description("Stop the scheduled runs.")
    .action(cmdAgentUninstall);
  return program;
}

async function main() {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    log(`\n✖ ${err.message}`);
    process.exitCode = 1;
  }
}

main();
