---
title: Mobile push notifications
description: Get incident and budget alerts on your phone through the Infrawrench mobile app, with per-org toggles and devices you manage from the web.
sidebar_order: 15
---

Infrawrench Cloud can alert you on your phone. Push notifications go to the [mobile app](./mobile-app.md), alongside Twilio SMS and voice, [Slack](./slack-alerts.md) and [Microsoft Teams](./teams-alerts.md). Same incidents, same thresholds, no phone number needed.

> **Cloud only.** Push notifications come from Infrawrench Cloud. There's nothing to set up on desktop.

## Register your phone

**Sign in on the phone and allow notifications** when the app asks. That's it. Your phone then gets notifications for every organization you belong to, subject to your per-org preferences below.

Devices look after themselves. A device the push service reports as no longer registered is removed automatically, and a device that fails five sends in a row is disabled until you open the app and sign in again.

## How urgently alerts arrive

Every Infrawrench notification is an alert, so they're all sent at the highest priority. They should arrive within seconds, not whenever your phone next wakes up.

On **iOS** they're also sent as **Time Sensitive**, which lights the screen and breaks through Focus and Do Not Disturb. An alert you set up to fire at 3am is presumably one you want to hear at 3am. You still have the final say: turn off **Time Sensitive Notifications** under **Settings > Notifications > Infrawrench** and Infrawrench alerts will respect your Focus modes like any other app.

On **Android** the same alerts arrive on a high-importance **Incidents & alerts** channel, which you can adjust (or silence) in the app's system notification settings.

**On iOS, Time Sensitive is the highest level available today**, including for pages. Infrawrench doesn't have Apple's Critical Alerts permission, so a page breaks through Focus and Do Not Disturb, but a phone on silent stays silent. If you're on call, rely on SMS and voice for the ringer, not push alone.

To make some alerts loud and others quiet, use the per-organization trigger toggles below rather than the system switch. They're per user and per org, so you can keep sync incidents on and turn budget alerts off. For "quiet after 10pm unless it's a page", set [quiet hours on a routing rule](./alert-routing.md#quiet-hours) instead. Those hold the alert and deliver it in the morning rather than dropping it.

## Choose which alerts you get

Turn triggers on or off per organization in **Settings > Notifications**, on the web or in the mobile app's settings. Everything is **on** by default except resource drift, which is off. Each member manages their own toggles.

These toggles are **mutes** that sit on top of your organization's [alert routing rules](./alert-routing.md). A rule decides whether the organization is told and which channels hear about it. Your toggles decide whether your phone rings. An admin can't unmute your notifications, and muting one here doesn't stop it reaching Slack.

| Trigger                | When it fires                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sync incidents**     | An account's background sync keeps failing and crosses the org's paging threshold                                                                                                     |
| **Budget alerts**      | A [budget threshold](./cloud-costs.md) is crossed                                                                                                                                     |
| **Cost anomalies**     | A [cost anomaly](./cost-anomaly-alerts.md) is detected: a provider's or service's spend spikes far above its usual level                                                              |
| **Resource drift**     | Resources appeared or disappeared. Batched into one digest per organization per cooldown window. See [Change timeline](./change-timeline.md). **Off by default.**                     |
| **Leaked credentials** | A code scanner found a credential committed to a repository; one push per scan, critical. See [Leaked credentials](./leaked-credentials.md)                                           |
| **Pages**              | Your own code needs a human: a [workflow](./workflows.md) calling `infra.page(...)` or waiting on `infra.waitForApproval(...)`, or a [server calling `POST /pages`](./server-push.md) |

