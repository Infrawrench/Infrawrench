---
title: Slack alerts
description: Route sync-failure incidents, budget alerts, and workflow pages to Slack channels, with a per-channel opt-in for each.
sidebar_order: 16
---

Infrawrench Cloud can post alerts into Slack. It sits alongside Twilio SMS/voice, [mobile push](./mobile-push-notifications.md), and [Microsoft Teams](./teams-alerts.md) as another delivery channel — same triggers, same thresholds — and it is usually the one people actually read during working hours.

> **Cloud only.** Alerts are dispatched by the cloud's background poller, cost evaluation, and workflow runner. The desktop app has no Slack connection; a workflow page there becomes a native OS notification instead.

## Connecting a workspace

Go to **Settings → Notifications** and press **Add to Slack**. That opens Slack's own approval screen, where you choose the workspace and confirm the permissions. When you approve, Slack sends you back to Infrawrench and the workspace shows as connected.

<insert [Settings → Notifications page showing the Slack section before connecting, with the Add to Slack button visible] here>

Infrawrench asks for four scopes and nothing else:

| Scope               | Why                                                         |
| ------------------- | ----------------------------------------------------------- |
| `chat:write`        | Post the alert messages                                     |
| `chat:write.public` | Post to a public channel without having to be invited to it |
| `channels:read`     | List public channels so you can pick one from a menu        |
| `groups:read`       | List private channels the app has been invited to           |

It never reads message history and never posts as you — messages come from the Infrawrench app itself.

**Self-hosting?** Slack requires an app registered against your own deployment, so `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` must be set on the server, and the app's redirect URL must be `https://<your-host>/api/slack/oauth/callback`. Until they are, the Slack section says Slack isn't set up on this server and the button is hidden.

## Choosing channels

Press **Add a channel** and pick from the list — it's fetched live from your workspace, so there are no channel IDs to look up. Add as many as you like.

Each channel opts into the three alert triggers independently, so a `#finance` channel can take budget crossings without also getting every sync failure:

| Trigger            | When it fires                                                                     |
| ------------------ | --------------------------------------------------------------------------------- |
| **Sync failures**  | An account's background sync keeps failing and crosses the org's paging threshold |
| **Budgets**        | A [budget threshold](./cloud-costs.md) is crossed                                 |
| **Workflow pages** | A [workflow](./workflows.md) calls `infra.page(...)`                              |

All three default to on for a newly added channel. Unlike the mobile push toggles, which each member sets for themselves, Slack routing is org-wide — it takes the **Organization settings** permission to change.

<insert [Settings → Notifications Slack section with a workspace connected and two channels listed, each showing the three trigger checkboxes] here>

**Private channels need an invite.** `chat:write.public` covers public channels, but Slack won't let any app post into a private channel it isn't a member of. Invite the Infrawrench app to the channel first (`/invite @Infrawrench` in Slack), then add it here. If you skip that step, delivery fails with `not_in_channel` — the **Send test message** button surfaces that error verbatim so you can tell it apart from a genuine outage.

## What the messages look like

Each alert is a short block: the headline in bold, the alert text below it, and — for budget alerts and workflow pages — a **View in Infrawrench** button that deep-links to the budget or the workflow. Link previews are suppressed so an alert about a URL doesn't drag an unfurled card into the channel.

## Turning it off

Removing a single channel stops delivery to it and leaves the rest alone. **Disconnect** removes the whole workspace and stops all Slack delivery for the org; the channel choices are kept, so re-connecting the same workspace later restores them rather than making you set everything up again.

Disconnecting here does not uninstall the app from Slack. To remove it on the Slack side as well, do it from your workspace's **Manage apps** page.

## Interaction with the paging switch

Sync-failure incidents respect the org's master **Paging enabled** switch on the same settings page — turning it off silences incidents on every transport, Slack included. Budget alerts and workflow pages are independent of it, exactly as they are for mobile push.
