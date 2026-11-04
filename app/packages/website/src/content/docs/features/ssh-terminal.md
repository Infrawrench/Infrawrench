---
title: SSH terminal
description: Open a shell in any VM you can reach over SSH, without leaving the app.
sidebar_order: 3
---

Open a shell on any VM straight from Infrawrench. Any resource that is a VM (EC2 instance, GCP instance, DigitalOcean Droplet, Hetzner server, Crusoe VM, Scaleway instance, Fly machine, generic SSH host) has an **Open SSH tab** button on its detail page.

Click it and a terminal opens in its own tab, titled `SSH: <resource>`, next to the resource's tab.

![The Droplet's resource tab and its SSH tab side by side in the tab strip, with a live terminal session open on api-prod-1](https://agent-assets.infrawrench.com/docs-screenshots/features/ssh-terminal/live-session.png)

## Pick a key

The first time you connect to a host, you're asked to pick a key. Infrawrench remembers your choice for that host.

**Desktop:** you can pick keys from `~/.ssh/` or any you've saved in [SSH keys](../team-and-billing/ssh-keys.md). External SSH agents show up too when they're running:

- **1Password** (macOS, Linux, Windows): shows as a `1Password` row when the 1Password SSH agent is available. Turn it on in **1Password > Settings > Developer > Use the SSH agent**. When a key is used, 1Password asks you to unlock or confirm with biometrics.
- **Pageant** (Windows only): shows when `pageant.exe` is running, and uses whichever keys Pageant holds.

**Web:** you can pick keys saved in [SSH keys](../team-and-billing/ssh-keys.md). The web app can't read files from your machine.

## Username

Infrawrench fills in the username from the key comment when it can (for example `astrid@laptop` gives `astrid`). Change it in the connection form if you need to.

## Handy terminal features

- Copy on select: anything you highlight is copied to your clipboard.
- Paste with **Cmd + V** on macOS, or **Ctrl + Shift + V** on Linux and Windows. Plain Ctrl + V is left for the shell.
- Drag to resize, and the remote terminal resizes with it.
- Scrollback is kept until you close the tab.
- Click a URL to open it in your browser. This works for plain URLs and OSC 8 hyperlinks, so a device code page from `gh auth login` is one click instead of a copy and paste.

Only `http` and `https` links open, always in your real browser. Other schemes (`javascript:`, `file:`, `data:`) aren't treated as links, since anything a remote host prints is untrusted.

## Screen readers

Terminals work with NVDA, JAWS, VoiceOver and Orca, on desktop and web. Support is always on; there's nothing to turn on.

- **Output is read out as it arrives.**
- **Large bursts are summarised.** When a command floods the screen (a build log, `tail -f`, `yes`), you hear the first lines and then "too much output". Stop the command and page back through the buffer to read it.
- **Keys go to the shell.** When you focus a terminal, NVDA and JAWS leave browse mode, so `Ctrl + C`, arrow keys and readline shortcuts reach the remote host. Use the usual key to return to browse mode (NVDA: `Insert + Space`; JAWS: `Insert + Z`).
- **Each terminal names what it's connected to**, so you can tell tabs apart. An SSH terminal announces `SSH terminal, deploy@web-1` (or `SSH terminal, web-1` when there's no username), a pod shell announces `Kubernetes exec terminal, pod api-7f9 in namespace prod, container api`, a k9s terminal announces `k9s terminal, namespace prod`, and a recording player announces `Session recording playback terminal`.
- **Connection changes are spoken**: `Connecting to deploy@web-1:22…`, `Connected`, `Connection closed`, `Connection error`, plus host key prompts.
- **Recordings stay browsable.** The [session recording](./session-recording.md) player is read-only and stays in browse mode, so you can arrow through the output as ordinary text.

## Forward your SSH agent

Agent forwarding lets the remote host use the key you logged in with. So `git clone git@github.com:...`, or `ssh user@another-host` from the remote, works with your local key, without copying private keys onto the server.

Before you connect, tick **Forward SSH agent** above the key picker. The checkbox disappears once a session is open, because the choice applies when you connect.

- Off by default, and remembered per resource.
- Takes effect on the next connection. Changing it doesn't end an active session.
- **No setup needed.** You don't need to run `ssh-agent`, set `SSH_AUTH_SOCK` or install Pageant.
- If you logged in with **Pageant** (Windows) or the **1Password** SSH agent, that agent is forwarded instead, so all the keys it holds are available on the remote. With 1Password, each remote use still asks you to unlock or confirm on your local machine.
- Works on **desktop local**, **desktop cloud** and **web**. In cloud and web mode, the forwarded key stays on the Infrawrench Cloud server and never reaches the remote host.
- **Cloud audit trail.** In cloud and web mode, each use of your forwarded key is recorded in the [audit log](../team-and-billing/audit-log.md). Look for `ssh.agent.session_opened` (one per session) and `ssh.agent.sign` / `ssh.agent.sign_failed` (one per remote SSH challenge). Each entry includes the SSH key id, the target host and the username.
- **Security:** a compromised remote host can use the forwarded key against any other host that accepts it, so only turn this on for hosts you trust. Only the key you logged in with is exposed, not your whole keyring.

![SSH view toolbar showing the "Forward SSH agent" checkbox above the key picker the terminal opens from](https://agent-assets.infrawrench.com/docs-screenshots/features/ssh-terminal/agent-forward-toolbar.png)

## Security

- In desktop mode, your keys never leave your machine.
- In web mode, the server connects to the host for you. Private keys are stored encrypted on the server and held in memory only while the session is open.
- Host key pinning is on by default. On your first connection to a host, and whenever its host key changes, you see a trust prompt with the fingerprint before anything continues. This applies everywhere a terminal opens: the desktop app, the web app, the [mobile app](./mobile-app.md) and desktop sessions through the cloud. On mobile it covers the file browser too, and accepting reconnects for you. Web and cloud pins are stored per organization, and you can review them under **Settings > SSH host keys**. Desktop local pins stay on your machine.

## Record sessions

You can record sessions opened through the cloud. Turn it on and each one becomes a replayable [asciinema cast](./session-recording.md) showing who connected, to what, and everything that appeared in the terminal. It's off by default, kept for as long as you choose, and has its own permissions.

## Share a session

You can share a live cloud session with a colleague. They watch the same terminal in real time, and you can hand them the keyboard. Observers can't type, and that's enforced on the server. Joining needs the same permission as opening the terminal, so the invite link alone doesn't grant access. See [shared consoles](./shared-consoles.md).

## Run one command on many hosts

A terminal is one shell on one machine. To ask the same question of a whole fleet (which machines are on the old kernel, which are low on disk), use [Fan-out SSH](./ssh-fanout.md). Pick the hosts, type one command, and identical output is grouped so you only read the odd one out.

## Not seeing the SSH button?

- The resource type may not support SSH (for example managed databases; use the [SQL editor](./sql-editor.md) instead).
- The instance may not have a public IP. Route it through a jump host instead; see [Jumpbox routing](./ssh-jumpbox.md).
