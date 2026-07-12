# Kindling 🔥

**Turn the tabs you never got back to into something you'll actually read.**

[![CI](https://github.com/ShivenTripathi/kindling/actions/workflows/ci.yml/badge.svg)](https://github.com/ShivenTripathi/kindling/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

Kindling watches one Chrome profile you choose, notices the tabs you opened and never closed, and — once they've sat there for 48 hours (configurable) — bundles them into a clean, readable EPUB and emails it to your Kindle. Then it gets out of the way. No server, no account, no telemetry: it runs entirely on your machine and the only thing that ever leaves it is the digest email you send to yourself.

If your tab bar is a graveyard of "I'll read this later," this is for that pile.

## Table of contents

- [Why](#why)
- [Features](#features)
- [Quick start](#quick-start)
- [Command reference](#command-reference)
- [How it works](#how-it-works)
- [Privacy & trust](#privacy--trust)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why

You open a tab meaning to read it. It's still open eleven days later, buried under forty others. Kindling doesn't try to fix your reading habits — it just quietly collects the tabs you've clearly deprioritized (open 48+ hours, never revisited) and turns them into a digest that lands on a device built for reading, instead of dying in a browser tab you'll eventually close in a fit of guilt.

## Features

- **Per-profile scoping** — you pick exactly one Chrome profile during setup; Kindling never reads any other profile on the machine.
- **Tiered fetching** — a fast plain HTTP fetch first, falling back to your already-installed Chrome driven headlessly (for JS-heavy pages and bot challenges), and finally an Internet Archive Wayback snapshot as a last resort. No bundled Chromium.
- **Defuddle + Readability extraction** — a scored two-engine chain tuned on a real-world corpus (articles, forums, Q&A threads), with a quality gate so junk never makes it into your digest.
- **Sensible default exclusions + your own rules** — social feeds, webmail, checkout pages, and other "app, not article" domains are excluded out of the box; add your own with `kindling block`/`kindling allow`.
- **Nothing silently dropped** — every tab that gets skipped or fails to extract is shown, with a reason, in `--dry-run` output, `kindling history`, and an end-page in the EPUB itself.
- **History & reopen tracking** — `kindling history` shows what was sent and flags anything you went back and reopened afterward, so you can tell what actually mattered.
- **Send-only OAuth** — sending uses a Gmail OAuth token scoped to `gmail.send` only. It cannot read your inbox. It lives in the macOS Keychain, never in a file.

## Quick start

### Prerequisites

- macOS (Chrome's session-file layout, Keychain, and launchd automation are all macOS-specific today — see [Roadmap](#roadmap))
- [Node.js](https://nodejs.org/) ≥ 20
- Google Chrome, installed and used with at least one profile

### Install

```sh
# from npm
npm install -g kindling

# or from source
git clone https://github.com/ShivenTripathi/kindling.git
cd kindling
npm install
npm link
```

### Set up

```sh
kindling init
```

This walks you through: picking your Chrome profile, entering your Send-to-Kindle address, choosing how stale a tab has to be (default 48h), and connecting a Gmail sender. The Gmail OAuth part is the fiddly bit — the full walkthrough is in **[docs/SETUP.md](./docs/SETUP.md)**. Do that first if you haven't got a Google Cloud OAuth client yet.

### Try it without sending anything

```sh
kindling run --dry-run
```

Shows exactly which tabs are stale, which are filtered out (and why), and what would be extracted and sent — no network send, no EPUB written.

### Send a digest for real

```sh
kindling run
```

### Automate it

```sh
kindling agent install
```

This installs a macOS `launchd` LaunchAgent that runs `kindling run` on a timer — every `scheduleHours` (a config field, default 6). Output goes to `~/.local/share/kindling/agent.log`. Turn it off again with:

```sh
kindling agent uninstall
```

## Command reference

| Command | What it does | Example |
|---|---|---|
| `kindling init` | Interactive setup: pick a Chrome profile, Kindle address, stale threshold, and auth method (OAuth or SMTP app-password). | `kindling init` |
| `kindling snapshot` | Records currently-open tabs into the ledger without running the rest of the pipeline. Useful for building up history before your first real run. | `kindling snapshot` |
| `kindling run` | Runs the full pipeline: snapshot → select stale tabs → filter → extract → build EPUB → send → record. | `kindling run` |
| `kindling run --dry-run` | Same, but stops before building or sending — prints what would be included, skipped, and why. | `kindling run --dry-run` |
| `kindling status` | Shows your config, Kindle address, threshold, and a ledger summary (tracked/sent/stale counts, digest count). | `kindling status` |
| `kindling history` | Lists every digest sent, its articles, and flags any URL you reopened afterward. | `kindling history` |
| `kindling send <url...>` | Extracts and sends specific URLs right now, ignoring the staleness gate (block/allow rules and safety filters still apply). | `kindling send https://example.com/great-article` |
| `kindling block <domain>` | Adds a domain to your personal exclusion list — it will never be sent. | `kindling block news.ycombinator.com` |
| `kindling allow <domain>` | Force-includes a domain even if it's in the shipped default exclusion list. | `kindling allow github.com` |
| `kindling agent install` | Installs a `launchd` agent that runs `kindling run` every `scheduleHours` (default 6); logs to `~/.local/share/kindling/agent.log`. | `kindling agent install` |
| `kindling agent uninstall` | Removes the scheduled agent. | `kindling agent uninstall` |

## How it works

```
Chrome session file (one profile, read-only)
        │
        ▼
   snapshot ──► ledger (first-seen / sent / reopened, JSON on disk)
        │
        ▼
 select tabs open ≥ staleHours (default 48h)
        │
        ▼
 filter: dedupe + default exclusions + your block/allow rules
        │
        ▼
 extract: tiered fetch → Defuddle → Readability → article gate
        │
        ▼
   build EPUB (cover, TOC, per-article header, split if > 50MB)
        │
        ▼
   send (Gmail API, gmail.send scope — or SMTP app-password fallback)
        │
        ▼
   record digest + sent URLs back into the ledger
```

The tiered fetcher is the part doing the real work under the hood: a plain HTTP GET first (fast, works for most sites), then your own installed Chrome driven headlessly via the DevTools Protocol if that fails or comes back thin (defeats SPAs and bot challenges), then a Wayback Machine snapshot as the last resort. Every article records which tier and engine won, and that's surfaced in `--dry-run` and `history`. See [`docs/interfaces.md`](./docs/interfaces.md) for the exact module contracts, and `docs/REWORK-REPORT.md` for the security hardening that went into that layer (SSRF guards, sanitizer bypasses, etc.).

## Privacy & trust

Kindling is built around one promise: **nothing leaves your machine except the digest email you send to yourself.** No accounts, no analytics, no phone-home, no remote server of any kind — there is no "us" to send data to. Full detail, including exactly what's read, what's stored, and where:

- **[docs/PRIVACY.md](./docs/PRIVACY.md)** — what Kindling reads, stores, and transmits, in plain language.
- **[SECURITY.md](./SECURITY.md)** — the threat model, why sending uses a send-only revocable OAuth token instead of your password, and how to audit the claims yourself.

## Roadmap

Known gaps, in rough priority order:

- **PDF tabs.** Research PDFs left open as browser tabs currently can't be extracted — the HTML engines (Defuddle/Readability) need a DOM to work with, and PDF support isn't wired up yet.
- **The Chrome extension.** `extension/` and `native-host/` are scaffolded for a Phase-3 companion extension: live tab ages in the toolbar, "send now" for a single tab, opt-in close-after-send, and a history UI. Not yet functional.
- **A local "article-ness" classifier.** Right now the article gate is a word-count/quality-score heuristic; a small local classifier could catch more edge cases (thin listicles, paywalled stubs) without adding any network dependency.
- **Linux/Windows support.** Chrome session-file paths, Keychain-based secret storage, and the launchd automation are all macOS-specific today.

## Contributing

Bug reports, corpus additions (real pages that break extraction), and PRs are welcome — see **[CONTRIBUTING.md](./CONTRIBUTING.md)** for repo layout, invariants PRs must preserve, and how to run the test suite.

## License

[MIT](./LICENSE) © Shiven Tripathi
