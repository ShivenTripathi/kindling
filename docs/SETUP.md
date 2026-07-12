# Setup guide

This is the detailed walkthrough for getting Kindling running end to end. The short version lives in the [README](../README.md#quick-start); this document exists because one step — creating a Google OAuth client — is fiddly the first time and worth doing carefully.

- [1. Prerequisites](#1-prerequisites)
- [2. Install Kindling](#2-install-kindling)
- [3. Find your Send-to-Kindle address](#3-find-your-send-to-kindle-address)
- [4. Create a Google OAuth client (recommended path)](#4-create-a-google-oauth-client-recommended-path)
- [5. Run `kindling init`](#5-run-kindling-init)
- [6. Alternative: SMTP app-password fallback](#6-alternative-smtp-app-password-fallback)
- [7. First run](#7-first-run)
- [Troubleshooting](#troubleshooting)

## 1. Prerequisites

- macOS, with Google Chrome installed and at least one profile you actively use.
- Node.js 20 or newer (`node -v`).
- A Gmail account you're willing to send from (it can be the same account you read your tabs from, or a different one — Kindling doesn't care, as long as it's approved as a Send-to-Kindle sender).
- Access to [Amazon's "Manage Your Content and Devices"](https://www.amazon.com/mycd) page, to find your Kindle email address.

## 2. Install Kindling

```sh
npm install -g kindling
```

or, from a clone of the repo:

```sh
git clone https://github.com/ShivenTripathi/kindling.git
cd kindling
npm install
npm link
```

Either way you should now have a `kindling` command on your `$PATH`. Confirm with:

```sh
kindling --help
```

## 3. Find your Send-to-Kindle address

1. Go to [amazon.com/mycd](https://www.amazon.com/mycd) → **Preferences** → **Personal Document Settings**.
2. Under **Send-to-Kindle E-Mail Settings**, find the address for the Kindle you want digests to land on. It ends in `@kindle.com` (or `@free.kindle.com`).
3. Still on that page, scroll to **Approved Personal Document E-mail List** and **add the Gmail address you plan to send from**. This step is easy to miss and is the single most common reason a first digest silently fails to deliver — Amazon drops mail from senders that aren't on this list, with no bounce to you.

Keep this tab open; you'll need the Kindle address again during `kindling init`.

## 4. Create a Google OAuth client (recommended path)

Kindling's default send method is OAuth2 scoped to `gmail.send` — a token that can send mail and nothing else, revocable at any time, stored only in your macOS Keychain (see [SECURITY.md](../SECURITY.md) for why). To get one, you need to register a small OAuth client with Google. This takes about five minutes and you only do it once.

### 4.1 Create or select a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or reuse an existing personal one — this doesn't need to be anything fancy, it's just a container for the OAuth client).

### 4.2 Enable the Gmail API

1. In the console, go to **APIs & Services → Library**.
2. Search for **Gmail API** and click **Enable**.

This is what allows your project's OAuth client to call `gmail.send` at all — without it, authorization will succeed but sending will fail.

### 4.3 Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** as the user type. (Internal is only available for Google Workspace organizations; a personal Gmail account needs External.)
3. Fill in the required fields — app name (e.g. "Kindling"), your email as the support contact, your email again as the developer contact. You don't need a logo, a privacy policy URL, or anything else for personal use.
4. On the **Scopes** step, you can skip adding scopes here — Kindling requests them at authorization time.
5. On the **Test users** step, **add your own Gmail address as a test user.** This is the important part: apps in "Testing" status can only be used by accounts explicitly added as test users, but in exchange you completely skip Google's verification process (which is meant for apps served to the public, not a personal CLI tool). Test-mode tokens are fully functional and don't expire any faster than production ones for this purpose.
6. Save. You do not need to publish the app.

### 4.4 Create the OAuth client ID

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app.** This matters — Desktop app clients are the type Google issues a client secret for that's safe to embed in a local CLI, and they support the **loopback redirect + PKCE** flow, which is what lets `kindling init` open your browser, catch the redirect on `localhost`, and exchange the code for a token without running any public-facing redirect infrastructure. (A "Web application" client would expect a hosted redirect URI, which Kindling — having no server — doesn't have.)
3. Give it any name (e.g. "Kindling CLI").
4. Click **Create**. Google shows you a **Client ID** and **Client secret** — copy both somewhere safe for the next step. You can always find them again under Credentials later.

## 5. Run `kindling init`

```sh
kindling init
```

Walk through the prompts:

1. **Chrome profile** — pick the one profile you want Kindling to read tabs from. It will never touch any other profile on the machine.
2. **Send-to-Kindle address** — paste the `@kindle.com` address from step 3.
3. **Approved sender Gmail address** — the Gmail address you added to Amazon's approved list.
4. **Stale threshold** — how many hours a tab has to sit open before it's a candidate (default 48).
5. **Auth method** — `oauth` (default, recommended) or `smtp`.
6. If you chose `oauth`: paste the **Client ID** and **Client secret** from step 4.4 when prompted. Kindling then opens your browser to Google's consent screen.

You'll see a consent screen listing exactly two permissions:

- **Send email on your behalf**
- **See your primary Google Account email address**

That second line is only used to label which account the stored token belongs to — Kindling never reads anything with it. Approve, and the browser will show a simple "you can close this tab" confirmation. Back in the terminal, you'll see:

```
Connected as you@gmail.com. Refresh token stored in your Keychain.

✅ Setup complete. Try:  kindling run --dry-run
```

That refresh token — send-only, revocable at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) — is now in your macOS Keychain. It's never written to a config file or logged.

## 6. Alternative: SMTP app-password fallback

If you'd rather not create an OAuth client — or you want to avoid granting even the "see your email address" scope — Kindling supports a documented SMTP fallback using a Gmail **app password**. It's a two-minute setup at the cost of a slightly less scoped credential (an app password can authenticate SMTP, not arbitrary Gmail API access, but it isn't as narrowly scoped as `gmail.send`).

1. Your Google account needs 2-Step Verification turned on (app passwords require it).
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and generate a new app password (name it "Kindling" or similar).
3. During `kindling init`, choose `smtp` for the auth method, then paste the app password when prompted. It's stored in the Keychain under your sender email, never in a file.

Kindling sends over SMTP-over-TLS to `smtp.gmail.com:465` using `AUTH LOGIN` with that password — no OAuth scopes requested at all with this path.

## 7. First run

```sh
kindling run --dry-run
```

This snapshots your open tabs, shows which ones are stale enough, which get filtered out (and why), and what would be extracted — without sending anything or writing an EPUB. Once that looks right:

```sh
kindling run
```

See [docs/demo.md](./demo.md) for what the full output looks like end to end.

To have it run on its own, install the scheduled agent:

```sh
kindling agent install
```

This writes a macOS `launchd` LaunchAgent that runs `kindling run` every `scheduleHours` (config field, default 6), logging to `~/.local/share/kindling/agent.log`. Stop it anytime with `kindling agent uninstall`. You can also send specific URLs on demand without waiting for the staleness gate: `kindling send https://example.com/great-article`.

## Troubleshooting

**"Message rejected" / digest never arrives, no error from Kindling**
Almost always means your sender address isn't on Amazon's approved list yet. Go back to [step 3](#3-find-your-send-to-kindle-address) and add it under **Personal Document Settings → Approved Personal Document E-mail List**. Amazon silently drops mail from unapproved senders — Kindling has no way to detect this from the Gmail API's perspective, since the send itself succeeds.

**"No Google OAuth client configured" when running `kindling run`**
`kindling init` was interrupted before you entered the Client ID/secret, or the Keychain entries were deleted. Re-run `kindling init` and go through the OAuth section again ([step 4](#4-create-a-google-oauth-client-recommended-path)-[5](#5-run-kindling-init)).

**Token expired / revoked**
If you revoked access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), or Google invalidated the test-mode token, `kindling run` will fail on `getAccessToken`. Run `kindling init` again to re-authorize — the new refresh token replaces the old one in Keychain.

**"Chrome not found" / tier-2 fetch fails**
The extraction pipeline's second-tier fetch drives your already-installed Chrome headlessly for pages that block plain HTTP requests. If Chrome isn't installed, or isn't in its default macOS location, that tier can't run and extraction falls through to the Wayback Machine tier (or fails, if the page isn't archived). Make sure Google Chrome — not just Chromium or another browser — is installed normally via the standard `.app` bundle.

**"No config found" / "Profile not found"**
Run `kindling init` first — every other command reads `~/.config/kindling/config.json`, which only `init` creates. If you changed your Chrome profile name/folder (e.g. added a new profile in Chrome), re-run `kindling init` to pick the current one; `profileId` must match an actual profile directory name under Chrome's user data dir (e.g. `Default`, `Profile 1`).

**Config validation errors ("Unknown config key…" / "must be a positive number")**
`~/.config/kindling/config.json` is validated strictly — unknown keys and malformed values are rejected with the specific field named in the error. If you hand-edited it, check the field list in [`docs/interfaces.md`](./interfaces.md#srcconfigjs) against what you wrote.
