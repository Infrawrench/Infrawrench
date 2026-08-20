---
title: On-call rotations
description: Who to wake, rather than which channel to shout into — rotations, covers, and an alert routing destination that keeps meaning "whoever is on call" after Monday's handover.
sidebar_order: 12
---

[Alert routing](./alert-routing.md) answers "where does this go". Rotations
answer the question every team actually means: **who**.

Find them under **Settings → On-call**.

<insert [The Settings On-call page showing the "On call right now" card with two rotations, and one rotation expanded to show its next eight shifts] here>

## A rotation

A rotation is a list of people, a shift length, and a handover time in a named
zone. That is all:

- **Rotation order** — position in the list is the order. Reordering re-plans
  the future, which is what dragging a name means.
- **Shift length** — 7 days is the usual answer; 1 gives a daily rotation.
- **Handover time and zone** — "09:00, Europe/London".
- **First shift starts** — a calendar date. Every later boundary is derived
  from it, so changing it re-anchors the whole rotation.

Shift boundaries are **calendar days in the rotation's own zone**, never fixed
24-hour blocks. A rotation stepped in milliseconds drifts an hour at each
daylight-saving change, until the 09:00 Monday handover happens at 08:00 — or,
worse, until the boundary lands on the wrong side of the handover and two
people each think the other is on call.

## Routing to whoever is on call

In **Settings → Notifications**, a routing rule's destinations now include your
rotations. Pick one and the rule sends to the person on call at the moment the
alert fires. Nobody edits the rule at handover.

The on-call destination sends a **push notification to that person**, and it
still respects their own per-trigger mutes. An organization rule decides
whether the org is told; a member decides whether their phone rings. Being on
call does not override that — a rotation is not a licence to bypass somebody's
own settings.

If a rotation resolves to nobody — it is off, empty, has not started yet, or
could not be read — the rule's **other destinations still deliver**. An alert
lost to a misconfigured rotation would be the worst thing this feature could
do, so it is the one thing it will not do.

Two rules that name two rotations with the same person on call this week ring
that person's phone once, not twice.

## Covers

Somebody is at a wedding on Saturday. Press **Arrange cover**, pick who is
standing in and for how long.

A cover beats the rotation for exactly its window and nothing else. Where two
covers overlap, the one **written most recently** wins — so a later correction
supersedes an earlier arrangement rather than the answer depending on which row
the database returns first.

Escalation still goes to the next person in the **rotation**, never to whoever
happens to be covering next. A cover is somebody standing in for one shift.

## Permissions

**Seeing** who is on call needs **Team: read** — every member needs it and
nobody should have to ask an admin.

**Arranging cover** also needs only **Team: read**. Cover gets arranged at
17:55 on a Friday, and the person handing over is rarely an org admin. Every
cover is audit-logged, which is the control that makes the looser permission
safe: the question a reviewer asks afterwards is "who was actually on call",
and the log answers it.

**Creating or editing a rotation** needs **Organization settings: write**. A
rotation decides who gets woken up.

## Leavers

Removing somebody from the organization removes them from every rotation and
cancels their covers, automatically. A rotation naming somebody who has left
pages nobody, silently, on their week — which is the worst failure this feature
could have, so it is enforced by the database rather than by anyone remembering
to check.

## Not yet

There is no per-rotation escalation policy separate from the routing rule's
own, no round-robin across two rotations, and no phone or SMS leg for the
on-call destination (the alert routing rules' Twilio paging is org-wide, not
per-person). The `next` person is exposed by the API and shown in the UI, so
the escalation half is one step away.

## In Terraform

A rotation is an `infrawrench_on_call_schedule`, and a routing rule reaches it
with a destination whose `kind` is `on-call`:

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

Covers are deliberately not managed in Terraform: they are arranged the morning
somebody wakes up ill, and a plan that reverted one would be actively harmful.
Arrange them in the app. See the
[Terraform provider](./terraform-provider.md).

## Over the API

`GET /api/org/{orgId}/on-call/now` answers "who is on call" in one call —
useful for a status page, a Slack command or a dashboard tile. See the
[OpenAPI reference](../team-and-billing/openapi.md).
