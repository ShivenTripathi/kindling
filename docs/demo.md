# Demo walkthrough

A scripted end-to-end run, useful as a script for a screen recording or a set of screenshots. All terminal output below is **illustrative** — it follows the real shape of Kindling's commands and messages, but exact wording, timings, and URLs are invented for the walkthrough.

- [1. Setup (`kindling init`)](#1-setup-kindling-init)
- [2. A dry run](#2-a-dry-run)
- [3. A real run](#3-a-real-run)
- [4. Checking status](#4-checking-status)
- [5. History, and a reopened tab](#5-history-and-a-reopened-tab)

## 1. Setup (`kindling init`)

```
$ kindling init

🔥 Kindling setup

Chrome profiles found:
  1. Personal (Default) — jane@gmail.com
  2. Work (Profile 1) — jane@company.com

Select ONLY your personal profile — Kindling never reads any other one.
Profile number [1]: 1
Your Send-to-Kindle address (…@kindle.com): jane_ABC123@kindle.com
Your approved sender Gmail address [jane@gmail.com]:
Send tabs left open for how many hours? [48]:
Send via (oauth/smtp) [oauth]:

Saved config to /Users/jane/.config/kindling/config.json

Google OAuth — see SETUP.md to create a "Desktop app" OAuth client.
OAuth client ID: 123456789-abcxyz.apps.googleusercontent.com
OAuth client secret: ••••••••••••••••

Opening your browser to grant send-only access…
Connected as jane@gmail.com. Refresh token stored in your Keychain.

✅ Setup complete. Try:  kindling run --dry-run
```

The browser window that opens shows Google's standard consent screen for a two-scope request: **"Send email on your behalf"** and **"See your primary Google Account email address."** Approving it returns you to a plain "you may close this tab" page, and the terminal picks up automatically.

## 2. A dry run

A few days later, with a dozen-plus tabs accumulated in the Personal profile:

```
$ kindling run --dry-run

7 tabs open ≥ 48h · 4 candidate(s) after filtering.
  skip  https://mail.google.com/mail/u/0/#inbox  (excluded domain: mail.google.com)
  skip  https://twitter.com/i/status/1823...      (excluded domain: twitter.com)
  skip  https://192.168.1.1/admin                 (local/private address)

  fetch https://www.theatlantic.com/technology/archive/2026/07/... … ok (1840w, defuddle, tier1)
  fetch https://stackoverflow.com/questions/789.../how-does-x-work … ok (612w, defuddle, tier1)
  fetch https://someblog.example/posts/notes-on-caching             … ok (2210w, readability, tier2)
  fetch https://paywalled-news.example/2026/07/08/story              … failed (thin content, 42 words)

3 article(s) ready for "Tab Digest · Wed Jul 08 2026".

--dry-run: stopping before build & send. Would include:
  • The Big Idea Nobody's Talking About  —  https://www.theatlantic.com/technology/archive/2026/07/...
  • How does X actually work under the hood?  —  https://stackoverflow.com/questions/789.../how-does-x-work
  • Notes on caching, three years in  —  https://someblog.example/posts/notes-on-caching
  (1 couldn't be fetched; they'd be listed on an end page)
```

Notice the `fetchTier` shown for each article — `tier1` (plain HTTP) for the first two, `tier2` (headless Chrome) for the blog post that presumably blocked or thinned out on the plain fetch. Nothing was sent; nothing was written to disk beyond the ledger update from the snapshot.

## 3. A real run

Happy with what would be included, run it for real:

```
$ kindling run

7 tabs open ≥ 48h · 4 candidate(s) after filtering.
  skip  https://mail.google.com/mail/u/0/#inbox  (excluded domain: mail.google.com)
  skip  https://twitter.com/i/status/1823...      (excluded domain: twitter.com)
  skip  https://192.168.1.1/admin                 (local/private address)

  fetch https://www.theatlantic.com/technology/archive/2026/07/... … ok (1840w, defuddle, tier1)
  fetch https://stackoverflow.com/questions/789.../how-does-x-work … ok (612w, defuddle, tier1)
  fetch https://someblog.example/posts/notes-on-caching             … ok (2210w, readability, tier2)
  fetch https://paywalled-news.example/2026/07/08/story              … failed (thin content, 42 words)

3 article(s) ready for "Tab Digest · Wed Jul 08 2026".

Built /Users/jane/.local/share/kindling/2026-07-08-a.epub (1.3 MB, 3 articles).
Sent to jane_ABC123@kindle.com.

✅ Done.
```

A few minutes later the EPUB shows up over Wi-Fi on the Kindle, titled "Tab Digest — Wed Jul 08 2026," with the paywalled story's URL listed on a short end-page rather than silently vanishing.

## 4. Checking status

```
$ kindling status

Config:   /Users/jane/.config/kindling/config.json
Profile:  Default   →  jane_ABC123@kindle.com
Threshold: 48h   Auth: oauth
Ledger:   11 URLs tracked, 3 sent, 4 stale & unsent, 1 digests.
```

## 5. History, and a reopened tab

A week goes by. Jane reopens the Atlantic piece from the first digest to re-read a paragraph, then closes it again. Meanwhile a second digest has gone out. `kindling history` shows both digests, oldest last, and flags the reopened URL:

```
$ kindling history

2026-07-15-a  ·  7/15/2026, 8:00:03 AM  ·  2 articles
    https://arstechnica.com/science/2026/07/...
    https://longreads.example/2026/07/10/essay

2026-07-08-a  ·  7/8/2026, 8:00:11 AM  ·  3 articles
  ↺ https://www.theatlantic.com/technology/archive/2026/07/...  (reopened 1×)
    https://stackoverflow.com/questions/789.../how-does-x-work
    https://someblog.example/posts/notes-on-caching

↺ = you reopened this after it was sent.
```

That `↺` marker is Kindling's only opinion about what you actually cared about — it doesn't do anything with the signal today (no re-ranking, no "you probably want more like this"), it just surfaces it so you can notice the pattern yourself.
