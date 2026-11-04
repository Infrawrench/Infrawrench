---
title: SSH
description: Register a plain SSH host so you can open a terminal from the app.
sidebar_order: 24
---

Use the SSH plugin for hosts no cloud plugin manages: a VPS from a provider we don't cover, a home server, a Raspberry Pi. Once you add it, you get the same [SSH terminal](../features/ssh-terminal.md) as on EC2 or Droplets.

## What you can manage

- A named SSH host (host, port, username, key).

## Add a host

Fill in:

- **Host**: DNS name or IP.
- **Port**: 22 by default.
- **Username**: taken from the key comment by default. Change it if you need to.
- **Key**: pick a saved [SSH key](../team-and-billing/ssh-keys.md) or, on desktop, a key from `~/.ssh/`.
- **Connect through** (optional): pick another SSH account to use as a jump host. Infrawrench connects to that host first, then to this one through it. The jump host can have its own "Connect through" target, so you can chain two or more hops. See [Jumpbox routing](../features/ssh-jumpbox.md).

![Generic SSH Add-account form with host, port, username, key picker, and the new "Connect through" dropdown set to "None (direct)"](https://agent-assets.infrawrench.com/docs-screenshots/plugins/ssh/add-account.png)

## Things you can do

- **SSH terminal**.
- **SFTP file browser** (**desktop only**). See [File browsers](../features/file-browsers.md).
- **Use it as a bastion** for an [SSH tunnel](../features/ssh-tunnels.md) to a private database.
- **Use it as a jumpbox**: pick any SSH account as the "Connect through" target of another, including the one the [Connect through jumpbox](../features/ssh-jumpbox.md) action creates on a cloud VM.

## Tips & limits

- Host keys are pinned by default. The first connection records the host key, and you're asked before continuing if it ever changes.
- To route through a jump host, set "Connect through" on the form, or use the [Connect through jumpbox](../features/ssh-jumpbox.md) button on any cloud VM.
