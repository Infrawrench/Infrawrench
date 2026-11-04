---
title: Tailscale
description: Connect your tailnet, manage its devices, users, keys, Services, webhooks and settings, and enroll Linux servers from any SSH-capable provider.
---

## Connect your tailnet

Add a **Tailscale** account with an **API access token** from [Tailscale's Keys settings](https://login.tailscale.com/admin/settings/keys). Use an API token, not a device auth key. Leave **Tailnet** at `-` to use the token's own tailnet. If the token expires, update it in the account settings.

What you can see and change depends on the token's owner. An Owner or Admin token reaches everything below. A narrower role only sees the parts it's allowed to.

## What you can manage

- **Tailnet**: one record per account with your tailnet-wide settings.
  - Edit device approval, client auto-updates, the node key expiry period (1 to 180 days), user approval, who may join other tailnets, network flow logging, regional routing, device identifier collection, HTTPS certificates and whether the policy file is managed externally.
  - The same form covers DNS: MagicDNS, overriding local DNS, the global nameservers and the search domains. Split DNS routes and per-resolver exit-node flags stay as they are when you edit DNS here.
  - The page also shows the account, security and support contacts and the status of any log streams (destination, last upload, entries sent and the last error).
  - The **Logs** tab shows the last 30 days of the configuration audit log (who changed what, with old and new values) and, in a second **network** stream, the last 15 minutes of network flow logs with device names instead of Tailscale IPs.
  - The **Metrics** tab charts tailnet-wide traffic: bytes per second sent and received over the tailnet, through subnet routers and exit nodes (if any) and on the physical network underneath, tailnet packets per second, and how many devices reported traffic.
- **Devices**: Tailscale IP, DNS name, operating system and distribution, owner, tags, approval status, client version (flagged when an update is available), last-seen time, key expiry, advertised and approved subnet routes, ephemeral, Tailscale SSH and shields-up state, duplicate node keys and Tailnet Lock errors.
  - Open a device to rename it, change its tags, turn key expiry off or on, approve subnet routes or an exit node (`0.0.0.0/0` and `::/0`), or assign a different `100.x.y.z` address.
  - The device page also lists its DERP latency per region, its endpoints and any device posture attributes.
  - Actions: approve, revoke approval, expire the device key, or remove the device.
  - Expiring node keys show on the Expiry radar. Devices with key expiry turned off are left off it.
  - With network flow logs on, a device's **Metrics** tab charts its own traffic and its **Logs** tab lists its connections from the last 15 minutes.
- **Users**: login name, role, status, device count, connection state and last seen. Change a user's role, approve, suspend or restore them, or delete them (which also removes their devices). Users appear in access reviews with their role as the admin signal, and the review's Revoke button suspends the user.
- **User invites**: invite someone with a role, by email or as a shareable link (leave the email blank). The link is the sensitive `inviteUrl` output. Resend the email or delete the invite. Only tokens owned by a user can create invites.
- **Keys**: auth keys, API access tokens, OAuth clients and federated identities, with their type, flags, tags, scopes, creator and expiry.
  - Create an **auth key** (one-off or reusable, ephemeral, pre-approved, tags picked from your policy file's `tagOwners` and tags already in use, 1 to 90 days) or an **OAuth client** (scopes and tags from pickers).
  - The secret appears once, as the sensitive `key` output, right after you create it.
  - Deleting a key revokes it. Expiring keys show on the Expiry radar, and keys appear in access reviews.
- **Services**: Tailscale Services with their virtual IPs, ports, tags and comment. Create one by name (the `svc:` prefix is added for you) with its TCP ports and tags, edit it, or delete it. The Service page lists the devices hosting it with their approval state, and lets you approve a waiting host or withdraw an approved one.
- **Webhooks**: endpoint URL, payload format (generic, Slack, Mattermost, Google Chat or Discord) and subscribed events. Create one with an event picker, edit its events, send a test event, or delete it. The signing secret is the sensitive `secret` output after creation. **Get credentials > Rotate signing secret** issues a new one and shows it once.
- **Posture integrations**: CrowdStrike Falcon, Microsoft Intune, Jamf Pro, Kandji, Kolide and SentinelOne. The create form only asks for what the chosen provider needs (cloud, tenant domain, client ID, tenant ID, secret). Each integration shows its last sync, sync error, and how many provider devices matched tailnet devices. Edit the identifiers, replace the secret, or delete it.

## Enroll servers

To add an existing server to your tailnet:

1. Open the server's page and choose **Install service…**.
2. Select your Tailscale account.
3. Click **Install and connect**.

This works with SSH targets from cloud providers and accounts added through the [SSH plugin](./ssh.md). See [Enroll servers in Tailscale](../features/tailscale.md) for requirements and how the connection works.

## Network access

Connecting your account doesn't put the Infrawrench machine on your tailnet. To SSH to a device's Tailscale IP, the machine making the SSH connection must already be able to reach your tailnet.

## Seats

Tailscale accounts report your tailnet's users to the **Seats** page. It flags users not seen on the tailnet within your inactivity threshold and adds up what removing them would save.

- **Who counts**: a user takes a seat once they first log in or connect a device, so active and idle users with a last-seen time count. Suspended users, users waiting for approval or held back by the billing limit, invited users, and users shared in from another tailnet don't hold a seat here and are left out.
- **Activity**: the user's **last seen on the tailnet**, meaning the later of the last time any of their devices was connected and the last time they signed in to Tailscale, including the admin console. A user connected right now counts as active today.
- **Price**: the **Seat price** you set under **Advanced options** on the account (enter 0 on the free Personal plan). Tailscale doesn't report your plan, so without it each seat is estimated at the Standard plan's list price, $8 per user per month (Premium is $18; tailscale.com/pricing, October 2026), and marked as an estimate.
- **Remove** suspends the user. Their devices stay in the tailnet but can't exchange traffic, their API and auth keys stop working, and the seat is freed. **Restore** on the user undoes it. Tailscale charges for every seat, including empty ones, based on the seat count at the start of each month, so also lower the seat count in your billing settings to stop paying for it. You can't remove the tailnet owner until ownership moves to someone else.
- **Cheaper tier**: never suggested, since Tailscale doesn't report your plan.
- **Scopes**: `users:read` to read seats, `users` to remove them. A user-owned API access token can't suspend its own user.
- [Remediation commands](../features/remediation-commands.md) for a flagged user are `curl` calls with an API token (`$TAILSCALE_API_KEY`): show the user, then suspend them.

## Limits

- Tailscale has no billing or usage API, so there's no cost data. Seat prices come from the price you set or the published list price.
- You can't edit the policy file here. It's only read so your defined tags show up in pickers.
- Traffic metrics and flow logs need a Premium or Enterprise plan, **Network flow logs** turned on in the tailnet settings, and a token that can read them (`logs:network:read`). Tailscale keeps them for 30 days. The Metrics tab defaults to the last hour and shows at most 24 hours at a time. Sent and received are counted from each device's side, so tailnet totals count traffic between two of your devices once on each end.
