---
title: Mobile push notifications
description: Incident and budget alerts delivered to the Infrawrench mobile app, with per-org toggles and web-managed devices.
sidebar_order: 15
---

Infrawrench Cloud can page you on your phone. Push notifications are delivered to the [mobile app](./mobile-app.md) and sit alongside Twilio SMS/voice as a second delivery channel — same incidents, same thresholds, no phone number required.

> **Cloud only.** Notifications are dispatched by the cloud's background poller and cost evaluation; there is nothing to configure on desktop.

## Registering a device

There is no enrollment flow to speak of: **sign in on the phone and allow notifications** when the app asks. That registers the device against your user account — it then receives notifications for every organization you belong to, subject to your per-org preferences below.

Devices take care of themselves: a token the push service reports as no longer registered is pruned automatically, and a device that fails five sends in a row is disabled until it re-registers (which happens the next time you open the app and sign in).

## Per-organization preferences

Notification triggers are toggled per user, per organization, in **Settings → Notifications** — on the web app or in the mobile app's settings. Everything defaults to **on**; each member manages their own toggles. The v1 triggers:

| Trigger            | When it fires                                                                     |
| ------------------ | --------------------------------------------------------------------------------- |
| **Sync incidents** | An account's background sync keeps failing and crosses the org's paging threshold |
| **Budget alerts**  | A [budget threshold](./cloud-costs.md) is crossed                                 |
| **Workflow pages** | A [workflow](./workflows.md) calls `infra.page(...)`                              |

<insert [Web Settings → Notifications page showing the push trigger toggles, a registered device row, and the Send test push button] here>

### Sync-failure incidents

Sync incidents use the exact same state machine as SMS paging, configured on the same page:

- Only the **background poller** opens incidents. Manual syncs from the UI never notify, by design — you are already looking at the result.
- When syncs for an (account, resource type) pair fail the configured number of times within the window (**default: 3 failures in 10 minutes**), an incident opens and everyone eligible is notified.
- While the incident stays open, it re-notifies once per cooldown period (**default: 60 minutes**) until a successful sync closes it.
- Paging must be **enabled** for the org on the Notifications page — but **Twilio credentials are now optional**. An org with paging enabled and no Twilio configured still opens incidents and delivers push-only. Add Twilio credentials and SMS/voice go out to the on-call recipient list in the same breath.

Tapping a sync-incident notification deep-links straight to the failing account's screen in the app.

### Budget alerts

Budget threshold breaches notify **at most once per budget, per threshold, per calendar month** — the same dedupe as the budget badge and SMS. Budget pushes are independent of the org's Twilio settings: they deliver even if paging/SMS is not set up at all. Tapping one opens the org home screen, where the budget card shows its alert badge.

### Workflow pages

A [workflow](./workflows.md) that finds a problem can raise an alert itself by calling `infra.page(...)` — "page me if any pod's restart count goes above 5" is a cron workflow that does exactly this. Unlike the two triggers above, the condition is whatever the workflow's author wrote, so the dedupe is author-controlled: every page carries a **key** and repeats under the same key are suppressed for a cooldown (**default: 60 minutes**) that the workflow can set per call or clear when the condition recovers.

Workflow pages deliver over both channels — mobile push, and SMS to the Twilio recipient list when credentials are configured. A workflow can additionally request a **voice call** for something genuinely worth waking up for. Tapping a workflow page opens that workflow in the app, where its recent runs and logs show what tripped it.

## The Notifications settings page

The org settings page formerly titled **Paging** is now **Notifications** (the nav label changed too). It gathers every delivery channel in one place:

- **Twilio configuration** — account SID, auth token, from-number, and the threshold/window/cooldown knobs. Optional, as above.
- **Recipients** — the SMS/voice on-call roster (unchanged).
- **Your mobile push setup** — your per-org trigger toggles, your registered devices (with a remove button), and a **Send test push** button that delivers a test notification to your own devices.
- **Members receiving push** — an admin-only roster (requires the `org:settings:write` permission) of org members who have at least one active device, so you can see at a glance who would actually hear an incident.

## Test it

Use **Send test push** on the Notifications page (or in the mobile app's settings) after signing in on your phone. It reports how many of your devices the test reached — if it says you have no registered devices, sign in on the mobile app first.
