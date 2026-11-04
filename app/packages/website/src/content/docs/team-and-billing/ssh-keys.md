---
title: SSH keys
description: Save SSH keys once in Infrawrench and reuse them across terminals, SFTP, tunnels and new VMs.
sidebar_order: 6
---

**Settings > SSH Keys** holds named SSH keys shared across your organization. The [SSH terminal](../features/ssh-terminal.md), [file browser SFTP](../features/file-browsers.md) and [SSH tunnels](../features/ssh-tunnels.md) can then use them without you picking a key every time.

![SSH keys page with a list of named keys and the Import Key and Generate Key buttons](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/ssh-keys/ssh-keys-list.png)

The page has two buttons, **Generate Key** and **Import Key**. Which one you want depends on who should hold the private key. The table shows each key's name, type, fingerprint, source (**Generated** or **Imported**), owner and date added, with **Copy public key** and **Delete** on each row.

## Generate a key

1. Go to **Settings > SSH Keys > Generate Key**.
2. Give it a name, for example `production-bastion`.
3. Click **Generate key**.

Infrawrench creates an Ed25519 key pair and shows both halves once, under **Public Key** and **Private Key**, with a **Copy private key to clipboard** button. You can't reopen that dialog. Copy the private key now if you want it outside Infrawrench, or just close the dialog and let Infrawrench keep it for you.

## Import a key

1. Go to **Settings > SSH Keys > Import Key**.
2. Give it a name.
3. Paste the **public** key, for example the contents of `~/.ssh/id_ed25519.pub`. Not the private key.
4. Click **Import key**.

There's no field for a private key or a passphrase. Infrawrench saves the public key so it can install it on new machines and show it in pickers. Your private key stays wherever you already keep it.

## What each kind of key can do

- A **generated** key is stored encrypted in Infrawrench's cloud, so the cloud can connect for you. Web terminals, SFTP, tunnels and agent-driven SSH all work. The desktop app can also use it for [Linux applications](../features/linux-apps.md) without the private key ever reaching your machine: the cloud signs the login for you while the connection runs directly from your machine to the host. Each signature is recorded in the [audit log](./audit-log.md) as `ssh.agent.sign`.
- An **imported** key has no private key in the cloud, so the cloud can't log in with it. Choosing one for a web SSH session or tunnel fails with _"SSH key has no private key data"_. Import is still the right choice when you connect from the desktop app (where the private key is on your own disk), or when you only need the public key installed on a new VM.

Either way, the public key is visible to everyone in the organization.

## Use a key

Whenever a host asks for a key, the picker lists your saved keys first. In the desktop app it also lists keys on disk (`~/.ssh/`), keys from the [1Password SSH agent](../features/ssh-terminal.md#picking-a-key) when it's running, and on Windows, keys loaded in Pageant.

## Delete a key

Go to **Settings > SSH Keys**, pick the key and click **Delete**. Hosts that used this key will ask for a new one on the next connection. You can delete your own keys. Deleting someone else's needs the same permission as managing roles.

## Manage keys from MCP and AI chat

The [MCP server](../features/mcp.md) and [AI chat](../features/ai-chat.md) can manage keys with `list_ssh_keys`, `create_ssh_key`, `import_ssh_key` and `delete_ssh_key`. They follow the same `ssh-keys:read` and `ssh-keys:write` [role permissions](./roles-and-permissions.md) as this page, and deleting another member's key needs `team:role:write`.

- A key generated through a tool **never shows you its private key**. It's stored encrypted and you use it by id with `ssh_exec` and tunnels. If you need the private key outside Infrawrench, generate the key in Settings instead.
- In chat, `delete_ssh_key` always waits for you to click Approve.

You can also use saved keys when creating VMs. The create tools (`digitalocean_create_droplet`, `hetzner_create_server`, EC2, GCE and Scaleway instances, and the general `create_resource`) accept an `sshKeyId` and install the key's **public** half on the new machine. So "create a droplet I can SSH into with my deploy key" works in one go.

Key changes made through tools appear in the [audit log](./audit-log.md) as `ssh-key.create`, `ssh-key.import` and `ssh-key.delete`.

## Avoid these

- Don't add keys you use to sign git commits. Use a separate key for server access.
- Don't share one key between several people. Give each person their own, so the [audit log](./audit-log.md) shows who did what.

## Find unused keys

The [credential hygiene report](./credential-hygiene.md) lists organization SSH keys with no use over a period you choose. Terminal sessions, [fan-out](../features/ssh-fanout.md) runs, agent forwarding and the `ssh_exec` tool all count as use. Keys whose private half is stored in Infrawrench are ranked higher, since those are live credentials. Deleting a key there removes Infrawrench's copy, but you still need to remove it from the host's `authorized_keys` yourself.
