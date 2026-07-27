---
title: Install infrawrench
description: Pick the desktop app or the web app and get to an empty workspace.
sidebar_order: 1
---

Infrawrench ships in three forms. Desktop and web share the same plugins, resource views, and features — the difference is where your credentials live and how you sign in; mobile is a cloud companion with a deliberately smaller read-and-respond feature set. For the longer comparison, see [Desktop, web, and mobile](../core-concepts/desktop-vs-web.md).

- **Desktop app** — local-first. Credentials live in an encrypted SQLite database on your machine and nothing leaves it unless you opt in to cloud sync. No sign-in required.
- **Web app** — hosted, multi-user. Sign in with email or SSO, invite a team, share an organization.
- **[Mobile app](../features/mobile-app.md)** — iOS/Android companion to the web app's cloud org: dashboards, resource browsing, chat, terminals, and push notifications on the go.

You can start with either and link them later.

## Desktop app

### Download

Download the build for your platform:

- **macOS** — universal `.dmg`
- **Windows** — `.msi`
- **Linux** — `.AppImage` or `.deb`

<insert [Download page with platform buttons] here>

Credentials are stored in a local SQLite database, encrypted with AES-256-GCM using a key held in your OS keychain.

### First run

On first launch you see a local-only welcome screen. No sign-in, no account.

1. Give your workspace a name (this is only a local label).
2. Click **Add account** to connect your first cloud or service — see [Add your first account](./add-first-account.md).

<insert [First-run welcome screen] here>

### SSH agent integration

- **macOS / Linux** — keys in `~/.ssh/` are auto-detected for the [SSH terminal](../features/ssh-terminal.md).
- **Windows** — Pageant is supported if running. Keys added to Pageant show up in the key picker.

### Updating

The desktop app checks for updates on launch and every four hours, and downloads them in the
background. Once an update is unpacked and ready to apply, Infrawrench asks whether you want to
restart:

- **Restart now** — quits and relaunches into the new version.
- **Later** — the update is applied the next time you quit Infrawrench.

The prompt only appears once restarting is guaranteed to work, so there is a gap between the
download finishing and the prompt showing up. If preparing an update fails — most often because the
disk is full — Infrawrench tells you what went wrong instead of failing quietly, and retries on its
next check.

<insert [Update-ready dialog showing the version number with Later and Restart now buttons] here>

## Web app

### Create an account

1. Go to the sign-up page.
2. Sign in with your email, Google, or Microsoft account. Authentication is handled by WorkOS.
3. On first sign-in you are prompted to create an organization. Pick a name you can live with — it shows up in the workspace switcher.

<insert [Sign-up page with email / SSO buttons] here>

### Your first landing

After sign-up you land on an empty dashboard with a sidebar that has no accounts yet. Two things to do next:

- **Add an account** — connect a cloud or service so infrawrench can list your resources. Start with [Add your first account](./add-first-account.md).
- **Invite your team** (optional) — see [Organizations and invites](../team-and-billing/organizations-and-invites.md).

### Free tier vs paid

The free tier includes:

- 1 user
- Up to 3 connected accounts
- No audit log, no API keys

Paid ($20 / seat / month) removes those caps and unlocks the [audit log](../team-and-billing/audit-log.md) and [API keys](../team-and-billing/api-keys.md). See [Billing and plans](../team-and-billing/billing-and-plans.md).

## Using both together

The two apps can be linked so the same workspace is available in both places. Credentials stay encrypted at rest on either side.

- **Desktop → web** — open **Settings → Cloud sync** in the desktop app, click **Link account**, sign in via the browser (OAuth with PKCE, no shared secret), and pick the organization to sync into.
- **Web → desktop** — install the desktop app, sign into the same organization from **Settings → Cloud sync**, and your resources pull down so you can work offline. Both stay in sync when you reconnect.

You can unlink at any time; the desktop copy is not deleted.
