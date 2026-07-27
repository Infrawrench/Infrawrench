---
title: Mobile app
description: The Infrawrench app for iOS and Android — browse resources, watch dashboards, chat with the AI, and open an SSH terminal from your phone.
sidebar_order: 14
---

The Infrawrench mobile app puts your cloud organization in your pocket. It is a native iOS/Android app (built with Expo) that talks to the same cloud API as the web app — same accounts, same plugin-rendered resource views, same permissions. It is built for the on-call moments: a push notification lands, you tap it, and you are looking at the failing account — or an SSH prompt — in seconds.

> **Cloud only.** The app signs into an Infrawrench Cloud organization. There is no local-only mode on mobile — if you use the desktop app standalone, link it to a cloud org first (see [Desktop, web, and mobile](../core-concepts/desktop-vs-web.md)).

## Signing in

1. Install the app and tap **Sign in**.
2. Your browser opens the same WorkOS sign-in as the web app — email, Google, or Microsoft.
3. After sign-in you are redirected back into the app and land on the organization picker.

Authentication uses OAuth with PKCE — no password ever touches the app — and tokens are kept in the platform secure store (Keychain on iOS, Keystore on Android). Signing in also registers the device for [push notifications](./mobile-push-notifications.md); allow notifications when prompted if you want incident and budget alerts.

You can switch organizations at any time from the org switcher; everything you see is scoped by your [role permissions](../team-and-billing/roles-and-permissions.md), exactly as on the web.

<insert [Mobile sign-in screen next to the organization picker after OAuth completes] here>

## What you can do

- **Home** — your org's default [dashboard](./dashboard.md), exactly as the web app's home page shows it: pinned resource tiles, workflow tiles, [cost graphs](./cloud-costs.md), and [budgets](./cloud-costs.md#budgets--alerts), in the order you arranged them. Cost graphs are drawn natively — every chart type, the previous-period and forecast overlays, and per-series totals in the legend — and budgets show month-to-date spend against the amount with their thresholds and forecast marker. A budget appears on the dashboard its card was added to, the same as on web and desktop, so a budget whose card lives on another dashboard is reached by opening that dashboard from the list at the bottom of this screen. Dashboards are render-only on mobile: you arrange and configure them on web or desktop.
- **Accounts & resources** — browse every connected account and drill into its resources. An account page lists every resource type the plugin exposes, nested ones like DNS records and database users included, with a search box that narrows those sections exactly as it does on web and desktop. Resource detail pages are rendered from the same plugin schemas as web and desktop, so a droplet, a bucket, or a Kubernetes deployment looks like itself — including plugin actions, a Logs tab, and metrics charts.
- **Search** — global search across your org's resources, same as [spotlight search](./spotlight-search.md).
- **SFTP files** — browse, download (to the share sheet), and upload files on SSH-capable hosts, proxied through the cloud. Object-storage browsers (GCS, S3, R2, Azure Blob) remain on web and desktop.
- **[AI chat](./ai-chat.md)** — the full org chat with streamed markdown responses, the per-conversation model picker, the spend meter, and approve/reject buttons for pending actions. Approving a risky action from the couch works the same as from the desk.
- **SSH terminal** — a real terminal on your phone; see below.
- **Workflows & agents** — read-only views of your [workflows](./workflows.md) (definitions and run history) and [agent sessions](./agents.md).
- **Settings** — team members, [API keys](../team-and-billing/api-keys.md) (view and revoke), the [audit log](../team-and-billing/audit-log.md), [SSH keys](../team-and-billing/ssh-keys.md), billing (read-only), your [push notification](./mobile-push-notifications.md) preferences, devices, and test push, and your [account settings](./account-settings.md) — name, password reset, two-factor enrolment, and active sessions.

<insert [Mobile home tab showing the default dashboard: a pinned resource card, a stacked-bar cost graph with its legend totals, and a budget card with its progress bar] here>

<insert [Mobile resource detail page for a droplet showing the schema-rendered overview, action buttons, and a metrics chart] here>

## The SSH terminal

Tap **Connect via SSH** on any SSH-capable resource and the app opens a full terminal — the same xterm.js terminal the web app uses, speaking the same WebSocket proxy protocol against the cloud, with your org's [SSH keys](../team-and-billing/ssh-keys.md). Host key verification, jumpbox routing, and the [audit log](../team-and-billing/audit-log.md) all behave exactly as they do in the [web SSH terminal](./ssh-terminal.md), because it is the same server-side session underneath.

## What stays on web and desktop

The mobile app is deliberately a read-and-respond surface. Some things are demoted or absent by design:

- **Billing is read-only** — you can see your plan and seats, but plan changes and payment details are managed on the web (App Store rules).
- **Code editors are absent** — manifest editing, the [bucket policy editor](./bucket-policy-editor.md), and [workflow](./workflows.md) editing all use Monaco, which stays on web and desktop.
- **[Secret reroll](../core-concepts/secret-rerolls.md) wizard** and NoSQL command prompts are web/desktop-only.
- **Dashboards are render-only** — every card renders live, but adding, arranging, and configuring tiles (including cost graphs and budgets) happens on web or desktop.
- **k9s and Kubernetes port-forward** are not yet supported on mobile.
- **[SQL editor](./sql-editor.md) autocomplete** is absent (queries still run).

If you try to do one of these, the app points you at the web app rather than offering a worse version of the same flow.
