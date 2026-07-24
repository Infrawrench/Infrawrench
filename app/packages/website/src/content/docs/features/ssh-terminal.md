---
title: SSH terminal
description: Open a shell in any VM you can reach over SSH, without leaving the app.
sidebar_order: 3
---

Any resource that represents a VM — EC2 instance, GCP instance, DigitalOcean Droplet, Hetzner server, Scaleway instance, Fly machine, generic SSH host — has an **SSH** button on its detail page. Clicking it opens a terminal right inside the app (xterm.js).

<insert [Resource page with SSH button, and a terminal panel open beside it] here>

## Picking a key

The first time you SSH to a host, you are prompted for a key.

**Desktop:** the picker lists keys found in `~/.ssh/` plus any keys you have saved in [SSH keys](../team-and-billing/ssh-keys.md). External SSH agents are also offered when running:

- **1Password** (macOS / Linux / Windows) — appears as a `1Password` row when the 1Password SSH agent socket is reachable. Enable it in **1Password → Settings → Developer → Use the SSH agent**. Selecting it routes authentication through 1Password; you'll see a biometric / unlock prompt on the host machine when a key is used.
- **Pageant** (Windows only) — appears when `pageant.exe` is running. Selecting it uses whichever keys Pageant is currently holding.

**Web:** the picker lists keys saved in [SSH keys](../team-and-billing/ssh-keys.md). The web app cannot read files from your machine.

Once picked, the choice is remembered for that host.

## Username

Infrawrench auto-derives the username from the key comment if possible (e.g. `astrid@laptop` → `astrid`). Override it in the connection form if needed.

## Quality of life

- Copy on selection — anything you highlight with the mouse is sent to the system clipboard.
- Paste with **Cmd + V** on macOS, **Ctrl + Shift + V** on Linux/Windows. Plain Ctrl + V is left alone so readline's quoted-insert keeps working.
- Resize by dragging — the remote pty resizes with the pane.
- Scrollback is kept per-session until you close the tab.

## Agent forwarding

The SSH view has a **Forward SSH agent** checkbox above the terminal. When enabled, the same key you used to log in is exposed back to the remote host via the standard OpenSSH agent protocol. That means `git clone git@github.com:...` (or `ssh user@another-host` from the remote) authenticates with your local key — no need to copy private keys onto the server.

- Off by default. The setting is remembered per resource.
- Takes effect on the next connection; toggling does not kill an active session.
- **No setup required.** Infrawrench exposes your selected key through a built-in, in-process agent. You do not need to run `ssh-agent`, configure `SSH_AUTH_SOCK`, or install Pageant.
- If you authenticated with **Pageant** (Windows) or the **1Password** SSH agent, that agent itself is forwarded instead — so all of the keys it holds become available on the remote. With 1Password, each remote sign-request still surfaces a biometric / unlock prompt on your local machine.
- Works in **desktop local**, **desktop cloud**, and **web** modes. In cloud/web mode the in-process agent runs on the Infrawrench Cloud server using the same encrypted key it already uses to open the SSH connection; the forwarded key never leaves the proxy.
- **Cloud audit trail.** In cloud/web mode, each forwarded sign-request the proxy performs on your behalf is recorded in the [audit log](../team-and-billing/audit-log.md). Look for action `ssh.agent.session_opened` (one per session) and `ssh.agent.sign` / `ssh.agent.sign_failed` (one per remote SSH challenge). Metadata includes the SSH key id, the target host, and the username used.
- **Security:** a compromised remote can use the forwarded key against any other host that accepts it. Only enable for hosts you trust. The blast radius is one key — the one you logged in with — not your entire keyring.

<insert [SSH view toolbar showing the "Forward SSH agent" checkbox above the terminal] here>

## Security notes

- Keys never leave your machine in desktop mode.
- In web mode, the server proxies the SSH connection; private keys are stored encrypted server-side and held in memory only for the duration of the session.
- Host-key pinning is on by default. The first connection to a host — and any connection where the host key has changed — shows a trust prompt with the presented fingerprint before continuing. This applies everywhere a terminal opens: the desktop app (native prompt), the web app, and desktop sessions proxied through the cloud. Web/cloud pins are stored per organization and can be reviewed under **Settings → SSH host keys**; desktop-local pins live on your machine.

## Not seeing the SSH button?

- The resource type may not be SSH-capable (e.g. managed databases — use the [SQL editor](./sql-editor.md) instead).
- The instance may not expose a public IP. In that case, set up an [SSH tunnel](./ssh-tunnels.md) through a bastion.
