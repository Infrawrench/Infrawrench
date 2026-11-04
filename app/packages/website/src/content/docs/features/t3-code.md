---
title: Run T3 Code on a remote server
description: Run T3 Code on a remote VM that Infrawrench sets up with Node, the t3 CLI, Claude Code and Codex, linked to T3 Connect and started on boot.
sidebar_order: 25
---

[T3 Code](https://github.com/pingdotgg/t3code) is an app for running coding agents on a machine you control. Infrawrench can set that machine up for you. Pick **T3 Code** as the **Interface** on an [agent](./agents.md) session and the VM comes up running the T3 Code server, linked to your T3 Connect account and ready to use from T3 Code's own app.

Infrawrench's part ends once the server is working and linked. It doesn't embed T3 Code. You use the server from T3 Code's desktop, web or mobile app, like any other machine you've linked.

![Agents configuration menu with Tool set to Claude Code and Interface set to T3 Code, showing the explanatory note underneath](https://agent-assets.infrawrench.com/docs-screenshots/features/t3-code/config-menu-t3-code.png)

## Pick a tool as well as T3 Code

T3 Code is not an agent. It has no model access of its own and drives the agent CLIs installed next to it. So a T3 Code session still has a **Tool**, and it matters:

| You pick    | The VM gets     | You sign in with            |
| ----------- | --------------- | --------------------------- |
| Claude Code | `claude` + `t3` | `claude auth login`         |
| Codex       | `codex` + `t3`  | `codex login --device-auth` |

A server with only `t3` on it can add projects and browse files, but it can never start a session.

## Create a server

1. Choose a VM-capable account and VM shape, the same as for a terminal agent.
2. Set **Interface** to **T3 Code**.
3. Name the server and select **Create**.

There's no repository field. T3 Code manages its own projects, so you add them from inside T3 Code with the Command Palette (`Cmd/Ctrl + K`) > **Add Project**. Infrawrench creates an empty `~/projects` folder as a handy place to clone into. These sessions have no **Reconcile** action.

Setup installs:

- Node 24 (T3 Code needs `^22.16 || ^23.11 || >=24.10`).
- The `t3` CLI and **both** agent CLIs, Codex and Claude Code. T3 Code sometimes uses the other provider for its own work (for example, generating a thread title runs `codex` even in a Claude thread). Setup signs in only your session's tool. Sign the other in with `codex login --device-auth` or `claude auth login` if you want those extras. A T3 Code VM takes a little longer to come up than a terminal one because part of this is compiled on the VM.
- `git` and the [GitHub CLI](https://cli.github.com/), for T3 Code's clone, publish and pull request features.
- T3 Code's background service, so the server starts on boot and keeps running after setup ends. This needs systemd. On a VM without it, setup warns you and you start the server yourself with `t3 serve`.

Setup also makes sure the T3 Code service can find the CLIs it installed, gives the server process top CPU priority so your session stays responsive while a busy agent runs, and stops T3 Code's **open in browser** from erroring on a headless VM (open links on your own machine instead). If an older server shows "The source control operation could not be completed", re-run **Authorize server** to repair it in place.

## Authorize the server

A few sign-ins happen in a browser, so you do them once, by hand. Select **Authorize server** on the session row (where a terminal agent has **Open**). It opens an SSH terminal on the VM that walks you through:

1. **`t3 connect link`** links the server to T3 Connect. It prints an authorization URL and waits for you to paste a code back, so no port forwarding is needed.
2. **The agent sign-in**: `claude auth login`, or `codex login --device-auth` for Codex. It's skipped if the CLI is already signed in, which is common on desktop because desktop sessions sync your local tool config to the VM.
3. **`gh auth login`** (optional). Without it T3 Code works but can't open pull requests.

   This step also lines git up with the protocol `gh` uses. A fresh VM has no SSH key registered with GitHub, so SSH clones would fail. When `gh` is on HTTPS, setup makes GitHub clones use HTTPS. When `gh` is on SSH, it tells you and leaves your choice alone, showing both fixes: `gh config set git_protocol https`, or register a key for the machine with `gh ssh-key add`.

4. **Restart the server**, which is what actually brings the T3 Connect link up. It runs `systemctl --user restart t3code.service`.

The terminal then waits until the link reports `provisioned`, so it tells you when the server is reachable. If it stays pending, check the server log (`journalctl` won't show the server's own errors):

```bash
t3 service status                                 # shows the log path
tail -n 200 ~/.t3/userdata/logs/boot-service.log
```

You can skip any step with `Ctrl-C` and run it later. When it finishes, the terminal leaves you at a shell.

<insert [Authorization terminal on the T3 Code tab showing the numbered steps with the t3 connect out-of-band URL prompt] here>

## Reach the server over Tailscale instead

T3 Connect needs a T3 account and routes traffic through T3's relay. If your team already runs a [Tailscale](./tailscale.md) tailnet, you can skip both:

1. In the Agents configuration menu, select your Tailscale account under **Services**.
2. Set **T3 Code access** to **Tailscale**. This option only appears while a Tailscale account is attached.

With Tailscale access:

- Setup adds the VM to your tailnet after it's created, using the same pre-approved, single-use key as [Install service…](./tailscale.md).
- **Authorize server** skips the T3 Connect step. After the sign-ins and restart it runs [`t3 pair --tailscale`](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md), which publishes the server at `https://<machine>.<tailnet>.ts.net/` and prints a one-time pairing link. In T3 Code, open **Settings > Connections > Add environment** and paste the link or scan its QR code. The link expires after five minutes. For another device, run `t3 pair --tailscale` again in the same terminal.
- The server stays at that address across restarts, and only devices on your tailnet can reach it.
- Your tailnet needs [MagicDNS and HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) turned on. If the VM's agent user isn't root, setup makes that user the Tailscale operator so it can publish the server.
- **Delete** removes the device from your tailnet after destroying the VM. There's no T3 Connect environment to revoke.

![Agents configuration menu with the Tailscale account selected under Services and T3 Code access set to Tailscale, showing the explanatory note](https://agent-assets.infrawrench.com/docs-screenshots/features/t3-code/config-menu-tailscale-v2.png)

## Control T3 Code with a policy

T3 Code supports a [managed policy](https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md): a machine-wide file that sets defaults and locks for T3 Code's settings and limits what it may do. The server enforces it for every app that connects (desktop, browser, mobile, MCP agents and scheduled tasks). Infrawrench keeps one policy for your organization and installs it on every T3 Code server it sets up, so nobody deploys the file by hand.

To set it up, open the Agents configuration menu with **Interface** set to **T3 Code** and select **Add policy** under **T3 Code policy**. The editor saves to your organization's agent defaults, so it needs the same permission as saving those. It covers everything T3 Code's policy can do:

- **Organization**: the name T3 Code shows as "Managed by" next to every locked control, plus an optional support link.
- **Permissions**: the broadest permission mode any thread may use, from Supervised to Full access. With a limit set, T3 Code takes each provider's launch settings and environment variables only from the policy.
- **Access**: which kinds of clients the server accepts, and whether T3 Connect is allowed. Remote clients are always allowed, since an agent VM can only be reached remotely. T3 Connect stays on while **T3 Code access** is T3 Connect.
- **Capabilities**: webhook triggers for scheduled tasks, importing browser cookies, and product usage data.
- **Providers**: which providers may run, and **Provider settings** to pin environment variables (such as a company gateway URL), a binary path or launch arguments on every instance of a provider, either locked or as defaults.
- **Updates**: whether T3 Code checks for updates, and whether the nightly channel is available.
- **Settings**: a default or a lock for any T3 Code setting. Common ones have a picker. **Other setting (by path)** takes any path from T3 Code's `settings.json` with a JSON value.

The **JSON** view shows the exact document sent to the server and accepts anything T3 Code's format does, including keys the form doesn't cover.

<insert [T3 Code policy editor open over the Agents page, with an organization name, a permission mode limit, and two locked settings] here>

The editor checks your policy as you type, using T3 Code's own rules. T3 Code won't start with a policy it can't fully enforce, so an unknown key, a value of the wrong type, or a default permission mode broader than the limit blocks saving. It's also checked against your defaults: if the policy forbids the provider your **Tool** runs, or turns off the T3 Connect your servers use, the menu tells you and won't create a server.

Every user on the server can read the policy, so keep credentials out of it. The editor warns you when a pinned environment variable looks like one.

### How the policy reaches your servers

- **New servers** get the policy during setup, before T3 Code first starts. Setup runs `t3 policy check` first and fails rather than install a policy T3 Code would refuse.
- **Existing servers** get a changed policy when you save it. T3 Code only reads its policy when it starts, and restarting interrupts running agent turns, terminals and connected apps. So the editor asks when to apply the change:
  - **Now, restarting T3 Code** installs the policy on every server and restarts T3 Code on each, so it takes effect at once.
  - **At their next restart** installs the policy now and leaves each server on its current policy until T3 Code next restarts. Those servers show **Policy installed. T3 Code applies it when it next restarts.** with a **Restart T3 Code** button for when it suits you.

  A message under the page header then lists what happened on each server. A server that already has the policy is left alone. One still being set up starts on the new policy when setup finishes. A server whose provider or access doesn't fit the policy keeps the one it has. A server that can't be reached (for example, its VM is powered off) isn't retried. It shows that it doesn't have the current policy, with an **Apply and restart** button. **Authorize server** also installs your current policy, restarts T3 Code and ends with `t3 policy show`, so you can see what the running server loaded.

- **Removing the policy** asks the same question and takes the policy off each server. Only a policy Infrawrench installed is removed. One an administrator placed some other way is left alone.

Rolling out a policy runs commands on your servers and may restart them, so it needs permission to run commands on resources, the same as **Authorize server**.

<insert [T3 Code policy editor footer with two existing servers, showing the "Now, restarting T3 Code" and "At their next restart" choices, and the Agents list below with one server showing "Policy installed. T3 Code applies it when it next restarts." and its Restart T3 Code button] here>

Each T3 Code server in the list shows **Managed by** with the organization of the policy it last received. The policy controls T3 Code only. The agent CLIs it drives read their own configuration, so restrict those with their own managed settings if you need to.

## Use the server

Once the link reports `provisioned` (or, with Tailscale, once you've added the pairing link), the machine shows up in T3 Code. Open it from [T3 Code's own app](https://app.t3.codes) or its desktop build, and add projects with the Command Palette (`Cmd/Ctrl + K`) > **Add Project**.

**Authorize server** stays available and is safe to re-run. Each step skips work that's already done, so use it to re-link a server, sign a provider back in, or just get a shell on the box.

## Delete a server

**Delete** runs `t3 connect logout` on the VM, then destroys the VM at the provider, removes the session and closes any SSH tabs for it. The logout matters because only the machine itself can remove its environment from your T3 account. If the VM is already unreachable, the delete still goes ahead but the environment stays in your T3 account.

T3 Code keeps its state on the VM, so anything unpushed in its projects is lost. Push from inside T3 Code first.

If you tear the VM down by hand, run `t3 connect logout` on it first. Signing out of T3 Connect leaves the background service running. `t3 service uninstall` stops T3 Code starting on boot without touching the VM.
