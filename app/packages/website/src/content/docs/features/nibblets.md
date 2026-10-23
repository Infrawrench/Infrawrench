---
title: Nibblets servers
description: Set up a Nibblets server on an agent VM from Infrawrench, already linked to your organization.
sidebar_order: 26
---

[Nibblets](https://nibblets.dev) is a home for long-running AI agents ("nibblets") that run on Claude Code, Codex and other agent CLIs. From the **Agents** tab, Infrawrench can provision a VM, install a Nibblets server on it, and start it already linked to your organization, so its nibblets can use Infrawrench with permissions you choose.

## Creating a Nibblets server

1. Open **Agents**, open the configuration menu, and set **Interface** to **Nibblets**. There is no **Tool** choice: Nibblets signs in whichever agent CLIs you want from its own menu.
2. Pick the account and VM shape as for any agent session. Use a Linux VM with a real kernel; Nibblets runs its agents in containers.
3. Type a server name. **Link to this organization** is ticked by default; underneath it, tick the most this server may ever give its nibblets. A read-only set (accounts, resources, costs, budgets, dashboards, alerts, incidents, deployments) is ticked to start with, and only permissions you hold yourself are offered.
4. Choose **Create**.

<insert The Agents create form with Interface set to Nibblets, a server name typed, Link to this organization ticked and the read-only permissions selected here>

Setup runs the Nibblets installer on the VM without asking anything: Docker or Podman, Node, the Nibblets repository and its stack, which keeps running after you log out. It takes several minutes. When the server is linked, Infrawrench hands it its link credential in a private file during setup, and the installer deletes the file once the server has picked it up.

Linking needs permission to invite people in the organization, exactly like approving a platform on the [Connect a platform](./agent-links.md) page. Without it the server starts unlinked, and you can link it later from Nibblets' **Settings → Linked apps**.

## Signing in and using it

When setup finishes, choose **Authorize server** on the session. It opens a terminal on the VM running the installer's sign-in step: sign in to Claude Code, Codex or the other agents Nibblets supports, then link the server to Nibblets Connect if you want to reach it from anywhere.

After that, **Open Nibblets** on the session opens [Nibblets Connect](https://app.nibblets.dev), where your linked servers live. The server itself only listens on the VM, so without Connect you reach it by forwarding its port from your computer (`ssh -L 8420:127.0.0.1:8420 …`) and signing in with a link the terminal shows you how to print.

If the VM needs one restart to turn on the memory controller Nibblets relies on, the session log says so and **Authorize server** offers to restart it. Nibblets starts again by itself afterwards.

## Giving nibblets permissions

The link appears in **Settings → Agent Credentials** under **Connected platforms**, and **Linked to this organization** on the session takes you there. In Nibblets, switch Infrawrench on for a nibblet and tick its permissions; each nibblet becomes its own agent with its own credential and its own name in the audit log. See [agent links](./agent-links.md) for what an agent can and cannot do.

<insert An agent session row for a Nibblets server showing "Linked to this organization", Open Nibblets and Authorize server here>

## Deleting the server

**Delete** destroys the VM and revokes the server's link to the organization, which revokes every agent its nibblets used.

## See also

- [Agents](./agents.md): agent sessions in general
- [Agent links](./agent-links.md): how linked platforms and their agents are scoped
- [T3 Code servers](./t3-code.md): the other server-style session
