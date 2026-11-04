---
title: On-call rotations
description: Set up on-call rotations and covers, and route alerts to whoever is on call so they keep reaching the right person after every handover.
sidebar_order: 12
---

[Alert routing](./alert-routing.md) decides where an alert goes. Rotations decide **who** gets it.

Find them under **Settings > On-call**.

<insert [The Settings On-call page showing the "On call right now" card with two rotations, and one rotation expanded to show its next eight shifts] here>

## Create a rotation

A rotation is a list of people, a shift length and a handover time in a named time zone:

- **Rotation order:** the order of the list is the order people go on call. Drag a name to change who's next.
- **Shift length:** 7 days is typical. 1 gives a daily rotation.
- **Handover time and zone:** for example "09:00, Europe/London".
- **First shift starts:** a calendar date. Every later shift is counted from it, so changing it shifts the whole rotation.

Shifts follow **calendar days in the rotation's own time zone**, so a 09:00 Monday handover stays at 09:00 through daylight saving changes.

## Route alerts to whoever is on call

In **Settings > Notifications > Routing**, a routing rule's destinations include your rotations. Pick one and the rule sends to whoever is on call when the alert fires. Nobody has to edit the rule at handover.

The on-call destination sends a **push notification to that person**, and still respects their own per-trigger mutes. Your organization's rules decide whether the org is told. Each member decides whether their phone rings. Being on call doesn't override that.

If a rotation has nobody on call (it's off, empty, hasn't started yet, or couldn't be read), the rule's **other destinations still deliver**, so an alert is never lost to a misconfigured rotation.

If two rules name two rotations with the same person on call this week, that person's phone rings once, not twice.

## Arrange cover

Someone's at a wedding on Saturday? Press **Arrange cover** and pick who's standing in and for how long.

A cover replaces the rotation for exactly that window. If two covers overlap, the one **created most recently** wins, so a later correction replaces an earlier arrangement.

Escalation still goes to the next person in the **rotation**, not whoever happens to be covering next.

## Permissions

- **Seeing** who's on call needs **Team: read**, so every member can check without asking an admin.
- **Arranging cover** also needs only **Team: read**, since the person handing over at 17:55 on a Friday is rarely an admin. Every cover is recorded in the audit log.
- **Creating or editing a rotation** needs **Organization settings: write**.

## People who leave

Removing someone from the organization removes them from every rotation and cancels their covers automatically. Nobody has to remember to check.

## Paging providers

If your organization already pages people with [PagerDuty](../plugins/pagerduty.md) or [incident.io](../plugins/incident-io.md), connect the account and Infrawrench works with it:

- **Send alerts there.** An [alert routing](./alert-routing.md#pagerduty-and-incidentio) destination opens an alert on a PagerDuty service or an incident.io alert source, and resolves it when the condition recovers.
- **Push whoever is on call there.** A routing destination can name a PagerDuty schedule or escalation policy, or an incident.io schedule or escalation path. When the alert fires, Infrawrench asks the provider who's on call and pushes to the members whose email matches. Someone on call upstream who isn't an Infrawrench member is still paged by the provider, just not by Infrawrench.
- **See and act on their incidents here.** Under **Settings > On-call > Paging providers**, tick **Show this account's incidents in Infrawrench**. Open incidents then appear at the top of the Incidents tab on web, desktop and mobile, and in `infrawrench paging`, with **Acknowledge** and **Resolve** buttons that update the provider as you. **Declare incident** on one opens the [incident mode](./incident-mode.md) form with its title filled in.

The same card shows who's on call on each provider schedule right now, plus the alerts Infrawrench recently opened there and any that are being retried or were refused.

<insert [Settings, On-call tab, the Paging providers card with a PagerDuty account mirroring incidents (webhook subscribed) and an incident.io account showing its webhook URL and signing secret field] here>

### Keep the incident list up to date

Incidents are refreshed from the provider every couple of minutes. Add a webhook to make updates near-instant:

- **PagerDuty:** Infrawrench sets up the webhook for you when you turn this on, and removes it when you turn it off.
- **incident.io:** add the URL the card shows as an endpoint under **Settings > Webhooks** in incident.io, subscribe it to incident and escalation events, and paste its **signing secret** into the card.

Every webhook delivery is checked against its signature. Turning this off clears the incidents shown from that provider.

Permissions:

- Setting up paging providers needs **Organization settings** (`org:settings:write`).
- Acknowledging and resolving their incidents needs `incidents:write`, the same as declared incidents.
- Seeing who's on call needs `team:read`.

<insert [The Incidents tab with two open PagerDuty incidents above the declared incidents, one marked "opened by an Infrawrench alert", showing the Acknowledge, Resolve and Declare incident buttons] here>

## Not available yet

There's no per-rotation escalation policy separate from the routing rule's own, no round-robin across two rotations, and no phone or SMS for the on-call destination (the alert routing rules' Twilio paging is org-wide, not per person). The UI and API do show who's `next`.

## Manage it in Terraform

For paging providers, use `infrawrench_paging_provider_settings` per account, and routing destinations with `kind = "paging-provider"` (`account_id`, `target_id`) or `kind = "provider-on-call"` (`account_id`, `source_id`).

A rotation is an `infrawrench_on_call_schedule`. A routing rule reaches it with a destination whose `kind` is `on-call`:

```hcl
resource "infrawrench_on_call_schedule" "platform_primary" {
  name          = "Platform primary"
  timezone      = "Europe/London"
  rotation_days = 7
  handoff_time  = "09:00"
  start_date    = "2026-08-03"

  # The order of this list is the rotation.
  participant_user_ids = [var.ada_id, var.grace_id, var.alan_id]
}
```

Covers aren't managed in Terraform, since they're often arranged the morning someone wakes up ill and a plan could undo them. Arrange them in the app. See the [Terraform provider](./terraform-provider.md).

## Use the API

`GET /api/org/{orgId}/on-call/now` tells you who's on call in one call. It's handy for a status page, a Slack command or a dashboard tile. See the [OpenAPI reference](../team-and-billing/openapi.md).