![Web Settings > Notifications page showing the push trigger toggles, a registered device row, and the Send test push button](https://agent-assets.infrawrench.com/docs-screenshots/features/mobile-push-notifications/push-settings-web.png)

### Sync failure incidents

Sync incidents work the same way as SMS paging and are set up on the same page:

- Only automatic background syncs open incidents. Syncs you start yourself never notify, since you're already looking at the result.
- When syncs for an account and resource type fail a set number of times within a window (**default: 3 failures in 10 minutes**), an incident opens and everyone eligible is notified.
- While the incident stays open, you're notified again once per cooldown (**default: 60 minutes**) until a successful sync closes it.
- Paging must be **enabled** for the org on the Notifications page's **Channels** tab, but **Twilio credentials are optional**. With paging on and no Twilio, incidents still open and go out by push only. Add Twilio credentials and SMS and voice go to the on-call recipient list at the same time.

Tap a sync incident notification to go straight to the failing account in the app.

### Cost notifications

Cost pushes open the matching tab of the Costs screen in the [mobile app](./mobile-app.md):

| Notification                                                                                                        | Opens        |
| ------------------------------------------------------------------------------------------------------------------- | ------------ |
| Budget alert                                                                                                        | **Overview** |
| [Cost change alert](./cost-change-alerts.md), [commitment or unit-cost alert](./commitment-and-unit-cost-alerts.md) | **Alerts**   |
| Savings finding, [extended support](./extended-support.md) finding                                                  | **Savings**  |

### Budget alerts

You're notified **at most once per budget, per threshold, per calendar month**, the same as the budget badge and SMS. Budget pushes don't depend on Twilio and arrive even if paging and SMS aren't set up. Tap one to open the **Overview** tab of the Costs screen, which lists every budget in the org with its month-to-date spend.

### Resource drift

The [change timeline](./change-timeline.md) records every resource that appears, changes or disappears, which can mean hundreds of changes in one sync on a busy organization. So drift notifications are **batched**: at most one digest per organization per cooldown window (**default: 60 minutes**), covering everything since the last one, with counts, the first dozen changes named, and a link to the rest.

Drift is also **off by default**, on phones and on channels, since it's a continuous feed rather than an exceptional event. Which changes count (appearances, disappearances, and field updates, which are off by default since they're most of the volume), which accounts, and the minimum number of changes worth a notification are set for the whole organization under **Settings > Notifications > Alerts & digest > Resource drift alerts**. This needs the **Organization settings** permission.

Tap a drift notification to open the [moment view](./moment.md) for the window the digest covered, with its changes shown alongside everything else that happened (deploys, incidents, anomalies). Cost anomaly and provider incident notifications open there too. The Changes feed is one tap away.

### Pages and approval requests

Your own code can raise an alert: a [workflow](./workflows.md) calling `infra.page(...)` (for example, a cron workflow that pages you if any pod's restart count goes above 5), or a server outside Infrawrench [calling `POST /pages`](./server-push.md). Since the condition is whatever you wrote, you control repeats: every page has a **key**, and repeats with the same key are suppressed for a cooldown (**default: 60 minutes**) that you can set per call or clear when the condition recovers.

Pages go to every destination your [alert routing rules](./alert-routing.md) pick for the **Pages** trigger (mobile push, Slack channels, Teams channels), plus SMS to the Twilio recipient list when it's set up. SMS isn't a routing destination. It's set up separately on the Notifications page and goes out alongside whatever the rules picked. A page can also ask for a **voice call** for things genuinely worth waking up for. Tap a workflow's page to open that workflow in the app, where its recent runs and logs show what happened. A page sent through the API opens the org home.

A run waiting on [`infra.waitForApproval(...)`](./workflows.md) uses the same trigger and goes to the same places, plus SMS. There's one notification per request, so it needs no cooldown.

Tap an approval notification to open the app's [approvals inbox](./workflows.md#deciding-from-your-phone) with that request at the top. Approve or deny it there, after a confirmation step, since your decision lets a run go ahead or fails it.

## The Notifications settings page

The org settings page that used to be called **Paging** is now **Notifications**. It has every delivery channel in one place, across three tabs:

- **Channels:** Slack, Microsoft Teams, email, mobile push, and SMS & voice.
- **Routing:** the alert routing rules.
- **Alerts & digest:** the drift, expiry and extended support alert settings, and the weekly digest.

On those tabs you'll find:

- **Alert routing** (**Routing** tab): the ordered rules that decide where each alert goes, with quiet hours and escalation. See [Alert routing rules](./alert-routing.md).
- **Slack** (**Channels** tab): the workspace connection and the channels a rule can route to.
- **Microsoft Teams** (**Channels** tab): the channels a rule can route to, added by webhook URL.
- **Your mobile push setup** (**Channels** tab): your per-org trigger toggles, your registered devices (with a remove button), and a **Send test push** button.
- **Members receiving push** (**Channels** tab): an admin-only list (needs `org:settings:write`) of members with at least one active device, so you can see who would actually hear an incident.
- **SMS & voice** (**Channels** tab): last on the tab, since it's optional. One card with the whole Twilio setup: account SID, auth token, from-number, the threshold, window and cooldown settings, the on-call recipient list, and a **Send test page** button.

Once SMS is set up, the recipient list gets texts for sync failure incidents, [budget](./cloud-costs.md) threshold crossings, [workflow pages](./workflows.md#paging-a-human) and approval requests, and, only if your organization opts in, [cost anomalies](./cost-anomaly-alerts.md#paging-by-sms). [Drift digests](./change-timeline.md) never send texts. Voice calls are only made for sync incidents and for workflow pages that ask for `voice: true`.

## Test it

After signing in on your phone, use **Send test push** on the Notifications page (or in the mobile app's settings). It tells you how many of your devices the test reached. If it says you have no registered devices, sign in on the mobile app first.
