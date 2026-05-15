---
title: SSH terminal
description: Open a shell in any VM you can reach over SSH, without leaving the app.
sidebar_order: 3
---

Any resource that represents a VM — EC2 instance, GCP instance, DigitalOcean Droplet, Hetzner server, Scaleway instance, Fly machine, generic SSH host — has an **SSH** button on its detail page. Clicking it opens a terminal right inside the app (xterm.js).

<insert [Resource page with SSH button, and a terminal panel open beside it] here>

## Picking a key

The first time you SSH to a host, you are prompted for a key.

**Desktop:** the picker lists keys found in `~/.ssh/` plus any keys you have saved in [SSH keys](../team-and-billing/ssh-keys.md). On Windows, if Pageant is running, its keys also appear.

**Web:** the picker lists keys saved in [SSH keys](../team-and-billing/ssh-keys.md). The web app cannot read files from your machine.

Once picked, the choice is remembered for that host.

## Username

Infrawrench auto-derives the username from the key comment if possible (e.g. `astrid@laptop` → `astrid`). Override it in the connection form if needed.

## Quality of life

- Copy on selection — anything you highlight with the mouse is sent to the system clipboard.
- Paste with **Cmd + V** on macOS, **Ctrl + Shift + V** on Linux/Windows. Plain Ctrl + V is left alone so readline's quoted-insert keeps working.
- Resize by dragging — the remote pty resizes with the pane.
- Scrollback is kept per-session until you close the tab.

## Security notes

- Keys never leave your machine in desktop mode.
- In web mode, the server proxies the SSH connection; private keys are stored encrypted server-side and held in memory only for the duration of the session.
- Host-key pinning is on by default. Changed host keys prompt before continuing.

## Not seeing the SSH button?

- The resource type may not be SSH-capable (e.g. managed databases — use the [SQL editor](./sql-editor.md) instead).
- The instance may not expose a public IP. In that case, set up an [SSH tunnel](./ssh-tunnels.md) through a bastion.
