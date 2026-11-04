---
title: Desktop, web, and mobile
description: What differs between the Infrawrench desktop app, web app and mobile app, and how to pick the right one.
sidebar_order: 4
---

Infrawrench comes as a desktop app, a hosted web app and a [mobile app](../features/mobile-app.md). Desktop and web have the same plugins and the same interface. The main differences are where your credentials live and how network connections are made. The mobile app is a companion to a cloud organization, with a smaller set of features built for reading and responding.

## At a glance

| Feature                                     | Desktop                                   | Web                                 | Mobile                                                     |
| ------------------------------------------- | ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| Works offline                               | Yes                                       | No                                  | No                                                         |
| Credential storage                          | Local SQLite, AES-256-GCM                 | Server-side, encrypted              | None (uses your cloud org)                                 |
| Sign-in                                     | None required                             | Email / Google / Microsoft          | Same as web                                                |
| SSH terminal                                | Native, direct connection                 | Proxied through the server          | Proxied through the server                                 |
| SQL / KV console                            | Native drivers                            | Proxied                             | Proxied, no SQL schema browser                             |
| File browsers                               | GCS, S3, R2, Azure Blob, + SFTP           | GCS, S3, R2, Azure Blob, + SFTP     | SFTP (proxied through the cloud)                           |
| Docker                                      | Native socket / TCP                       | Remote TCP only                     | Remote TCP only                                            |
| Team / billing                              | Full org settings when signed in to cloud | Full multi-user, Stripe billing     | View team; billing read-only                               |
| Audit log, API keys                         | Paid plan (when signed in to cloud)       | Paid plan                           | Paid plan (keys view/revoke only)                          |
| SSH agent                                   | System keys + Pageant (Windows)           | System keys server-side             | Org SSH keys server-side                                   |
| Cloud sync                                  | Optional, push-only                       | n/a (you are the cloud)             | n/a (always talks to the cloud)                            |
| [AI chat](../features/ai-chat.md)           | When signed in to cloud                   | Yes                                 | Yes                                                        |
| Push notifications                          | n/a                                       | Configured in settings              | [Delivered here](../features/mobile-push-notifications.md) |
| [Slack alerts](../features/slack-alerts.md) | n/a (pages become OS notifications)       | Connect a workspace, route channels | Connect and route channels                                 |
| [Teams alerts](../features/teams-alerts.md) | n/a (pages become OS notifications)       | Add channels by webhook URL         | Add channels by webhook URL                                |

## Which one should you use?

- **Working solo, want offline, don't want credentials on a server:** desktop.
- **Working as a team, want a shared workspace, audit log and API access:** web.
- **On the move or on call:** mobile, alongside either. It's where [push notifications](../features/mobile-push-notifications.md) land, and it covers browsing, dashboards, chat and SSH. Heavy editing stays on the bigger screens.
- **Both desktop and web:** run desktop and link it to a web workspace. Credentials stay encrypted in both places. Sync is one-way for now: desktop pushes its changes up to the workspace, but changes made on the web don't come back down to desktop yet.

## What the mobile app covers

The [mobile app](../features/mobile-app.md) signs in to a cloud org. You get:

- dashboards and budgets (view only)
- the account and resource browser, with detail pages (actions, logs, metrics)
- global search
- AI chat with action approvals
- the SSH terminal and Kubernetes pod shells
- the SQL editor, KV console and document browsers
- container actions and integration panes
- workflows and agent sessions (view only)
- org settings

Billing is read-only, code editors (manifests, bucket policies, workflows) stay on web and desktop, and you can't edit dashboards from your phone. See the [mobile app page](../features/mobile-app.md) for the full list.

## What the web app can connect to

The web app's servers are shared by every organization, so every connection they make for you is checked first. That covers plugin API calls, database, Redis and Kafka connections, Docker daemons, a kubeconfig's API server, SSH and SFTP sessions, and a workflow's `resource.ssh()`.

