---
title: incident.io
description: Declare and update incident.io incidents, acknowledge and cancel escalations, see who is on call and add overrides, browse alert sources, routes, escalation paths, severities, statuses, catalog, workflows and status pages; send Infrawrench alerts to incident.io and act on its incidents from Infrawrench.
sidebar_order: 50
---

Connect incident.io to work with its incidents and on-call from Infrawrench, and to add it to your [alert routing](../features/alert-routing.md) and [on-call](../features/on-call.md#paging-providers) setup.

## What you can manage

- **Incidents**: open incidents and those that changed in the last week, with status, severity, type, lead, the Slack channel and call links, and your duration metrics (time to acknowledge, time to resolve and so on, as set up in incident.io). **Declare** an incident (name, summary, severity, type, visibility, real or test), rename it or edit its summary, and **Post update**, optionally moving it to a new status or severity.
- **Escalations**: pages incident.io On-call sent, with their alerts, related incidents and history. **Acknowledge** or **Cancel** one.
- **Schedules**: who's on call now, every shift for the next seven days, and upcoming overrides. **Add override** puts someone on call on a rotation for a window you pick, and each override has a **Remove** button. Edit rotations in incident.io.
- **Escalation paths**: who each path would page right now.
- **Alert sources**: each source with its recent alerts and their dedup keys. An HTTP source's events URL and secret token are outputs.
- **Alert routes**, **workflows** and **catalog types**: listed with their state. Edit them in incident.io.
- **Severities**: create, rename, re-rank, describe and delete.
- **Incident statuses**, **status pages** (with their public URL), **users** and **teams**.
- **Maintenance windows**: active and upcoming windows. **End now** ends an active one, and you can delete an upcoming one.

<insert [incident.io incident detail page showing status, severity, lead, the Durations section and the Post update dialog open with a status picker] here>

## Connect your account

In incident.io, open **Settings > API keys** and create a key. Give it:

- **View data**, for incidents, the catalog, workflows and status pages.
- **Create incidents** and **Edit incidents**, to declare incidents, post updates and change status or severity.
- **View on-call** and **Manage on-call**, for schedules, overrides, escalation paths and escalations.
- **View alert sources** and **Manage alert sources**, so Infrawrench can send alerts to an HTTP source.
- **Manage severities**, if you want to edit severities here.
- Private incident access, if Infrawrench should see private incidents.

<insert [incident.io API key creation screen with the permissions listed above ticked] here>

## Page incident.io from Infrawrench

1. In incident.io, create an **HTTP** alert source (**Alerts > Sources**).
2. Give it an alert route to the escalation path or incident it should open.
3. In Infrawrench, the [alert routing](../features/alert-routing.md#pagerduty-and-incidentio) editor now offers it by name. You don't need to copy its token.

When the problem clears (a probe recovers, a metric alert clears, a declared incident resolves, a sync failure heals or a page is cleared), the incident.io alert it fired resolves too. incident.io alerts have no acknowledged state, so acknowledging in Infrawrench isn't sent over. Instead, acknowledging the **escalation** in incident.io settles the Infrawrench escalation, once you've turned on incidents in Infrawrench and its webhook (below).

The editor also offers **whoever is on call** on a schedule or escalation path. That person is looked up when the alert fires, matched to Infrawrench members by email, and gets one mobile push.

## See incidents in Infrawrench

Under **Settings > On-call > Paging providers**, tick **Show this account's incidents in Infrawrench**. Open incidents then show on the Incidents tab, on your phone and in `infrawrench paging`. **Acknowledge** moves a triage incident to the first active status. **Resolve** moves it to a closed status, or to a post-incident status if your incident lifecycle needs a post-incident flow.

To make the list update within seconds, add a webhook (incident.io doesn't let apps create them for you):

1. Copy the webhook URL the card shows.
2. In incident.io, open **Settings > Webhooks**, add an endpoint with that URL, and subscribe it to the incident events (created, updated, status updated), the escalation status update event and the alert resolved event.
3. Copy the endpoint's **signing secret** into the card and save.

Every delivery's signature is checked, and deliveries more than five minutes old are refused. Without a webhook, incidents update every two minutes.

<insert [Settings, On-call tab, Paging providers card for an incident.io account showing the webhook URL, the signing secret field and Last reconciled] here>

## Status

incident.io's own [status page](https://status.incident.io) feeds provider status. Incidents on the API, the dashboard, or alert ingestion and paging count as affecting every incident.io account.

## Terraform

**Export to Terraform** writes `incident_severity` blocks for the [incident.io provider](https://registry.terraform.io/providers/incident-io/incident), with import commands. Schedules, escalation paths, alert sources and routes, and workflows aren't exported, because an export without their full configuration would replace the real one when you apply.

## Costs

incident.io doesn't share what your subscription costs, so there's no cost data.

## Limits

- Incidents include every open incident and those changed in the last week, up to 1,000 each. Escalations and maintenance windows show the most recent 250.
- Workflows, alert routes, escalation paths and schedule rotations are read-only here.
- Escalations are acknowledged as the API key. incident.io may require a person to acknowledge some escalations. If so, the error tells you, and you acknowledge in incident.io.
