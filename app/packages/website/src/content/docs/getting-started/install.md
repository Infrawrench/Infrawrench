---
title: Install infrawrench
description: Choose the infrawrench desktop app or web app, install or sign up, and get to an empty workspace.
sidebar_order: 1
---

Infrawrench comes in three forms. Desktop and web have the same plugins, resource views and features. The difference is where your credentials live and how you sign in. Mobile is a companion to your cloud organization with a smaller set of features. For the full comparison, see [Desktop, web, and mobile](../core-concepts/desktop-vs-web.md).

- **Desktop app:** local-first. Credentials live in an encrypted database on your machine, and nothing leaves it unless you turn on cloud sync. No sign-in needed.
- **Web app:** hosted and multi-user. Sign in with email or SSO, invite your team, share an organization.
- **[Mobile app](../features/mobile-app.md):** iOS and Android companion to your cloud org, with dashboards, resource browsing, chat, terminals and push notifications on the go.

You can start with either and link them later.

## Desktop app

### Download

Get the build for your platform:

- **macOS:** universal `.dmg`
- **Windows:** `.msi`
- **Linux:** `.AppImage` or `.deb`

![Download page with platform buttons](https://agent-assets.infrawrench.com/docs-screenshots/getting-started/install/download-modal.png)

Credentials are stored in a local SQLite database, encrypted with AES-256-GCM using a key held in your OS keychain.

### First run

The first time you open the app, a welcome screen explains what signing in to Infrawrench Cloud adds (syncing to web and mobile, team organizations, cloud workflows and deployments, budgets and alerts) and gives you two options:

- **Sign in to Infrawrench Cloud:** opens your browser to sign in. When you're back, pick the organization to start in, or **Use locally for now**. If you're not in an organization yet, the app sends you to the web to create one and picks it up when you return.
- **Continue without an account:** go straight to a fully local workspace. Nothing is uploaded, and you can sign in later from the sidebar.

<insert [First-run welcome screen listing the cloud perks with Sign in and Continue without an account buttons] here>

Either way, next you click **Add account** to connect your first cloud or service. See [Add your first account](./add-first-account.md).

### SSH keys

- **macOS / Linux:** keys in `~/.ssh/` are picked up automatically for the [SSH terminal](../features/ssh-terminal.md).
- **Windows:** Pageant is supported if it's running. Keys added to Pageant show up in the key picker.

### Updates

The app checks for updates when it starts and every four hours, and downloads them in the background. When an update is ready, Infrawrench asks if you want to restart:

- **Restart now:** quits and reopens on the new version.
- **Later:** the update is applied the next time you quit Infrawrench.

The prompt can show up a little while after the download finishes. If an update can't be prepared (most often because the disk is full), Infrawrench tells you what went wrong and tries again at its next check.

<insert [Update-ready dialog showing the version number with Later and Restart now buttons] here>

## Web app

### Create an account

1. Go to [app.infrawrench.com](https://app.infrawrench.com). There's no separate sign-up page. If you're signed out, you're sent straight to a hosted sign-in page on its own domain, where you choose email, Google or Microsoft.
2. Sign in or create your account there. You come back to Infrawrench when it's done.
3. On first sign-in you're asked to **Create your organization**. Pick a name you're happy with, since it shows in the workspace switcher.
4. Then **Choose your plan**: **Free** ($0) or **Pro** ($20 / seat / month). **Continue with Free** is fine. You can upgrade later from **Settings > Billing**. See [Billing and plans](../team-and-billing/billing-and-plans.md).

Finish sign-up in the same browser you started in. Verifying your email can send you to your inbox and back, and if you land in a different browser (say, a link opened inside a mail app), you'll see a **Sign-in could not be completed** page and have to start again. Taking your time is fine. Switching browsers halfway isn't.

<insert [The "Create your organization" onboarding screen, the first thing Infrawrench itself draws after a successful sign-in] here>

### After sign-up

You land on an empty dashboard with no accounts in the sidebar yet. Next:

- **Add an account:** connect a cloud or service so infrawrench can list your resources. Start with [Add your first account](./add-first-account.md).
- **Invite your team** (optional): see [Organizations and invites](../team-and-billing/organizations-and-invites.md).

### Free vs paid

The free tier includes:

- 1 user
- Up to 3 connected accounts
- No audit log, no API keys

Paid ($20 / seat / month) removes those limits and adds the [audit log](../team-and-billing/audit-log.md) and [API keys](../team-and-billing/api-keys.md). See [Billing and plans](../team-and-billing/billing-and-plans.md).

## Use both together

You can link the two apps so the same workspace is available in both. Credentials stay encrypted at rest on both sides.

- **Desktop to web:** in the desktop app open **Settings > Cloud sync**, click **Link account**, sign in through your browser, and pick the organization to sync into.
- **Web to desktop:** install the desktop app, sign in to the same organization from **Settings > Cloud sync**, and your resources come down so you can work offline. Both stay in sync when you reconnect.

You can unlink any time. The desktop copy isn't deleted.
