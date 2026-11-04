---
title: Microsoft Teams alerts
description: Send Infrawrench alerts to Microsoft Teams channels with a webhook URL, routed by your alert rules.
sidebar_order: 17
---

Infrawrench Cloud can post alerts into Microsoft Teams channels. Teams works alongside Twilio
SMS and voice, [mobile push](./mobile-push-notifications.md) and [Slack](./slack-alerts.md), with
the same triggers and thresholds.

> **Cloud only.** The desktop app has no Teams connection. A workflow page there shows as a
> native OS notification instead.

## How it differs from Slack

Slack has an **Add to Slack** button. Teams doesn't, because Microsoft only lets apps post to a
channel on behalf of a signed-in user, and alerts are sent with nobody signed in.

Instead, you create a **webhook** in the Teams channel, Teams gives you a URL, and Infrawrench
posts to it. In practice:

- You paste a URL instead of picking a channel from a menu.
- Messages come from the **Workflows** bot rather than an "Infrawrench" app.
- If you self-host, there's nothing to configure on the server. Unlike Slack, which needs
  `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, Teams alerts work as soon as you add a URL.

## Add a channel

First, create the webhook in Teams:

1. Find the channel you want alerts in. Select **More options (…) > Workflows**.
2. Choose the **Post to a channel when a webhook request is received** template.
3. Give it a name, confirm the team and channel, and select **Create**.
4. Copy the webhook URL it shows you.

<insert [Microsoft Teams channel menu with More options expanded and Workflows highlighted] here>

Then, in Infrawrench:

1. Go to **Settings > Notifications** and open the **Channels** tab.
2. In the **Microsoft Teams** section, enter:
   - **Label**: a name for the channel, such as `#alerts (Platform)`. It's only for your
     reference in this list.
   - **Webhook URL**: the URL you copied.
3. Press **Add channel**.

Add as many channels as you like. Each gets its own row.

![Settings > Notifications Microsoft Teams section with two channels listed, each showing its label and webhook hint, and the note pointing at alert routing rules for what each channel receives](https://agent-assets.infrawrench.com/docs-screenshots/features/teams-alerts/teams-two-channels.png)

### Treat the URL like a password

Anyone with a Teams webhook URL can post to that channel, so Infrawrench protects it:

- It's encrypted at rest with AES-256-GCM, the same as your provider credentials.
- It's never shown again or returned by the API after you add it. The list shows only a hint (the
  host plus the last four characters) so you can tell channels apart.
- Only URLs on Microsoft hosts are accepted (`*.api.powerautomate.com`,
  `*.api.powerplatform.com`, `*.logic.azure.com`, `*.flow.microsoft.com`, and legacy
  `*.webhook.office.com` connectors). Anything else is rejected when you add it.

To change a channel's URL, remove the row and add it again.

## Choose what each channel receives

Adding a channel makes it a **destination**. Your [alert routing rules](./alert-routing.md) decide
which alerts reach it. For example, a `#finance` channel can get only budget crossings over $500
on the production account, without every sync failure.

Until you write a rule, every connected channel gets **everything except resource drift**, so a
channel you add today starts receiving alerts straight away. Drift is left out because it's a
constant feed rather than an occasional event. You set what counts as drift, and how often a
digest can go out, in **Settings > Notifications > Resource drift alerts**.

Routing applies to the whole organization (unlike mobile push toggles, which each member sets for
themselves), so changing it needs the **Organization settings** permission.

**Send test message** posts to every channel you've added, ignoring routing rules. If a send fails,
you see Microsoft's error exactly as returned. An HTTP 404 almost always means the Workflow was
deleted or turned off in Teams.

## What the messages look like

Each alert is an Adaptive Card with the headline in bold, the alert text below it, and a short
context line. Budget alerts, drift digests, pages and approval requests also have a **View in
Infrawrench** button that opens the budget, the change timeline, the workflow, or the approvals
inbox.

The text is sent without formatting, so you won't see stray asterisks.

An **approval request** has everything you need to decide without opening the app: what's being
approved, the workflow and run that asked, whether a person or a schedule started that run, when
the request expires, and that no answer counts as a denial. Its button opens **Settings >
Approvals**.

## Move off legacy Office 365 connectors

Older **Incoming Webhook** connector URLs (on `*.webhook.office.com`) still work, and Infrawrench
still accepts them. Microsoft is retiring Office 365 connectors in Teams and turns them off in
**May 2026**, so move those channels to a Workflows webhook before then:

1. Create a new webhook as described above.
2. Add it as a new channel.
3. Remove the old row.

## Turn it off

Removing a channel stops alerts to it and leaves the others alone. Infrawrench doesn't delete the
Workflow in Teams. To stop it completely, delete or turn off the Workflow from the **Workflows**
app in Teams.

## The paging switch

Sync-failure incidents follow your organization's **Paging enabled** switch on the same settings
page. Turning it off silences incidents everywhere, Teams included. Budget alerts and pages ignore
that switch, just as they do for mobile push and Slack.
