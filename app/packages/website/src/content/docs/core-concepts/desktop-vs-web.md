---
title: Desktop vs web
description: What differs between the two builds, and how to pick one.
sidebar_order: 4
---

Infrawrench ships as both a desktop app and a hosted web app. They share the same plugin set and the same UI; they differ in where credentials live and how network-bound features run.

## At a glance

| Feature             | Desktop                         | Web                              |
| ------------------- | ------------------------------- | -------------------------------- |
| Works offline       | Yes                             | No                               |
| Credential storage  | Local SQLite, AES-256-GCM       | Server-side, encrypted           |
| Auth                | None required                   | WorkOS (email / Google / MS)     |
| SSH terminal        | Native, direct connection       | WebSocket proxied through server |
| SQL / KV console    | Native drivers                  | Proxied                          |
| File browsers       | GCS, S3, R2, Azure Blob, + SFTP | GCS, S3, R2, Azure Blob          |
| Docker              | Native socket / TCP             | Remote TCP only                  |
| Team / billing      | n/a                             | Full multi-user, Stripe billing  |
| Audit log, API keys | n/a                             | Paid plan                        |
| SSH agent           | System keys + Pageant (Windows) | System keys server-side          |
| Cloud sync          | Optional, OAuth PKCE, push-only | n/a (you are the cloud)          |

## Which should you use

- **Solo, want offline, don’t want your credentials on a server** → desktop.
- **Team, want a shared workspace, want audit and API access** → web.
- **Both** → run desktop and link it to a web workspace. Credentials stay encrypted in both places. Sync is currently one-way: the desktop pushes its changes up to the workspace, but changes made on the web do not flow back down to the desktop yet.

## Feature-parity gaps to know about

- **The [`infrawrench` CLI](../features/cli.md)** ships with the desktop app (it launches the app headlessly), so the terminal/TUI experience is desktop-only — though it can browse all your cloud organizations once you're signed in.
- **SFTP file browser** is desktop-only; the web app cannot open a raw SSH file system.
- **Docker Unix socket** is desktop-only; web needs a remote Docker daemon reachable over TCP.
- **Pageant** is Windows desktop only.
- **Ephemeral Kubernetes scratch pods** work in both, but the launch button opens a [terminal](../features/ssh-terminal.md) which on web is proxied.
