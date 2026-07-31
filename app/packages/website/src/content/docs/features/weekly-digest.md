---
title: Weekly digest
description: A Monday-morning summary of last week's spend, top movers, sync incidents, and resource churn, posted to Slack and Microsoft Teams.
sidebar_order: 19
---

The weekly digest is a scheduled summary rather than an alert: every Monday morning, Infrawrench Cloud posts one message per organization recapping the week that just ended. It uses the same [Slack](./slack-alerts.md) and [Microsoft Teams](./teams-alerts.md) channels you already route alerts to — there is nothing new to connect.

Each digest covers the last complete Monday-to-Sunday week (UTC) and contains:

- **Total spend** for the week, with the change against the week before — absolute and percentage. Mixed-currency organizations get one line per currency.
- **Top movers** — the three providers and three services whose spend changed the most week-over-week, from the [cost pipeline](./cloud-costs.md).
- **Sync incidents** opened during the week.
- **Resources added and removed** during the week.

> **Cloud only.** Like the alert transports, the digest is composed and sent by the cloud's background poller. The desktop app does not send digests.

## Turning it on

Go to **Settings → Notifications** and tick **Send a weekly digest** in the Weekly digest section. The first scheduled digest arrives the following Monday at 07:00 UTC — enabling mid-week doesn't immediately send a stale one. If you want to see one right away, press **Send now**: it composes last week's digest and posts it immediately, which is also the quickest way to confirm the whole pipeline works.

<insert [Settings → Notifications page showing the Weekly digest section with the enable checkbox ticked, a "Last sent" line, and the Send now button] here>

The toggle is org-wide and takes the **Organization settings** permission, exactly like the Slack and Teams routing above it.

## Choosing where it goes

Every Slack channel and Teams webhook on the Notifications page has a **Weekly digest** checkbox next to its three alert triggers. The digest goes to every channel with the box ticked — so `#finance` can take the digest and budget alerts while `#ops` keeps only sync failures.

<insert [A routed Slack channel row on the Notifications page with the four trigger checkboxes visible, Weekly digest highlighted] here>

The checkbox defaults to on for newly added channels, but nothing sends until the org-level toggle is enabled, so ticking it never surprises a channel with an unrequested Monday message.

## What the message looks like

One message per week: the date range in the headline, the spend line with the week-over-week delta, the mover lists, then the incident and resource counts, with a **View in Infrawrench** button that opens the org's cost dashboards.

<insert [A weekly digest message rendered in Slack, showing the spend total with delta, top movers by provider and service, and the reliability and resources lines] here>

Weeks with no recorded cost data say so instead of printing zeros — typically an org that hasn't connected an account with cost collection yet.

## Scheduling details

- Digests fire at **07:00 UTC on Monday**. If the background workers were down at the time, the digest is sent as soon as they are back — still covering the last complete week — rather than being skipped.
- Delivery is exactly-once per week per organization, including across worker restarts and replicas.
- A week's digest that fails to deliver (for example, every routed channel rejects the post) is logged and not retried until the next week; **Send now** is the manual recovery.
