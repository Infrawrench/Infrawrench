---
title: SSH keys
description: Save private keys once and reuse them across every SSH session.
sidebar_order: 6
---

You can store named SSH private keys in infrawrench so the [SSH terminal](../features/ssh-terminal.md), [file browser SFTP](../features/file-browsers.md), and [SSH tunnels](../features/ssh-tunnels.md) can use them without a key picker every time.

<insert [SSH keys page with a list of named keys and an Add key button] here>

## Add a key

1. **Settings → SSH keys → Add key**.
2. Give it a name.
3. Paste the **private key** (OpenSSH format). Optionally paste a **passphrase**.
4. Save.

## Storage

- **Web** — the key is encrypted server-side and decrypted in memory only for the session. Not visible in the UI after save.
- **Desktop** — the key is stored in the local encrypted database alongside your credentials.

## Using a key

Any time a host asks for a key, the picker lists saved keys first. In desktop mode, it also lists keys found on disk (`~/.ssh/`), keys exposed by the [1Password SSH agent](../features/ssh-terminal.md#picking-a-key) when it is running, and — on Windows — keys loaded in Pageant.

## Removing a key

**Settings → SSH keys → (key) → Delete**. Any hosts that were pinned to this key will prompt for a new key on next connection.

## Don’t do this

- Do not paste keys you use to sign git commits — use a dedicated key for server access.
- Do not share a single key among many users; each human should have their own, so the [audit log](./audit-log.md) is meaningful.
