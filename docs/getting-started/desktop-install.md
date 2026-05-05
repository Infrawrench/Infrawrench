---
title: Install the desktop app
description: Run infrawrench locally with credentials stored in an encrypted local database.
sidebar_order: 2
---

The desktop app is local-first. All credentials are stored in a local SQLite database, encrypted with AES-256-GCM using a key held in your OS keychain. Nothing leaves your machine unless you explicitly sync to the cloud.

## Download

Download the build for your platform:

- **macOS** — universal `.dmg`
- **Windows** — `.msi`
- **Linux** — `.AppImage` or `.deb`

<insert [Download page with platform buttons] here>

## First run

On first launch you see a local-only welcome screen. No sign-in, no account.

1. Give your workspace a name (this is only a local label).
2. Click **Add account** to connect your first cloud or service — see [Add your first account](./add-first-account.md).

<insert [First-run welcome screen] here>

## Optional: sync to the cloud

If you also want to access your workspace from a browser, you can link the desktop app to a web account:

1. Open **Settings → Cloud sync**.
2. Click **Link account** — a browser window opens for OAuth sign-in (PKCE, no shared secret).
3. Pick the organization to sync into.

Credentials stay encrypted at rest in both places. You can unlink at any time; the desktop copy is not deleted.

## SSH agent integration

- **macOS / Linux** — keys in `~/.ssh/` are auto-detected for the [SSH terminal](../features/ssh-terminal.md).
- **Windows** — Pageant is supported if running. Keys added to Pageant show up in the key picker.

## Updating

Auto-update is enabled by default. You can disable it in **Settings → Advanced**.
