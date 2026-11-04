---
title: Enroll servers in Tailscale
description: Install Tailscale and join your tailnet on an existing SSH server, regardless of its cloud provider.
---

Install Tailscale on any server you can SSH into and join it to your tailnet, whichever provider hosts it.

## Enroll a server

First [add your Tailscale account](../plugins/tailscale.md). Then open a server from any provider that offers an SSH endpoint, or one added through the [SSH plugin](../plugins/ssh.md).

1. Choose **Install service…** on the server's resource page.
2. Select your Tailscale account under **Service account**.
3. For a cloud-provider server, pick an SSH key and enter the username and port. An SSH account uses its saved connection, including its port and any jump hosts.
4. Click **Install and connect**. Keep the dialog open until setup finishes.
5. The device appears under your Tailscale account by itself, no refresh needed.

## Device approval

If your tailnet requires [device approval](https://tailscale.com/kb/1099/device-approval), you don't need to approve the server yourself. It joins already approved.

This needs a token from an Owner, Admin, IT admin or Network admin. If your token can't approve devices, the dialog tells you. Open the device in the Tailscale account and choose **Approve device**. If a server joined earlier and is still waiting for approval, run **Install service…** on it again to approve it.

## Requirements

Automatic installation currently supports **Linux** with:

- root or passwordless sudo
- `curl` or `wget`
- outbound access to Tailscale and the distribution's package repositories

The server must already be reachable over SSH. On an unsupported operating system you'll get an error before anything is installed.

## Security

Infrawrench uses the [official Tailscale Linux installer](https://tailscale.com/docs/install/linux) and a short-lived, single-use, pre-approved enrollment key. Your API token stays with Infrawrench. After setup, the temporary key is removed from the host and revoked. If revoking fails, the dialog tells you, and the key expires after five minutes anyway.

## What it doesn't change

Enrollment doesn't turn on Tailscale's own SSH server, change your SSH daemon, advertise subnet routes or make the server an exit node. The server keeps its existing DNS configuration.

A server already in the selected tailnet is left as it is. To move it to another tailnet, disconnect it from the current one first.

## Desktop, web and mobile

- **Desktop local mode** runs the install from your computer using saved keys, system keys or an SSH agent.
- **Web, desktop cloud mode and mobile** run it through Infrawrench Cloud with the server's saved credentials or an organization SSH key. You need both resource write and execute permissions, change freezes are respected, and you'll be asked to trust an unknown SSH host key.

## After enrollment

Use the device's Tailscale IP from any machine on the tailnet. Connecting your Tailscale API account doesn't by itself give Infrawrench Cloud a route into your private network. Public SSH access keeps working as before.

## Agent VMs

[Agents](./agents.md) can enroll every VM they create. Select your Tailscale account under **Services** in the Agents configuration menu. Tailscale is installed once the VM is ready, and deleting the session removes the device from the tailnet. You can then reach a [T3 Code](./t3-code.md#reaching-the-server-over-tailscale-instead) server over the tailnet with Tailscale Serve instead of T3 Connect.

## Troubleshooting

- **"Check that the tailscaled service is running":** the client is installed but its daemon isn't running. This is common in containers and on hosts without systemd. Start `tailscaled` on the server and try again.
- **"previously configured with custom settings":** someone already ran `tailscale up` on this server with non-default flags, and Tailscale won't take new settings without them. Infrawrench won't discard them for you. Run `tailscale up` with the existing flags, or with `--reset` to drop them, then try again.
- **No Install service… button on a Tailscale device:** you can't install Tailscale onto a Tailscale device entry. Open the server from the provider that hosts it instead.
