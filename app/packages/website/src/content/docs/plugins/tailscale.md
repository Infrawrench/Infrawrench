---
title: Tailscale
description: Connect your tailnet, manage its devices, users, keys, Services, webhooks and settings, and enroll Linux servers from any SSH-capable provider.
---

Add a **Tailscale** account using an **API access token** from [Tailscale's Keys settings](https://login.tailscale.com/admin/settings/keys). Use an API token, not a device auth key. Leave **Tailnet** at `-` to use the token's own tailnet. You can update an expired API token in the account settings.

What the account can see and change follows the token's owner: an Owner or Admin token reaches everything below, while a narrower role only sees the parts it is allowed to.

## What you can manage

- **Tailnet**: one record per account holding the tailnet-wide settings. Edit device approval, client auto-updates, the node key expiry period (1 to 180 days), user approval, who may join other tailnets, network flow logging, regional routing, device identifier collection, HTTPS certificates and whether the policy file is managed externally. The same edit form covers DNS: MagicDNS, overriding local DNS, the global nameservers and the search domains. Split DNS routes and per-resolver exit-node flags are kept as they are when you edit DNS here. The page also shows the account, security and support contacts and the status of any log streams (destination, last upload, entries sent and the last error), and its **Logs** tab shows the last 30 days of the configuration audit log (who changed what, with the old and new values) and, in a second **network** stream, the last 15 minutes of network flow logs with device names in place of Tailscale IPs. Its **Metrics** tab charts tailnet-wide traffic from the flow logs: bytes per second sent and received over the tailnet, through subnet routers and exit nodes (when there is any) and on the physical network underneath, tailnet packets per second, and how many devices reported traffic.
- **Devices**: Tailscale IP, DNS name, operating system and distribution, owner, tags, approval status, client version (with a flag when an update is available), last-seen time, key expiry, advertised and approved subnet routes, ephemeral, Tailscale SSH and shields-up state, duplicate node keys and Tailnet Lock errors. Open a device to rename it, change its tags, turn key expiry off or on, approve subnet routes or an exit node (`0.0.0.0/0` and `::/0`), or assign a different `100.x.y.z` address. The device page also lists its DERP latency per region, its endpoints and any device posture attributes. Actions: approve, revoke approval, expire the device key, or remove the device. Node keys that expire feed the Expiry radar; devices with key expiry disabled are left off it. With network flow logs on, a device's **Metrics** tab charts its own traffic (the same series as the tailnet, from that device's side) and its **Logs** tab lists its connections from the last 15 minutes.
- **Users**: login name, role, status, device count, connection state and last seen. Change a user's role in the edit form; approve, suspend or restore them; or delete them, which also removes their devices. Users appear in access reviews with their role as the admin signal, and the review's Revoke button suspends the user.
- **User invites**: invite someone with a role, either by email or as a shareable link (leave the email blank). The link is the sensitive `inviteUrl` output. Resend the email or delete the invite. Tailscale only lets user-owned API tokens create invites.
- **Keys**: auth keys, API access tokens, OAuth clients and federated identities, with their type, flags, tags, scopes, creator and expiry. Create an **auth key** (one-off or reusable, ephemeral, pre-approved, tags picked from your policy file's `tagOwners` and tags already in use, 1 to 90 days) or an **OAuth client** (scopes and tags from pickers). The secret appears once, as the sensitive `key` output, right after creation. Deleting a key revokes it. Expiring keys feed the Expiry radar and keys appear in access reviews.
- **Services**: Tailscale Services with their virtual IPs, ports, tags and comment. Create one by name (the `svc:` prefix is added for you) with its TCP ports and tags, edit it, or delete it. The Service page lists the devices hosting it with their approval state, and lets you approve a waiting host or withdraw an approved one.
- **Webhooks**: endpoint URL, payload format (generic, Slack, Mattermost, Google Chat or Discord) and subscribed events. Create one with an event picker, edit its events, send a test event, or delete it. The signing secret is the sensitive `secret` output after creation; **Get credentials → Rotate signing secret** issues a new one and shows it once.
- **Posture integrations**: CrowdStrike Falcon, Microsoft Intune, Jamf Pro, Kandji, Kolide and SentinelOne. The create form asks only for what the chosen provider needs (cloud, tenant domain, client ID, tenant ID, secret). Each integration shows its last sync, sync error, and how many provider devices matched tailnet devices; edit the identifiers or replace the secret, or delete it.

## Enroll servers

To add an existing server, open its resource page and choose **Install service…**, then select your Tailscale account and click **Install and connect**. This works with SSH targets from cloud providers and accounts added through the [SSH plugin](./ssh.md). See [Enroll servers in Tailscale](../features/tailscale.md) for requirements and connection behavior.

## Network access

The integration uses the [Tailscale API](https://tailscale.com/api). API access does not connect the Infrawrench machine to the tailnet. To use a device's Tailscale IP for SSH, the machine making the SSH connection must already have a network path into your tailnet.

## Limits

- Tailscale has no billing or usage API, so the plugin reports no costs.
- The policy file itself is not edited here; it is read only to offer your defined tags in pickers.
- Traffic metrics and flow logs come from network flow logs, which need a Premium or Enterprise plan, **Network flow logs** turned on in the tailnet settings and a token that can read them (`logs:network:read`). Tailscale keeps them for 30 days and returns a whole window in one response, so the Metrics tab defaults to the last hour and reads at most 24 hours at a time. Sent and received are counted from each device's side, so tailnet totals count traffic between two of your devices once on each end.
