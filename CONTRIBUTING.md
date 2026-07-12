# Contributing to Kindling

Thanks for considering it. Kindling is small and intentionally dependency-light — the goal is for a stranger to be able to read the whole thing and trust it. That bar shapes everything below.

## Repo layout

```
src/
  tabs/          — read open tabs from a Chrome profile's SNSS session files (no native deps)
  ledger.js      — JSON ledger: first-seen / sent / reopened history, atomic writes
  filter.js      — URL normalization, dedupe, default exclusion list, block/allow rules
  extract/       — content extraction: tiered fetch, Defuddle → Readability engine chain, article gate
  epub.js        — assemble the digest EPUB (cover, TOC, per-article header, size splitting)
  gmail/         — OAuth2 (loopback + PKCE), Keychain token storage, Gmail API send, SMTP fallback
  config.js      — load/validate ~/.config/kindling/config.json
  cli.js         — commander CLI wiring it all together
extension/       — Phase-3 MV3 companion extension (in progress, not yet functional)
native-host/     — native messaging bridge for the extension (in progress)
test/            — node:test suite, one file per module, plus fixtures/
docs/
  interfaces.md  — the contract every module codes against — READ THIS FIRST
  PRIVACY.md, SETUP.md, demo.md, images/
```

**`docs/interfaces.md` is the source of truth for every module's public signature.** Before touching a `src/` module, read the section for it there. If your change alters a signature, update `interfaces.md` in the same PR and call it out clearly in the PR description — other modules and tests are written against those contracts, not against the implementation.

## Building and testing

```sh
npm install
npm test          # node:test suite — every module has tests
npm run typecheck # JSDoc types checked via tsc (--checkJs --noEmit; no build step)
npm run lint       # eslint
npm run format     # prettier --write .
```

CI (`.github/workflows/ci.yml`) runs on `macos-latest` with Node 20 and runs `typecheck` then `test`. It runs on macOS deliberately — the tab-reading and Keychain code paths are macOS-specific.

Run the CLI locally without installing:

```sh
node src/cli.js run --dry-run
```

## The invariants (do not break these)

These come from `CLAUDE.md` and are the actual reason people can trust this tool with their browsing habits and their Gmail send permission. Any PR that weakens one of these needs a very good reason and should be flagged explicitly for discussion, not slipped in incidentally:

1. **Local-only, zero telemetry.** No data leaves the machine except the one digest email to the user's own Kindle address. No analytics, no crash reporting, no remote logging — ever. This is the entire trust model; it's why the project is publishable at all.
2. **Profile isolation.** Only the one Chrome profile explicitly chosen at `kindling init` is ever read. Never add a code path that enumerates or reads multiple profiles, even opportunistically.
3. **Read-only on Chrome data.** Session files are read, never written. Tab-closing only happens through the (opt-in, not-yet-shipped) extension's own `chrome.tabs` API — never by touching Chrome's on-disk state directly.
4. **Least-privilege secrets.** Sending defaults to OAuth2 with the `gmail.send` scope only — never request broader scopes. Tokens and app passwords live in the macOS Keychain via `src/gmail/keychain.js`, never in a config file, never logged, never committed.
5. **Nothing silently dropped.** Any tab that gets filtered out, or any article that fails to extract, must be surfaced somewhere the user actually sees it: `--dry-run` output, `kindling history`, or the EPUB's own end-page of failed URLs. If you add a new way for a tab to be excluded, thread a reason string through so it shows up in these places — don't just `continue` past it silently.

When in doubt, re-read `SECURITY.md` and `docs/PRIVACY.md` — they describe the promises users are relying on, and any change to `src/extract/` (the network fetch layer) or `src/gmail/` (the send layer) is the highest-scrutiny surface in the codebase, since those are the only two places Kindling talks to the network at all. `SECURITY.md` documents a `grep` you can run to confirm that stays true:

```sh
grep -rn "fetch\|request\|https\?:" src/ | grep -v "test"
```

## Running against your own Chrome, safely

Kindling reads real Chrome session files and can send real email, so be deliberate when testing locally:

- Point `kindling init` at a **test or secondary Chrome profile** if you have one, not your daily-driver profile, while iterating — profile isolation means Kindling only ever reads the one you pick, but you don't want your main tab list polluting a ledger you're debugging.
- Use `kindling run --dry-run` liberally. It runs the entire pipeline — snapshot, filter, extract — without building an EPUB or sending anything, which covers almost every code path you'd want to exercise during development.
- If you need to test the send path itself, send to your own test Kindle/email rather than wiring up a real OAuth client against a shared or CI-visible account.
- `test/fixtures/` holds sample data (e.g. a tiny `.epub`) for tests that shouldn't hit the network or a real Chrome profile at all — prefer extending fixtures over adding tests that require a live browser or real credentials.

## Code style

- **ES modules** throughout (`"type": "module"` in `package.json`); use `import`/`export`, not `require`.
- **JSDoc types on every export**, checked in CI via `tsc --checkJs --noEmit` (see `npm run typecheck`) — there's no build step, types are documentation-as-contract, not compiled away. Match the `@typedef`/`@param`/`@returns` style already used in `src/` (see `docs/interfaces.md` for the canonical shapes).
- **`node:test`** for tests (`node --test 'test/**/*.test.js'`), one test file per module, colocated in `test/`.
- Functions that depend on "now" take an optional `now = new Date()` parameter so tests can inject a fixed clock — follow this pattern for any new time-dependent function (see `recordSnapshot`, `selectStale`, `recordDigest` in `src/ledger.js`).
- Prefer zero or small dependencies; if you add one, justify it in the PR description the way `src/gmail/smtp.js`'s header comment justifies hand-rolling SMTP instead of pulling in `nodemailer`. Small, stable, well-understood dependencies (like `undici`, `commander`) are fine; anything that expands the network/parsing surface needs a clear reason.
- Errors should be actionable — say what failed and how to fix it (see the error messages in `src/config.js` and `cmdInit`'s failure paths as the model to follow).
- No dead code, no `TODO`-ware merged to `main`.

## Sending a PR

- Keep PRs scoped to one module or one concern where possible — the module boundaries in `docs/interfaces.md` are meant to make this easy.
- Run `npm test`, `npm run typecheck`, and `npm run lint` before opening the PR.
- If you touched `src/extract/` (the fetch/SSRF-sensitive layer), see `docs/REWORK-REPORT.md` for the kind of adversarial review that layer has already been through, and hold new changes to the same bar (SSRF guards, sanitizer coverage, byte/timeout caps).
