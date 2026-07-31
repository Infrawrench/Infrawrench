---
title: Mobile push notifications
description: Incident and budget alerts delivered to the Infrawrench mobile app, with per-org toggles and web-managed devices.
sidebar_order: 15
---

Infrawrench Cloud can page you on your phone. Push notifications are delivered to the [mobile app](./mobile-app.md) and sit alongside Twilio SMS/voice, [Slack](./slack-alerts.md), and [Microsoft Teams](./teams-alerts.md) as another delivery channel — same incidents, same thresholds, no phone number required.

> **Cloud only.** Notifications are dispatched by the cloud's background poller and cost evaluation; there is nothing to configure on desktop.

## Registering a device

There is no enrollment flow to speak of: **sign in on the phone and allow notifications** when the app asks. That registers the device against your user account — it then receives notifications for every organization you belong to, subject to your per-org preferences below.

Devices take care of themselves: a token the push service reports as no longer registered is pruned automatically, and a device that fails five sends in a row is disabled until it re-registers (which happens the next time you open the app and sign in).

## Delivery urgency

Every notification Infrawrench sends is an alert, so all of them go out at the highest delivery tier rather than the batched, battery-saving one — they should arrive within seconds of the condition being detected, not whenever your phone next wakes up.

On **iOS** they are also sent as **Time Sensitive**, which lights the screen and breaks through Focus and Do Not Disturb. That is deliberate: an alert you have configured to fire at 3am is one you presumably want to hear at 3am. You keep the final say — iOS exposes a per-app **Time Sensitive Notifications** switch under **Settings → Notifications → Infrawrench**, and turning it off makes Infrawrench alerts respect your Focus modes like any other app.

On **Android** the same alerts land on a high-importance **Incidents & alerts** channel, which you can retune (or silence) in the system notification settings for the app.

**Time Sensitive is the ceiling on iOS today**, including for pages. iOS has one level above it — **Critical Alerts**, which also overrides the ringer switch and cannot be turned off per app — but Apple grants that entitlement to an app case by case, and Infrawrench does not carry it. In practice: a page will break through Focus and Do Not Disturb, but a phone set to silent stays silent. If you are on call, rely on the SMS and voice channels for the ringer, not on push alone.

If you want some alerts to be loud and others not, use the per-organization trigger toggles below rather than the system switch — they are per user, per org, so you can leave sync incidents on for production and turn budget alerts off everywhere.

## Per-organization preferences

Notification triggers are toggled per user, per organization, in **Settings → Notifications** — on the web app or in the mobile app's settings. Everything defaults to **on** except resource drift, which defaults to off; each member manages their own toggles. The triggers:

| Trigger            | When it fires                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sync incidents** | An account's background sync keeps failing and crosses the org's paging threshold                                                                                                        |
| **Budget alerts**  | A [budget threshold](./cloud-costs.md) is crossed                                                                                                                                        |
| **Cost anomalies** | A [cost anomaly](./cost-anomaly-alerts.md) is detected — a provider's or service's spend spikes far above its usual baseline                                                             |
| **Resource drift** | Resources appeared or disappeared between polls. Batched into one digest per organization per cooldown window — see [Change timeline](./change-timeline.md). **Off by default.**         |
| **Pages**          | Your own code needs a human — a [workflow](./workflows.md) calling `infra.page(...)` or suspended on `infra.waitForApproval(...)`, or a [server calling `POST /pages`](./server-push.md) |

<insert [Web Settings → Notifications page showing the push trigger toggles, a registered device row, and the Send test push button] here>

### Sync-failure incidents

Sync incidents use the exact same state machine as SMS paging, configured on the same page:

- Only the **background poller** opens incidents. Manual syncs from the UI never notify, by design — you are already looking at the result.
- When syncs for an (account, resource type) pair fail the configured number of times within the window (**default: 3 failures in 10 minutes**), an incident opens and everyone eligible is notified.
- While the incident stays open, it re-notifies once per cooldown period (**default: 60 minutes**) until a successful sync closes it.
- Paging must be **enabled** for the org on the Notifications page — but **Twilio credentials are now optional**. An org with paging enabled and no Twilio configured still opens incidents and delivers push-only. Add Twilio credentials and SMS/voice go out to the on-call recipient list in the same breath.

