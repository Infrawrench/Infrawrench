---
title: Microsoft Teams alerts
description: Route sync-failure incidents, budget alerts, and pages to Microsoft Teams channels, with a per-channel opt-in for each.
sidebar_order: 17
---

Infrawrench Cloud can post alerts into Microsoft Teams. It sits alongside Twilio SMS/voice, [mobile push](./mobile-push-notifications.md), and [Slack](./slack-alerts.md) as a delivery channel — same triggers, same thresholds.

> **Cloud only.** Alerts are dispatched by the cloud's background poller, cost evaluation, and workflow runner. The desktop app has no Teams connection; a workflow page there becomes a native OS notification instead.

## Why this works differently from Slack

Slack has an **Add to Slack** button; Teams does not, and that is a limitation of the Teams API rather than a missing feature here.

Posting a message to a Teams channel through Microsoft Graph requires a _delegated_ permission — a signed-in user present at the moment the message is sent. The only application-level permission Microsoft offers for that endpoint is restricted to data migration. Every Infrawrench alert is raised by a background process with no user in the loop, so that route is closed to us.

The supported path is a **webhook**: you create a small automation in the Teams channel, Teams gives you a URL, and Infrawrench posts to it. The practical consequences:

- You paste a URL instead of picking from a channel menu.
- Messages arrive from the **Workflows** flow bot rather than an "Infrawrench" app.
- There is nothing for a self-hosting administrator to configure. Unlike Slack, which needs `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` on the server, Teams alerts work on every deployment the moment you add a URL.

## Adding a channel

First, create the webhook in Teams:

1. Find the channel you want alerts in. Select **More options (…) → Workflows**.
2. Choose the **Post to a channel when a webhook request is received** template.
3. Give it a name, confirm the team and channel, and select **Create**.
4. Copy the webhook URL it shows you.

<insert [Microsoft Teams channel menu with More options expanded and Workflows highlighted] here>

Then, in Infrawrench, go to **Settings → Notifications**, find the **Microsoft Teams** section, and enter:

- **Label** — a name for the channel, e.g. `#alerts (Platform)`. This is only for your own reference in this list.
- **Webhook URL** — the URL you copied.

Press **Add channel**. Add as many channels as you like; each gets its own row.

<insert [Settings → Notifications Microsoft Teams section with two channels listed, each showing the three trigger checkboxes and the webhook hint underneath] here>

### The URL is a credential

A Teams webhook URL carries its own signature — anyone who has it can post to that channel. Infrawrench treats it accordingly:

- It is encrypted at rest, with the same AES-256-GCM scheme used for provider credentials.
- It is never returned by the API or shown again after you add it. The list shows only a hint — the host plus the last four characters — so you can tell two channels apart.
- Only URLs on Microsoft-operated hosts are accepted (`*.api.powerautomate.com`, `*.api.powerplatform.com`, `*.logic.azure.com`, `*.flow.microsoft.com`, and legacy `*.webhook.office.com` connectors). Anything else is rejected when you add it.

To change a channel's URL, remove the row and add it again.

## Choosing what each channel receives

Each channel opts into the three alert triggers independently, so a `#finance` channel can take budget crossings without also getting every sync failure:

| Trigger           | When it fires                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sync failures** | An account's background sync keeps failing and crosses the org's paging threshold                                                             |
| **Budgets**       | A [budget threshold](./cloud-costs.md) is crossed                                                                                             |
| **Pages**         | Your own code raises an alert — a [workflow](./workflows.md) calling `infra.page(...)`, or a [server calling `POST /pages`](./server-push.md) |

A fourth checkbox, **Weekly digest**, opts the channel into the [Monday-morning summary](./weekly-digest.md) — it only sends once the digest is enabled for the org.

All four default to on for a newly added channel. Unlike the mobile push toggles, which each member sets for themselves, Teams routing is org-wide — it takes the **Organization settings** permission to change.

Use **Send test message** to post to every channel you've added, ignoring the trigger opt-ins. If a send fails, the error from Microsoft is shown verbatim; an HTTP 404 almost always means the Workflow was deleted or switched off on the Teams side.

## What the messages look like

Each alert is an Adaptive Card: the headline in bold, the alert text below it, a small context line, and — for budget alerts and pages — a **View in Infrawrench** button that deep-links to the budget, the workflow, or the org.

## Legacy Office 365 connectors

If you have an older **Incoming Webhook** connector URL (on `*.webhook.office.com`), it still works and Infrawrench still accepts it. Microsoft is retiring Office 365 connectors in Teams and disables them in **May 2026**, so move those channels over to a Workflows webhook before then: create the new webhook as above, add it as a new channel, and remove the old row.

## Turning it off

Removing a channel stops delivery to it and leaves the rest alone. Infrawrench does not delete the automation on the Teams side — to stop it entirely, delete or turn off the Workflow from the **Workflows** app in Teams.

## Interaction with the paging switch

Sync-failure incidents respect the org's master **Paging enabled** switch on the same settings page — turning it off silences incidents on every transport, Teams included. Budget alerts and pages are independent of it, exactly as they are for mobile push and Slack.
