---
title: Nibblets servers
description: Set up a Nibblets server on an agent VM from Infrawrench, already linked to your organization.
sidebar_order: 26
---

[Nibblets](https://nibblets.dev) is a home for long-running AI agents ("nibblets") that run on Claude Code, Codex and other agent CLIs. From the **Agents** tab, Infrawrench can create a VM, install a Nibblets server on it and start it already linked to your organization, so its nibblets can use Infrawrench with the permissions you choose.

## Create a Nibblets server

1. Open **Agents**, open the configuration menu, and set **Interface** to **Nibblets**. There's no **Tool** choice: you sign in to agent CLIs from Nibblets' own menu.
2. Pick the account and VM shape as you would for any agent session. Use a Linux VM with a real kernel, since Nibblets runs its agents in containers.
3. Type a server name. **Link to this organization** is ticked by default. Below it, tick the most this server may ever give its nibblets. A read-only set (accounts, resources, costs, budgets, dashboards, alerts, incidents, deployments) is ticked to start, and you're only offered permissions you hold yourself.
4. Choose **Create**.

<insert The Agents create form with Interface set to Nibblets, a server name typed, Link to this organization ticked and the read-only permissions selected here>

Setup installs everything Nibblets needs on the VM without asking you anything (Docker or Podman, Node and Nibblets itself), and the server keeps running after you log out. It takes several minutes. The link credential is handed over in a private file that's deleted once the server has picked it up.

Linking needs permission to invite people to the organization, the same as approving a platform on the [Connect a platform](./agent-links.md) page. Without it the server starts unlinked, and you can link it later from Nibblets' **Settings > Linked apps**.

## Sign in and start using it

When setup finishes, choose **Authorize server** on the session. A terminal opens on the VM. Sign in to Claude Code, Codex or the other agents Nibblets supports, then link the server to Nibblets Connect if you want to reach it from anywhere.

After that, **Open Nibblets** on the session opens [Nibblets Connect](https://app.nibblets.dev), where your linked servers live. The server only listens on the VM, so without Connect you reach it by forwarding its port from your computer (`ssh -L 8420:127.0.0.1:8420 …`) and signing in with a link the terminal shows you how to print.

If the VM needs a restart before Nibblets can run, the session log says so and **Authorize server** offers to restart it. Nibblets starts again on its own afterwards.

## Give nibblets permissions

The link appears in **Settings > Agent Credentials** under **Connected platforms**. **Linked to this organization** on the session takes you there. In Nibblets, switch Infrawrench on for a nibblet and tick its permissions. Each nibblet becomes its own agent with its own credential and its own name in the audit log. See [agent links](./agent-links.md) for what an agent can and can't do.

<insert An agent session row for a Nibblets server showing "Linked to this organization", Open Nibblets and Authorize server here>

## Delete the server

**Delete** destroys the VM and revokes the server's link to your organization, which also revokes every agent its nibblets used.

## See also

- [Agents](./agents.md): agent sessions in general
- [Agent links](./agent-links.md): how linked platforms and their agents are scoped
- [T3 Code servers](./t3-code.md): the other server-style session
