# CLAUDE.md — Kindling

Kindling turns Chrome tabs you left open for 48+ hours into a clean, readable **EPUB digest** and emails it to your Kindle. Everything runs locally on the user's machine.

## The invariants (never violate)

1. **Local-only, zero telemetry.** No data leaves the machine except the single email sent to the user's Amazon Send-to-Kindle address. No analytics, no phone-home, no remote logging. This is the core trust promise and it is load-bearing for publishability.
2. **Profile isolation.** Only ONE explicitly-selected Chrome profile is ever read. Never auto-scan all profiles. The user's work profile must be untouchable by construction.
3. **Read-only on Chrome data.** Session files are read, never written. Tab-closing happens only via the extension's own `chrome.tabs` API with explicit user opt-in.
4. **Least-privilege secrets.** Sending uses OAuth2 with the `gmail.send` scope only (a revocable, send-only token) — never a full-account password when avoidable. Tokens live in the macOS Keychain, never in files or the repo.
5. **Nothing silently dropped.** Any tab skipped or article that failed to extract is surfaced in `--dry-run` output, `kindling history`, and (where relevant) an end-page of the digest — with the reason.

## Architecture

`snapshot → ledger → select stale (≥48h) → filter (exclusion list + dedupe) → extract (scored engine chain) → article gate → build EPUB → send (Gmail API) → record history`

- `src/tabs/` — read open tabs from a profile's SNSS session files (pure Node, no native deps).
- `src/ledger.js` — JSON ledger: first-seen / sent / reopened history, atomic writes.
- `src/filter.js` — URL normalization, dedupe, default exclusion list, user block/allow rules.
- `src/extract/` — content extraction: engine chain with quality scoring + "is this an article?" gate.
- `src/epub.js` — assemble the digest EPUB (cover, TOC, per-article header, Kindle-tuned CSS).
- `src/gmail/` — OAuth2 (loopback + PKCE, `gmail.send` scope), Keychain token storage, send via Gmail API.
- `src/config.js` — load/validate `~/.config/kindling/config.json`.
- `src/cli.js` — commander CLI: `init`, `run [--dry-run]`, `snapshot`, `status`, `history`, `send <url...>`, `block/allow <domain>`, `agent install/uninstall`.
- `extension/` — Phase 3 MV3 extension + `native-host/` bridge.

Contracts every module codes against: **`docs/interfaces.md`** — read it before touching any `src/` module.

## Commands

- `npm test` — run the node:test suite.
- `npm run typecheck` — JSDoc type checking via tsc (no build; types are checked, not emitted).
- `npm run lint` / `npm run format`.
- `node src/cli.js run --dry-run` — full pipeline without sending.

## Quality bar

Production-grade, MIT, meant to be published and adopted by strangers. JSDoc types on all exports (checked in CI). Every module has tests. No dead code, no TODO-ware in `main`. Errors are actionable (say what failed and how to fix). Prefer zero/small dependencies; justify each new one.
