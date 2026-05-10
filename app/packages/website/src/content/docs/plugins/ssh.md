---
title: SSH
description: Register a plain SSH host so you can open a terminal from the app.
sidebar_order: 24
---

The SSH plugin is for hosts that are not managed by any of the cloud plugins — a VPS from a provider we do not cover, a home server, a Raspberry Pi. Once registered, you get the same [SSH terminal](../features/ssh-terminal.md) experience as on EC2 or Droplets.

## What you can manage

- A named SSH host (host, port, username, key reference).

## Credentials

Fill in:

- **Host** — DNS name or IP.
- **Port** — default 22.
- **Username** — defaults from key comment; override as needed.
- **Key** — pick a saved [SSH key](../team-and-billing/ssh-keys.md) or, on desktop, a key from `~/.ssh/`.

<insert [Generic SSH Add-account form with host, port, username, key picker] here>

## Notable flows

- **SSH terminal**.
- **SFTP file browser** — **desktop only**; see [File browsers](../features/file-browsers.md).
- **Used as a bastion** for an [SSH tunnel](../features/ssh-tunnels.md) to a private database.

## Tips & limits

- Host-key pinning is on by default. First connection records the host key; later changes prompt before continuing.
- Jump host (ProxyJump) is not yet supported in the UI. Either use a tunnel or do the jump outside infrawrench.
