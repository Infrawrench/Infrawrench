---
title: PagerDuty
description: Manage PagerDuty services, escalation policies, schedules and overrides, teams, incidents, maintenance windows, business services and event orchestrations; send Infrawrench alerts to PagerDuty, page whoever is on call there, and act on PagerDuty incidents from Infrawrench.
sidebar_order: 50
---

Connect a PagerDuty account to manage your incident response setup from Infrawrench, and make PagerDuty part of your [alert routing](../features/alert-routing.md) and [on-call](../features/on-call.md#paging-providers) setup instead of a separate tool.

## What you can manage

- **Services**: every service with its status, escalation policy, timeouts, urgency, integrations and teams, who's on call for it right now, its open incidents, and the last 30 days of incidents, mean time to acknowledge, mean time to resolve, uptime, escalations and off-hours and sleep-hours interruptions. Create services (picking the escalation policy by name), edit the name, description, auto-resolve and re-trigger timeouts, **Change escalation policy**, **Open incident** on the service, **Disable** and **Enable** it, and delete it.
- **Escalation policies**: each level and who it notifies, how long it waits, how often it repeats, the services using it, and who's on call at each level right now. Create a policy with its first level (schedules and people picked from lists), edit the name, description and repeat count, and delete it. Add more levels in PagerDuty.
- **Schedules**: who's on call now, every shift for the next seven days, and the overrides for the next 30. **Add override** puts someone on call for a window you pick, and each override has a **Remove** button. Edit the rotation layers in PagerDuty's schedule editor (the link is on the page).
- **Incidents**: open incidents plus those resolved in the last week, with their alerts (and dedup keys), notes and assignees. **Acknowledge**, **Resolve**, **Reassign** (to a person or an escalation policy), **Snooze**, **Change urgency**, **Set priority** and **Add note**.
- **Teams**: create, rename, describe and delete.
- **Users**: everyone PagerDuty can page, with their role, time zone and teams.
- **Maintenance windows**: ongoing and upcoming windows. Schedule one for the services you pick, move its start or end, **End now**, or delete it.
- **Business services**: create, edit the name, description and point of contact, and delete.
- **Event orchestrations**: global rulesets with their route counts. Rename or delete them. The orchestration's routing key is shown as an output.

<insert [PagerDuty service detail page showing On call now, the Last 30 days summary with MTTA and MTTR, and the Open incidents table] here>

## Connect with PagerDuty

Click **Connect with PagerDuty** on the add-account form to sign in instead of pasting an API key. PagerDuty asks you to approve **write** access, meaning read and write access to everything your PagerDuty role can see. That's needed to acknowledge and resolve incidents, add overrides, schedule maintenance and turn on incident mirroring. Nothing changes unless you act in Infrawrench, and Infrawrench can never do more than your own PagerDuty role allows.

Once you approve, the **Service Region** is set to match your account (US or EU) and you become the **Default Acting User**, so incident actions work straight away. You can pick someone else if you prefer. The account is named after your PagerDuty subdomain.

The connection renews itself. If you revoke access in PagerDuty, or don't use Infrawrench for 210 days, the account shows **Reconnect required**. Click **Reconnect** in its credentials to sign in again.

Connect with PagerDuty works in the web app, in the desktop app's cloud mode, and for accounts stored locally on the desktop (which sign in through your browser).

<insert [PagerDuty add-account form showing the Connect with PagerDuty button above the REST API Key field] here>

## Use an API key instead

- **REST API Key**: in PagerDuty, open **Integrations > API Access Keys** and create a key (account admins and owners can). Use a **full-access** key. A read-only key lists everything but can't acknowledge incidents, add overrides, turn on incident mirroring, or add the integration Infrawrench sends alerts through.
- **Service Region**: choose **European Union** if you sign in at a `.eu.pagerduty.com` address. Otherwise leave it on United States.
- **Default Acting User** (optional): PagerDuty records a person against acknowledging, resolving, snoozing and annotating incidents, opening incidents and scheduling maintenance. Infrawrench acts as the signed-in member if their email is a PagerDuty user, and as the user you pick here otherwise. Without it, members whose email PagerDuty doesn't know can't act on incidents.

<insert [PagerDuty Add-account form with the REST API Key filled in, Service Region on United States, and the Default Acting User picker open showing the account's users] here>

## Page from Infrawrench

Once the account is connected, the [alert routing](../features/alert-routing.md#pagerduty-and-incidentio) editor lets you pick PagerDuty services (and event orchestrations) by name as destinations. If a service has no Events API v2 integration yet, Infrawrench adds one named **Infrawrench** the first time, so you never copy a routing key. Each alert keeps its PagerDuty incident in step:

- a probe recovering, a metric alert clearing, a declared incident resolving, a sync failure healing or a page being cleared resolves the PagerDuty incident it opened;
- mitigating a declared incident, or acknowledging an escalating alert in Infrawrench, acknowledges it;
- acknowledging in PagerDuty settles the Infrawrench escalation, once incident mirroring is on (below);
- the same alert firing again re-triggers the open incident instead of opening another.

The editor also offers **whoever is on call** on a schedule or escalation policy. Infrawrench looks them up when the alert fires, matches them to Infrawrench members by email, and sends one mobile push per person.

## See PagerDuty incidents in Infrawrench

Go to **Settings > On-call > Paging providers** and tick **Show this account's incidents in Infrawrench**. Open incidents then appear on the Incidents tab, on your phone and in `infrawrench paging`, with Acknowledge and Resolve. Untick the box to turn it off.

## Metrics

Services have a Metrics tab from PagerDuty Analytics, one point per day: incidents, mean time to acknowledge, mean time to resolve, uptime, escalations, and off-hours and sleep-hours interruptions. Analytics can lag PagerDuty by a few hours.

## Terraform

**Export to Terraform** writes `pagerduty_service`, `pagerduty_team`, `pagerduty_business_service`, `pagerduty_maintenance_window` (ongoing and upcoming only) and single-level `pagerduty_escalation_policy` blocks for the [PagerDuty provider](https://registry.terraform.io/providers/PagerDuty/pagerduty), with import commands. Schedules aren't exported, since applying one without its rotation layers would replace your rotation.

## Costs and status

PagerDuty has no API for what your subscription costs, so there's no cost data. PagerDuty's status page has no machine-readable feed, so provider status isn't shown for it.

## Limits

- Lists show up to 10,000 items per type, the most PagerDuty hands out. Incidents cover every open incident plus those resolved in the last week.
- Edit escalation policy levels after the first, schedule layers, event orchestration rules and service orchestration rules in PagerDuty.
