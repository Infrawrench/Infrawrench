---
title: Desktop, web, and mobile
description: What differs between the three surfaces, and how to pick.
sidebar_order: 4
---

Infrawrench ships as a desktop app, a hosted web app, and a [mobile app](../features/mobile-app.md). Desktop and web share the same plugin set and the same UI; they differ in where credentials live and how network-bound features run. The mobile app is a companion to a cloud organization — it talks to the same cloud API as the web app and carries a deliberately smaller, read-and-respond feature set.

## At a glance

| Feature                                     | Desktop                                                   | Web                                 | Mobile                                                     |
| ------------------------------------------- | --------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| Works offline                               | Yes                                                       | No                                  | No                                                         |
| Credential storage                          | Local SQLite, AES-256-GCM                                 | Server-side, encrypted              | None (uses your cloud org)                                 |
| Auth                                        | None required                                             | WorkOS (email / Google / MS)        | WorkOS (same, OAuth PKCE)                                  |
| SSH terminal                                | Native, direct connection                                 | WebSocket proxied through server    | WebSocket proxied through server                           |
| SQL / KV console                            | Native drivers                                            | Proxied                             | Proxied, no SQL autocomplete                               |
| File browsers                               | GCS, S3, R2, Azure Blob, + SFTP                           | GCS, S3, R2, Azure Blob             | SFTP (proxied through the cloud)                           |
| Docker                                      | Native socket / TCP                                       | Remote TCP only                     | Remote TCP only                                            |
| Team / billing                              | n/a                                                       | Full multi-user, Stripe billing     | View team; billing read-only                               |
| Audit log, API keys                         | n/a                                                       | Paid plan                           | Paid plan (keys view/revoke only)                          |
| SSH agent                                   | System keys + Pageant (Windows)                           | System keys server-side             | Org SSH keys server-side                                   |
| Cloud sync                                  | Optional, OAuth PKCE, push-only                           | n/a (you are the cloud)             | n/a (always talks to the cloud)                            |
| [AI chat](../features/ai-chat.md)           | When signed in to cloud (proxied through the web backend) | Yes                                 | Yes                                                        |
| Push notifications                          | n/a                                                       | Configured in settings              | [Delivered here](../features/mobile-push-notifications.md) |
| [Slack alerts](../features/slack-alerts.md) | n/a (pages become OS notifications)                       | Connect a workspace, route channels | Connect and route channels                                 |
| [Teams alerts](../features/teams-alerts.md) | n/a (pages become OS notifications)                       | Add channels by webhook URL         | Add channels by webhook URL                                |

## Which should you use

- **Solo, want offline, don’t want your credentials on a server** → desktop.
- **Team, want a shared workspace, want audit and API access** → web.
- **On the move, on call** → mobile, alongside either. It is where [push notifications](../features/mobile-push-notifications.md) land, and it covers browsing, dashboards, chat, and SSH — editing-heavy work stays on the bigger screens.
- **Both desktop and web** → run desktop and link it to a web workspace. Credentials stay encrypted in both places. Sync is currently one-way: the desktop pushes its changes up to the workspace, but changes made on the web do not flow back down to the desktop yet.

## The mobile app in brief

The [mobile app](../features/mobile-app.md) signs into a cloud org and covers: dashboards and budgets (render-only), the account/resource browser with plugin-rendered detail pages (actions, logs, metrics), global search, AI chat with action approvals, the SSH terminal, read-only workflows and agent sessions, and org settings. Billing is read-only, code editors (manifests, bucket policies, workflows) stay on web/desktop, and dashboards cannot be edited from the phone — see the [mobile app page](../features/mobile-app.md) for the full list.

## Feature-parity gaps to know about

- **The [`infrawrench` CLI](../features/cli.md)** ships with the desktop app (it launches the app headlessly), so the terminal/TUI experience is desktop-only — though it can browse all your cloud organizations once you're signed in.
- **SFTP file browser** is available on desktop (direct SSH connection) and mobile (proxied through the cloud); the web app cannot open a raw SSH file system.
- **Docker Unix socket** is desktop-only; web needs a remote Docker daemon reachable over TCP.
- **Pageant** is Windows desktop only.
- **Ephemeral Kubernetes scratch pods** work in both, but the launch button opens a [terminal](../features/ssh-terminal.md) which on web is proxied.
- **[AI chat](../features/ai-chat.md)** requires a cloud org — the agent loop, billing, and conversation history live in the web backend. On desktop it appears once you sign in to Infrawrench Cloud and select an organization; in local-only mode there is no chat.
- **[Workflows](../features/workflows.md)** follow the org switcher on desktop: in local mode you get local workflows that run on your machine, and with an organization selected you get the org's workflows — the same ones the web app shows, with git and budget triggers available. The two sets are separate; nothing is copied between them.
