---
title: Slack alerts
description: Route sync-failure incidents, budget alerts, cost anomalies, resource drift, and pages to Slack channels, with a per-channel opt-in for each.
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

Each channel opts into the alert triggers independently, so a `#finance` channel can take budget crossings without also getting every sync failure:

| Trigger           | When it fires                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sync failures** | An account's background sync keeps failing and crosses the org's paging threshold                                                                                                                              |
| **Budgets**       | A [budget threshold](./cloud-costs.md) is crossed                                                                                                                                                              |
| **Anomalies**     | A [cost anomaly](./cost-anomaly-alerts.md) is detected — a provider's or service's spend spikes far above its usual baseline                                                                                   |
| **Drift**         | Your infrastructure drifts — resources appear or disappear between polls. Batched: one digest per organization per cooldown window, never one message per change. See [Change timeline](./change-timeline.md). |
| **Pages**         | Your own code needs a human — a [workflow](./workflows.md) calling `infra.page(...)` or suspended on `infra.waitForApproval(...)`, or a [server calling `POST /pages`](./server-push.md)                       |

A sixth checkbox, **Weekly digest**, opts the channel into the [weekly summary](./weekly-digest.md) — it only sends once the digest is enabled for the org, and it arrives on whatever day and hour the org picked.

Five of the six default to on for a newly added channel. **Drift is the exception and arrives off**: sync failures, budget crossings and anomalies are exceptional events, while drift is a continuous feed whose volume is set by how busy your infrastructure is — turning it on should be a decision, not something that happens to a channel you added for budgets. What counts as drift, and how often a digest may go out, is configured once for the whole organization in **Settings → Notifications → Resource drift alerts**.

Unlike the mobile push toggles, which each member sets for themselves, Slack routing is org-wide — it takes the **Organization settings** permission to change.

<insert [Settings → Notifications Slack section with a workspace connected and two channels listed, each showing the six trigger checkboxes with Drift unchecked] here>

**Private channels need an invite.** `chat:write.public` covers public channels, but Slack won't let any app post into a private channel it isn't a member of. Invite the Infrawrench app to the channel first (`/invite @Infrawrench` in Slack), then add it here. If you skip that step, delivery fails with `not_in_channel` — the **Send test message** button surfaces that error verbatim so you can tell it apart from a genuine outage.

## What the messages look like

Each alert is a short block: the headline in bold, the alert text below it, and — for budget alerts, drift digests, pages and approval requests — a **View in Infrawrench** button that deep-links to the budget, the change timeline, the workflow, or the approvals inbox. Link previews are suppressed so an alert about a URL doesn't drag an unfurled card into the channel.

An **approval request** carries everything needed to decide without opening the app: what is being approved, the workflow and run that raised it, whether a person or a schedule started that run, when the request expires, and the fact that no decision counts as a denial. Its button lands on **Settings → Approvals**, which is where the Approve and Deny buttons live.

## Turning it off

Removing a single channel stops delivery to it and leaves the rest alone. **Disconnect** removes the whole workspace and stops all Slack delivery for the org; the channel choices are kept, so re-connecting the same workspace later restores them rather than making you set everything up again.

Disconnecting here does not uninstall the app from Slack. To remove it on the Slack side as well, do it from your workspace's **Manage apps** page.

## Interaction with the paging switch

Sync-failure incidents respect the org's master **Paging enabled** switch on the same settings page — turning it off silences incidents on every transport, Slack included. Budget alerts, anomalies, drift digests, pages and approval requests are independent of it, exactly as they are for mobile push.
