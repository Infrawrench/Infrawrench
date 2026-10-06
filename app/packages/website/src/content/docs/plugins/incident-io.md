---
title: incident.io
description: Declare and update incident.io incidents, acknowledge and cancel escalations, see who is on call and add overrides, browse alert sources, routes, escalation paths, severities, statuses, catalog, workflows and status pages; send Infrawrench alerts to incident.io and act on its incidents from Infrawrench.
sidebar_order: 50
---

Connect an incident.io account to work with its incidents and on-call from Infrawrench, and to make incident.io part of your [alert routing](../features/alert-routing.md) and [on-call](../features/on-call.md#paging-providers) setup.

## What you can manage

- **Incidents**: open incidents and those that changed in the last week, with status, severity, type, lead, the Slack channel and call links, and the account's duration metrics (time to acknowledge, time to resolve and so on, as configured in incident.io). **Declare** an incident (name, summary, severity, type, visibility, real or test), rename it or edit its summary, and **Post update** with an optional move to a new status or severity.
- **Escalations**: pages incident.io On-call sent, with their alerts, related incidents and history. **Acknowledge** or **Cancel** one.
- **Schedules**: who is on call now, every shift for the next seven days, and upcoming overrides. **Add override** puts someone on call on a rotation for a window you pick; each override has a **Remove** button. Rotations themselves are edited in incident.io.
- **Escalation paths**: who each path would page right now.
- **Alert sources**: each source with its recent alerts and their dedup keys. An HTTP source's events URL and secret token are outputs.
- **Alert routes**, **workflows** and **catalog types**: listed, with their state; edited in incident.io.
- **Severities**: create, rename, re-rank, describe and delete.
- **Incident statuses**, **status pages** (with their public URL), **users** and **teams**.
- **Maintenance windows**: active and upcoming windows. **End now** ends an active one; delete an upcoming one.

<insert [incident.io incident detail page showing status, severity, lead, the Durations section and the Post update dialog open with a status picker] here>

## Credentials

In incident.io, open **Settings → API keys** and create a key. Give it:

- **View data**, for incidents, the catalog, workflows and status pages;
- **Create incidents** and **Edit incidents**, to declare incidents, post updates and change status or severity;
- **View on-call** and **Manage on-call**, for schedules, overrides, escalation paths and escalations;
- **View alert sources** and **Manage alert sources**, so Infrawrench can read an HTTP source's token and send alerts to it;
- **Manage severities**, if you want to edit severities here;
- private incident access, if Infrawrench should see private incidents.

<insert [incident.io API key creation screen with the permissions listed above ticked] here>

## Paging from Infrawrench

incident.io receives alerts through **alert sources**. Create an **HTTP** source in incident.io (**Alerts → Sources**), give it an alert route to the escalation path or incident it should open, and the [alert routing](../features/alert-routing.md#pagerduty-and-incidentio) editor in Infrawrench offers it by name. Infrawrench reads the source's token through the API, so you never copy it.

Each alert uses a stable dedup key: a probe recovering, a metric alert clearing, a declared incident resolving, a sync failure healing or a page being cleared resolves the incident.io alert it fired. incident.io alerts have no acknowledged state, so an acknowledgement in Infrawrench is not sent; acknowledging the **escalation** in incident.io settles the Infrawrench escalation instead, once mirroring and its webhook are on (below).

The editor also offers **whoever is on call** on a schedule or escalation path, resolved when the alert fires, matched to Infrawrench members by email, and given one mobile push per person.

## Incidents in Infrawrench

Under **Settings → On-call → Paging providers**, tick **Show this account's incidents in Infrawrench**. Open incidents appear on the Incidents tab, on the phone and in `infrawrench paging`. **Acknowledge** moves a triage incident to the first active status; **Resolve** moves it to a closed status, or to a post-incident status when your incident lifecycle requires a post-incident flow.

incident.io has no API for creating webhooks, so to make the list update within seconds:

1. Copy the webhook URL the card shows.
2. In incident.io, open **Settings → Webhooks**, add an endpoint with that URL, and subscribe it to the incident events (created, updated, status updated), the escalation status update event and the alert resolved event.
3. Copy the endpoint's **signing secret** into the card and save.

Every delivery's signature is checked, and deliveries more than five minutes old are refused. Without a webhook, incidents are reconciled every two minutes.

<insert [Settings, On-call tab, Paging providers card for an incident.io account showing the webhook URL, the signing secret field and Last reconciled] here>

## Status

incident.io's own [status page](https://status.incident.io) feeds provider status correlation. Incidents on the API, the dashboard, or alert ingestion and paging count as affecting every incident.io account.

## Terraform

**Export to Terraform** writes `incident_severity` blocks for the [incident.io provider](https://registry.terraform.io/providers/incident-io/incident), with import commands. Schedules, escalation paths, alert sources and routes, and workflows are not exported, because their configuration (rotations, path levels, templates, steps) is not synced and a block written without it would replace the real one on apply.

## Costs

incident.io has no API for what your subscription costs, so there is no cost data.

## Limits

- Incidents read every open incident and those changed in the last week, up to 1,000 each; escalations and maintenance windows read the most recent 250.
- Workflows, alert routes, escalation paths and schedule rotations are read-only here, because their update APIs need the full configuration back.
- Acknowledging an escalation is done as the API key. incident.io may require a person to acknowledge some escalations; if so, the error says so and you acknowledge in incident.io.