- **Never reachable:** loopback (`127.0.0.1`, `::1`, `localhost`), link-local addresses including cloud metadata endpoints (`169.254.169.254`), multicast and other reserved ranges, in every IPv4 and IPv6 form. Unix sockets (`unix:///var/run/docker.sock`, a Postgres socket directory, a Redis socket path), local database files (`file:` libSQL URLs) and connection-string options that read files from disk (Postgres `sslrootcert`, `sslcert`, `sslkey`) are refused too. Paste a certificate into the account's CA field instead.
- **Private addresses** (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, the `100.64.0.0/10` carrier-grade NAT range and IPv6 unique-local `fc00::/7`) **aren't reachable directly by default**. Reach a private host from inside your own network instead: a [bastion](../features/bastion-vms.md) for a plugin's API calls, an [SSH tunnel](../features/ssh-tunnels.md) for database, cache, Docker and other driver connections, and a [jumpbox](../features/ssh-jumpbox.md) for SSH sessions. Self-hosted deployments can allow private addresses with the `EGRESS_ALLOW_PRIVATE_NETWORKS` server setting.

The desktop app connects from your own machine and has none of these limits. `localhost`, your LAN and local sockets all work.

## Differences to know about

- **[`infrawrench` CLI](../features/cli.md):** ships with the desktop app, so the terminal experience is desktop-only. Once you're signed in it can browse all your cloud organizations.
- **SFTP file browser:** available on desktop (direct SSH connection) and mobile (through the cloud). The web app can't open an SFTP file browser.
- **Docker Unix socket:** desktop only. On the web you need a remote Docker daemon reachable over TCP at a public address, or through an SSH tunnel or bastion if it's private.
- **[Connect with OAuth](../features/connect-with-oauth.md):** the same providers on the web and in desktop cloud mode. For accounts stored locally on desktop, only providers that allow signing in back to an app on your own computer are offered. The rest take a pasted token.
- **Pageant:** Windows desktop only.
- **Ephemeral Kubernetes scratch pods:** work in both. The launch button opens a [terminal](../features/ssh-terminal.md), which is proxied on the web.
- **[AI chat](../features/ai-chat.md):** needs a cloud org. On desktop it appears once you sign in to Infrawrench Cloud and pick an organization. In local-only mode there's no chat.
- **[Deploying](../features/infrafile.md):** on desktop, follows the org switcher. With an organization selected, the Deploy tab is the web app's full Deploy screen (repository picker, hosted builds, deploy-on-push, rollbacks). In local mode it shows the history of what `infrawrench deploy` built on this machine. You run local deploys from the terminal, where your working tree and Docker daemon are.
- **[Potential savings](../features/orphan-finder.md):** works in both modes. Local desktop mode can scan this machine's workspace without credentials or network, but it doesn't show the cost column, because spend is collected by the cloud.
- **[Environment diff](../features/environment-diff.md):** works in both modes. With an organization selected it compares what the cloud has already synced, so it's instant, needs no credentials and is as fresh as the last sync. In local mode it lists both accounts live from the provider, which is slower and needs the accounts' credentials. If listing a resource type fails, that type is left out and reported rather than counted as missing.
- **[Agents](../features/agents.md):** on desktop, follow the org switcher. In local mode, sessions live on this machine, their VMs are set up from here, and a session can use a local folder. With an organization selected you get the org's sessions (the same ones the web app shows), with the GitHub repository picker but no local folders. The two sets are separate, and only org mode can target an account that lives in the organization.
- **[Workflows](../features/workflows.md):** on desktop, follow the org switcher. Local mode gives you local workflows that run on your machine. With an organization selected you get the org's workflows (the same ones the web app shows), with git and budget triggers. The two sets are separate and nothing is copied between them.
- **Organization settings:** on desktop, follow the org switcher. With an organization selected, a Settings tile appears at the bottom of the sidebar and opens the same settings as the web app: profile, team, roles, SSH keys, trusted hosts, bastions, API keys, change freezes, tag policy, approvals, notifications, billing and the audit log. Stripe checkout and password-reset links open in your system browser. In local-only mode there's no organization, so there's no Settings tile.