Tapping a sync-incident notification deep-links straight to the failing account's screen in the app.

### Budget alerts

Budget threshold breaches notify **at most once per budget, per threshold, per calendar month** — the same dedupe as the budget badge and SMS. Budget pushes are independent of the org's Twilio settings: they deliver even if paging/SMS is not set up at all. Tapping one opens the **Costs** tab, which lists every budget in the org with its month-to-date spend — whether or not a dashboard shows that budget.

### Resource drift

The [change timeline](./change-timeline.md) records every resource that appears, changes, or disappears between polls — hundreds of rows in a single sync pass on a busy organization. A notification per change would be unreadable, so drift is the one trigger that is **batched rather than per event**: at most one digest per organization per cooldown window (**default: 60 minutes**), covering everything since the previous one, with the counts and the first dozen changes named and the rest linked.

It is also the one trigger that is **off by default**, on phones and on channels alike, for the same reason: it is a continuous feed rather than an exceptional event. Which changes count — appearances, disappearances, field updates (off by default, they are the bulk of the volume), which accounts, and how few changes are too few to bother with — is set once for the whole organization under **Settings → Notifications → Resource drift alerts**, and it takes the **Organization settings** permission.

Tapping a drift notification opens the **Changes** feed already filtered to the window it covered — and to the account, when every change in that window came from one. A **Since alert** chip shows the filter is on; clear it to widen the view to the whole feed.

### Pages and approval requests

Your own code can raise an alert — a [workflow](./workflows.md) calling `infra.page(...)` ("page me if any pod's restart count goes above 5" is a cron workflow that does exactly this), or a server outside Infrawrench [calling `POST /pages`](./server-push.md). Unlike the two triggers above, the condition is whatever its author wrote, so the dedupe is author-controlled: every page carries a **key** and repeats under the same key are suppressed for a cooldown (**default: 60 minutes**) the caller can set per call or clear when the condition recovers.

Pages deliver over every channel — mobile push, any Slack or Teams channel opted into **Pages**, and SMS to the Twilio recipient list when credentials are configured. The caller can additionally request a **voice call** for something genuinely worth waking up for. Tapping a workflow's page opens that workflow in the app, where its recent runs and logs show what tripped it; a page pushed over the API opens the org home.

A run suspended on [`infra.waitForApproval(...)`](./workflows.md) shares this trigger, because an approval request is a workflow asking for a human just as a page is. It goes to the same places — push, Slack, Teams and SMS — and there is exactly one per request, so it needs no cooldown of its own: the request either gets decided or times out.

Tapping an approval notification opens the app's [approvals inbox](./workflows.md#deciding-from-your-phone) with that request at the top, where you can approve or deny it — behind a confirmation step, since a decision releases or fails a run against real infrastructure.

## The Notifications settings page

The org settings page formerly titled **Paging** is now **Notifications** (the nav label changed too). It gathers every delivery channel in one place:

- **Slack** — the workspace connection and the channels each kind of alert is routed to.
- **Microsoft Teams** — the channels each kind of alert is routed to, added by webhook URL.
- **Your mobile push setup** — your per-org trigger toggles, your registered devices (with a remove button), and a **Send test push** button that delivers a test notification to your own devices.
- **Members receiving push** — an admin-only roster (requires the `org:settings:write` permission) of org members who have at least one active device, so you can see at a glance who would actually hear an incident.
- **SMS & voice** — last on the page, since it is opt-in: one card holding the whole Twilio setup — account SID, auth token, from-number, the threshold/window/cooldown knobs, the on-call recipient roster, and a **Send test page** button.

## Test it

Use **Send test push** on the Notifications page (or in the mobile app's settings) after signing in on your phone. It reports how many of your devices the test reached — if it says you have no registered devices, sign in on the mobile app first.
