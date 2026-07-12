# Kindling — desktop app (Tauri)

The desktop companion. Its reason to exist: it reads Chrome's **on-disk session
files**, so it can build and send your digest **even when Chrome is closed** —
something a browser extension can't do. It reuses `@kindling/core` in the
webview and adds a small Rust backend for file access and **SMTP** sending (an
app password — no OAuth dance).

## Prerequisites

- **Rust** (stable) + Xcode Command Line Tools (macOS). `rustup default stable`.
- Node ≥ 20.

## Run it (dev)

```sh
npm install                                   # repo root
npm run build:ui --workspace @kindling/desktop   # bundle the webview → dist/
npm run dev --workspace @kindling/desktop        # tauri dev (launches the window)
```

`npm run dev` runs `tauri dev`, which compiles the Rust backend and opens the
app. First compile downloads/builds the Tauri + lettre crate tree (a few
minutes); subsequent runs are fast.

## Build a bundle

```sh
npm run build --workspace @kindling/desktop      # tauri build → signed .app/.dmg
```

(Bundling/signing needs the usual macOS codesign setup; unsigned local builds
work for personal use.)

## Setup in the app

1. Pick your Chrome **profile**.
2. In **Settings**: your Send-to-Kindle address, your sender email, and SMTP —
   host `smtp.gmail.com`, port `465`, your Gmail, and a **Gmail app password**
   (create one at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)).
   The password is stored locally only.
3. It lists tabs open past your threshold (or toggle to send all open tabs).
   Hit **Send to Kindle**. Set an auto-run interval to have it run on a timer
   while open (true background/autostart is a follow-up).

## How it works

Rust commands (`list_chrome_profiles`, `newest_session_bytes`, `send_smtp`,
`app_data_dir`) handle the OS-level bits; the browser-safe SNSS parser
(`@kindling/core/snss`) turns the session bytes into open tabs; the tiered work
(screen → fetch via Tauri's native HTTP → extract → EPUB → SMTP → ledger) is the
same `runDigest` pipeline the extension and CLI use. Config + history live in
`~/Library/Application Support/com.kindling.desktop/`.
