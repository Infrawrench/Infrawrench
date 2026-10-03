---
title: Tailscale
description: Connect your tailnet, manage its devices, and enroll Linux servers from any SSH-capable provider.
---

Add a **Tailscale** account using an **API access token** from [Tailscale's Keys settings](https://login.tailscale.com/admin/settings/keys). Use an API token, not a device auth key. Leave **Tailnet** at `-` to use the token's own tailnet. You can update an expired API token in the account settings.

The account lists your devices with their Tailscale IP, DNS name, operating system, owner, tags, approval status, client version, last-seen time, and key expiry. Open a device to rename its DNS name, approve it, expire its device key, or remove it. Expiring a device key requires that device to authenticate again; removing a device disconnects it from the tailnet.

To add an existing server, open its resource page and choose **Install service…**, then select your Tailscale account and click **Install and connect**. This works with SSH targets from cloud providers and accounts added through the [SSH plugin](./ssh.md). See [Enroll servers in Tailscale](../features/tailscale.md) for requirements and connection behavior.

The integration uses the [Tailscale API](https://tailscale.com/api). API access does not connect the Infrawrench machine to the tailnet. To use a device's Tailscale IP for SSH, the machine making the SSH connection must already have a network path into your tailnet.
