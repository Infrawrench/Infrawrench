---
title: Enroll servers in Tailscale
description: Install Tailscale and join your tailnet on an existing SSH server, regardless of its cloud provider.
---

First [add your Tailscale account](../plugins/tailscale.md). Then open a server from any provider that offers an SSH endpoint, or a server added through the [SSH plugin](../plugins/ssh.md).

1. Choose **Install service…** on the server's resource page.
2. Select your Tailscale account from **Service account**.
3. For a cloud-provider server, select an SSH key and enter its username and port. An SSH account uses its saved connection, including its port and any configured jump hosts.
4. Click **Install and connect**. Keep the dialog open until setup finishes.
5. Refresh the Tailscale account to see the device.

If your tailnet requires [device approval](https://tailscale.com/kb/1099/device-approval), you don't need to approve the server yourself. Infrawrench is enrolling it with your account, so the enrollment key is pre-approved and the device joins already approved. Creating a pre-approved key, and approving a device, needs a token from an Owner, Admin, IT admin or Network admin. If your token can't approve devices, the dialog says so; open the device in the Tailscale account and choose **Approve device**. A server that joined earlier but is still waiting for approval is approved when you run **Install service…** on it again.

Automatic installation currently supports **Linux** with root or passwordless sudo, `curl` or `wget`, and outbound access to Tailscale and the distribution's package repositories. The server must already be reachable over SSH so Infrawrench can install the client. Unsupported operating systems produce an error before any package installation.

Infrawrench uses the [official Tailscale Linux installer](https://tailscale.com/docs/install/linux), then creates a short-lived, single-use, pre-approved enrollment key. Your API token stays with Infrawrench. The temporary key is removed from the host and revoked after setup; if revocation fails, the dialog reports it and the key expires after five minutes.

The flow does not enable Tailscale's separate SSH server, change your SSH daemon, advertise subnet routes, or make the server an exit node. A newly joined server keeps its existing DNS configuration. A server already running in the selected tailnet is left as it is; enrollment into another tailnet requires disconnecting it there first.

**Desktop local mode** runs the installation from your computer using saved keys, system keys, or an SSH agent. **Web, desktop cloud mode, and mobile** run it through Infrawrench Cloud with the target's saved credentials or an organization SSH key. Cloud installation requires both resource write and execute permissions, respects change freezes, and asks you to trust an unknown SSH host key.

After enrollment, use the device's Tailscale IP from a machine on the tailnet. Connecting the Tailscale API account alone does not give Infrawrench Cloud a route into your private network. Public SSH access remains available as before.

## Troubleshooting

- **"Check that the tailscaled service is running"**: the client is installed but its daemon is not running. This is common in containers and on hosts without systemd. Start `tailscaled` on the server, then try again.
- **"previously configured with custom settings"**: someone already ran `tailscale up` on this server with non-default flags, and Tailscale will not accept new settings without them. Infrawrench does not discard them for you. Run `tailscale up` on the server with its existing flags, or with `--reset` to drop them, then try again.
- **No Install service… button on a Tailscale device**: a plugin that installs itself is never offered as a target of its own installer. Open the server from the provider that hosts it instead.
