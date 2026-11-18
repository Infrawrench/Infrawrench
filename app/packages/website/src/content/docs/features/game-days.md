---
title: Game days
description: Break something on purpose, on a schedule, with an automatic undo, and measure how long it took your probes, alerts and on-call to notice and how long the service took to recover.
sidebar_order: 14
---

A **game day** is a planned, controlled failure. You pick a service or some resources, a failure
to inject (stop an instance, scale a deployment to zero), a start time and a time limit.
Infrawrench injects the failure at the start, watches what notices, undoes it at the time limit,
and waits for your probes to go green again. What you get back is a report: time to detect, time
to page, time to acknowledge, time to recover, and which detectors fired and which stayed silent.

<insert [The Game days tab showing one game day's report: the four time tiles (detect 1 min 20 s, page 4 min, acknowledge 3 min, recover 2 min), the detector table with "First failed probe check" and "On-call paged" fired and "SLO burn alert" marked "Did not fire", and the targets table] here>

## Where to find it

Open **Game days** in the sidebar of the web app, or of the desktop app in cloud mode (it sits with
Incidents). The mobile app shows game days read-only, with the abort button on a running one, and
the `infrawrench` [CLI](./cli.md) lists them, prints reports and aborts with
`infrawrench game-days`.

## What can be broken

Only failures with a reliable undo. A resource type offers a failure when its plugin declares one:

| Failure                | Undo                                     | Where                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop                   | Start again                              | Every resource a [sleep schedule](./sleep-schedules.md#which-resources-can-sleep) can stop, such as EC2 and RDS instances, Compute Engine and Azure VMs, Droplets and Hetzner servers |
| Scale to zero replicas | Scale back to the previous replica count | Kubernetes Deployments and StatefulSets                                                                                                                                               |
| Scale to zero tasks    | Scale back to the previous desired count | AWS ECS services                                                                                                                                                                      |

Nothing destructive is offered: no deletes, no resizes, nothing whose undo would be a re-create.
The count to restore is read from the provider **before** anything changes and stored, so the undo
still knows it if the server restarts mid-run. A resource that is already in the failed state when
the game day starts (a deployment already at zero) is left alone, neither changed nor "undone".

## Plan one

Press **New game day** and fill in:

- **Name** and, optionally, the **hypothesis** you are testing ("a probe pages on-call within five
  minutes").
- **Service** (optional). Its members are listed first in the resource picker, and an alert about
  any of them counts as detection.
- **What to break**: one or more resources and, for each, one of the failures its type supports.
- **Starts**, **Time limit** (5 to 240 minutes) and **Recovery wait** (5 to 120 minutes: how long
  after the undo the watched probes have to go green).
- **Watched probes** and **watched SLOs**: the [probes](./synthetic-probes.md) whose failures
  count as detection and whose recovery confirms the undo, and the [SLOs](./slos.md) whose burn
  alerts count. The service's linked SLOs are watched too.
- **Start a change freeze while it runs**: opens an org [change freeze](../team-and-billing/change-freeze.md)
  at the injection and ends it when the game day completes.

**Dry run** shows what injecting would do right now, without changing anything: each target's
current state as its provider reports it, targets that would be skipped or cannot run, a change
freeze that would stop the start, and detectors nothing is set up to measure.

Saving stores the game day as **Planned**. Nothing happens to a planned game day; it shows on the
[operations calendar](./ops-calendar.md) so the team can see the slot.

## Arm it

A game day never runs unless a person confirms it. **Arm** opens the confirmation: the dry run
again, the [blast radius](./blast-radius.md) of every target, and a box where you type the game
day's name. Once armed, the failure is injected at the start time, or straight away if that has
passed. **Disarm** takes it back to planned before the start.

Arming is refused to API keys and agents, and there is no recurring schedule: every run is
confirmed by somebody.

<insert [The Arm game day dialog: the dry run listing two targets with their current state ("3 replicas") and undo, the blast radius summary under each target, and the confirmation field asking to type the game day's name] here>

## While it runs

The page refreshes every few seconds. A red bar at the top shows when the failure will be undone,
with an **Abort** button that is always there while the failure may be in effect. **End now**
undoes it early and records the game day as ended rather than aborted.

What is watched, from the moment of the injection:

- **First failed probe check** and **probe declared down** on the watched probes.
- **Metric alerts** that fire on a target or a member of the service.
- **SLO burn alerts** on the watched and linked SLOs.
- **Incidents** declared by anyone in the organization.
- **Alerts sent**: every alert your [routing rules](./alert-routing.md) handle is recorded against
  the game day, marked as related when it is about a target, a member, a watched probe or SLO, or
  a declared incident. An alert routed to an [on-call rotation](./on-call.md) or a paging provider
  counts as a **page**, and its acknowledgement (from Slack, the web, or the paging provider) as
  the **acknowledgement**. An alert no rule sent anywhere is listed too, marked as such: it was
  raised and nobody was told.

At the time limit, on End now or on Abort, the failure is undone. Then the game day waits for every
watched probe to be checked green again; the time from the undo to that point is the **time to
recover**. With no watched probes, recovery is not measured.

## The report

| Number              | Measured from                 | To                                                   |
| ------------------- | ----------------------------- | ---------------------------------------------------- |
| Time to detect      | the injection                 | the first detector of any kind                       |
| Time to page        | the injection                 | the first related alert routed to on-call or a pager |
| Time to acknowledge | the page (or the first alert) | its acknowledgement                                  |
| Time to recover     | the undo                      | the watched probes green again                       |

The detector table says, for each detector, when it fired, **Did not fire**, or **Not set up**
when nothing could have fired it (no watched probe, no SLO). "Did not fire" and "Not set up" are
different findings: the first is a gap in your alerting, the second a gap in the game day.

## Safety

- **The undo survives restarts.** The undo state is stored before each injection. A game day found
  mid-injection after a restart is undone, never resumed.
- **A failing undo is never hidden.** It is retried with backoff; after ten attempts the game day
  is marked **Undo failed** in red with the provider's error and a **Retry undo** button, because
  the resource may still be broken.
- **Somebody else's change freeze stops the start.** If a freeze is in effect at the start time,
  the game day is cancelled, not deferred. The undo runs whatever freeze is in effect, including
  the one the game day opened.
- **Everything is audited**: planning, arming, the injection, the undo and every abort.

## Permissions

| Action                                        | Permission       |
| --------------------------------------------- | ---------------- |
| See game days and their reports               | `game-days:read` |
| Abort                                         | `game-days:read` |
| Plan, edit, dry-run, arm, disarm, end, delete | `game-days:run`  |

Members can watch and abort: stopping an experiment only ever puts things back, and whoever sees
customers hurting first should be able to press it. Planning and arming stay with admins and
owners.

## Services scorecards

A [scorecard](./services.md#scorecards) can include **Failure detected in a game day**: it passes
when the service's most recent game day in the last 90 days was detected, fails when it went
undetected or the service had none, and is not applicable until the organization has completed a
game day.
