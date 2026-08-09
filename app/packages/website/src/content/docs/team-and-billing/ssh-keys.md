---
title: SSH keys
description: Save private keys once and reuse them across every SSH session.
sidebar_order: 6
---

You can store named SSH private keys in infrawrench so the [SSH terminal](../features/ssh-terminal.md), [file browser SFTP](../features/file-browsers.md), and [SSH tunnels](../features/ssh-tunnels.md) can use them without a key picker every time.

![SSH keys page with a list of named keys and an Add key button](https://agent-assets.infrawrench.com/docs/screenshots/settings/ssh-keys.png)

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

## Managing keys from MCP and chat

The [MCP server](../features/mcp.md) and the [AI chat](../features/ai-chat.md) can manage keys too, via `list_ssh_keys`, `create_ssh_key`, `import_ssh_key`, and `delete_ssh_key`. They enforce the same `ssh-keys:read` / `ssh-keys:write` [role permissions](./roles-and-permissions.md) as this page, and deleting another member's key requires `team:role:write`. Two safety properties to know:

- A key generated through a tool **never returns its private key** — it is stored encrypted and usable by id with `ssh_exec` and tunnels. If you need to download the private key for use outside Infrawrench, generate the key here in Settings instead.
- In chat, `delete_ssh_key` is a destructive action, so it always waits for your Approve click.

Stored keys also plug into resource creation: the VM create tools (`digitalocean_create_droplet`, `hetzner_create_server`, EC2/GCE/Scaleway instances, and the generic `create_resource`) accept an `sshKeyId`, and the key's **public** half is installed on the new machine — so "create a droplet I can SSH into with my deploy key" works end to end.

All tool-driven key changes appear in the [audit log](./audit-log.md) (`ssh-key.create` / `ssh-key.import` / `ssh-key.delete`).

## Don’t do this

- Do not paste keys you use to sign git commits — use a dedicated key for server access.
- Do not share a single key among many users; each human should have their own, so the [audit log](./audit-log.md) is meaningful.

## Finding keys nothing uses

The [credential hygiene report](./credential-hygiene.md) lists org SSH keys with no recorded use over a window you choose — terminal sessions, [fan-out](../features/ssh-fanout.md) runs, agent forwarding and the `ssh_exec` tool all count as use. Keys whose private half is stored server-side are ranked higher, because those are live credentials sitting in a database. Deleting one here removes Infrawrench's copy; the line in the host's `authorized_keys` is still yours to remove.
