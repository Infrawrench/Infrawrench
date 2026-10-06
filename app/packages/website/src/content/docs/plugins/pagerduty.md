---
title: PagerDuty
description: Manage PagerDuty services, escalation policies, schedules and overrides, teams, incidents, maintenance windows, business services and event orchestrations; send Infrawrench alerts to PagerDuty, page whoever is on call there, and act on PagerDuty incidents from Infrawrench.
sidebar_order: 50
---

Connect a PagerDuty account to manage your incident response setup from Infrawrench, and to make PagerDuty part of your [alert routing](../features/alert-routing.md) and [on-call](../features/on-call.md#paging-providers) setup rather than a separate tool.

## What you can manage

- **Services**: every service with its status, escalation policy, timeouts, urgency, integrations and teams, who is on call for it right now, its open incidents, and the last 30 days of incidents, mean time to acknowledge, mean time to resolve, uptime, escalations and off-hours and sleep-hours interruptions. Create services (picking the escalation policy by name), edit the name, description, auto-resolve and re-trigger timeouts, **Change escalation policy**, **Open incident** on the service, **Disable** and **Enable** it, and delete it.
- **Escalation policies**: each level and who it notifies, how long it waits, how often it repeats, the services using it, and who is on call at each level right now. Create a policy with its first level (schedules and people picked from lists), edit the name, description and repeat count, and delete it. Add further levels in PagerDuty.
- **Schedules**: who is on call now, every shift for the next seven days, and the overrides for the next 30. **Add override** puts someone on call for a window you pick; each override has a **Remove** button. The rotation layers themselves are edited in PagerDuty's schedule editor (the link is on the page).
- **Incidents**: open incidents plus those resolved in the last week, with their alerts (and dedup keys), notes and assignees. **Acknowledge**, **Resolve**, **Reassign** (to a person or an escalation policy), **Snooze**, **Change urgency**, **Set priority** and **Add note**.
- **Teams**: create, rename, describe and delete.
- **Users**: everyone PagerDuty can page, with their role, time zone and teams.
- **Maintenance windows**: ongoing and upcoming windows. Schedule one for the services you pick, move its start or end, **End now**, or delete it.
- **Business services**: create, edit the name, description and point of contact, and delete.
- **Event orchestrations**: global rulesets with their route counts; rename or delete them. The orchestration's routing key is an output.

<insert [PagerDuty service detail page showing On call now, the Last 30 days summary with MTTA and MTTR, and the Open incidents table] here>

## Credentials

- **REST API Key**: in PagerDuty, open **Integrations → API Access Keys** and create a key (account admins and owners can). Use a **full-access** key. A read-only key lists everything but cannot acknowledge incidents, add overrides, subscribe the incident webhook, or add the Events API integration Infrawrench sends alerts through.
- **Service Region**: **European Union** if your account signs in at a `.eu.pagerduty.com` address; otherwise leave it on United States.
- **Default Acting User** (optional): PagerDuty records a person against acknowledging, resolving, snoozing and annotating incidents, opening incidents and scheduling maintenance. Infrawrench acts as the signed-in member when their email is a PagerDuty user, and as the user you pick here otherwise. Without it, members whose email PagerDuty does not know cannot act on incidents.

<insert [PagerDuty Add-account form with the REST API Key filled in, Service Region on United States, and the Default Acting User picker open showing the account's users] here>

## Paging from Infrawrench

With the account connected, the [alert routing](../features/alert-routing.md#pagerduty-and-incidentio) editor offers PagerDuty services (and event orchestrations) as destinations, picked by name. Infrawrench sends Events API v2 events to the service's Events API v2 integration; if the service has none, it adds one named **Infrawrench** the first time, so you never copy a routing key. Each alert uses a stable dedup key, so:

- a probe recovering, a metric alert clearing, a declared incident resolving, a sync failure healing or a page being cleared resolves the PagerDuty incident it opened;
- mitigating a declared incident, or acknowledging an escalating alert in Infrawrench, acknowledges it;
- acknowledging in PagerDuty settles the Infrawrench escalation, once incident mirroring is on (below);
- the same alert firing again re-triggers the open incident instead of opening another.

The editor also offers **whoever is on call** on a schedule or escalation policy. It is resolved when the alert fires, matched to Infrawrench members by email, and gets one mobile push per person.

## Incidents in Infrawrench

Under **Settings → On-call → Paging providers**, tick **Show this account's incidents in Infrawrench**. Infrawrench subscribes a webhook through the PagerDuty API (and removes it when you untick the box), checks every delivery's `X-PagerDuty-Signature`, and reconciles every 15 minutes as a safety net. Open incidents then appear on the Incidents tab, on the phone and in `infrawrench paging`, with Acknowledge and Resolve.

## Metrics

Services have a Metrics tab built from PagerDuty Analytics, one point per day: incidents, mean time to acknowledge, mean time to resolve, uptime, escalations, and off-hours and sleep-hours interruptions. Analytics data can lag PagerDuty by a few hours.

## Terraform

**Export to Terraform** writes `pagerduty_service`, `pagerduty_team`, `pagerduty_business_service`, `pagerduty_maintenance_window` (ongoing and upcoming only) and single-level `pagerduty_escalation_policy` blocks for the [PagerDuty provider](https://registry.terraform.io/providers/PagerDuty/pagerduty), with import commands. Schedules are not exported, because their rotation layers are not synced and a schedule written without them would replace the rotation on apply.

## Costs and status

PagerDuty has no API for what your subscription costs, so there is no cost data. PagerDuty's public status page publishes no machine-readable feed, so provider status correlation does not cover it.

## Limits

- Lists read up to 2,000 objects per type; incidents read every open incident and those resolved in the last week.
- Escalation policy levels after the first, schedule layers, event orchestration rules and service orchestration rules are edited in PagerDuty.
