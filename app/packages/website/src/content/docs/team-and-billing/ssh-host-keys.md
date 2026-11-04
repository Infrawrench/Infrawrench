---
title: Trusted SSH hosts
description: Check, trust and revoke SSH host-key fingerprints for your Infrawrench organization.
sidebar_order: 7
---

The first time you connect to an SSH server, Infrawrench shows its host-key fingerprint and asks you to check it. When you confirm, the fingerprint is saved for your organization. Future connections to the same `host:port` go straight through as long as the key still matches. If the key changes, you get a second prompt warning that someone may be intercepting the connection.

![Trusted SSH Hosts settings page with the table of pinned hosts, fingerprints, and Revoke buttons](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/ssh-host-keys/trusted-hosts.png)

Trusted hosts are shared across your organization. Once anyone trusts a host, it's trusted for every member.

## Check a fingerprint before you trust it

The prompt shows the **SHA-256 fingerprint** of the server's host key. Compare it with the fingerprint from whoever runs the server (they can get it with `ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub` on the server). If they don't match, don't trust it: the connection is being intercepted.

## When a host key changes

If a server's fingerprint no longer matches the saved one, you see a red **Host key has changed** prompt showing the old and new fingerprints. That's expected when:

- The server was rebuilt or its OS was reinstalled.
- An administrator rotated the host keys.

It's not expected otherwise. If nobody told you to expect a change, treat it as suspicious and don't accept it.

## Revoke a trusted host

Go to **Settings > Trusted SSH Hosts** and click **Revoke**. The next connection to that host asks you to verify it again.

Revoke when:

- A server has been decommissioned.
- You accepted a key by mistake and want to start over.
- A host's fingerprint changed for a good reason and you want people to verify it again.

## From MCP and AI chat

The [MCP server](../features/mcp.md) and [AI chat](../features/ai-chat.md) can manage trusted hosts with `list_trusted_ssh_hosts`, `trust_ssh_host` and `remove_ssh_host_trust`. If the agent's `ssh_exec` hits a host that isn't trusted yet, it gets the fingerprint and asks you to verify it before calling `trust_ssh_host`.

In chat, trusting and revoking always stop at an Approve/Reject card. Check the fingerprint yourself (in your provider's console or with `ssh-keygen -lf`) before approving, just as you would with the prompt in the app.

## API and audit

- `GET /api/org/{orgId}/ssh-host-keys`: list trusted hosts.
- `POST /api/org/{orgId}/ssh-host-keys/trust`: trust a fingerprint after the user has confirmed it.
- `DELETE /api/org/{orgId}/ssh-host-keys/{id}`: revoke a trusted host.

Every trust and revoke is recorded in the [audit log](./audit-log.md) as `ssh_host_key.trusted`, `ssh_host_key.replaced` or `ssh_host_key.removed`, including changes made by tools.
