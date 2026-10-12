---
title: Raycast extension
description: Search resources and services with their cost, status and ownership, see who is on call and what is on fire, and declare an incident, from Raycast.
sidebar_order: 41
---

The Infrawrench extension for [Raycast](https://www.raycast.com) puts the questions you ask
most often one keystroke away. It talks to the same API as the web app with an API key.

## Commands

### Search Resources

Type to search resources across every connected account, plus your
[services](./services.md) and workflows. The detail pane for a resource shows:

- its provider, type, account, provider id and **status**
- what it **cost over the last 30 days**
- whether **Terraform** manages it, it has drifted, or nobody's state covers it
  ([IaC reconciliation](./iac-reconciliation.md))
- the **service** that owns it
- open **posture findings** and any open **incidents** that list it

A service's pane shows its team, who is on call, its cost, open findings, SLO standing and
scorecard levels.

<insert [Raycast's Search Resources command with "checkout" typed: a Services section with Checkout (Tier 1), a Resources section below, and the detail pane for an AWS load balancer showing Cost (30 days), Terraform: Managed, Service: Checkout and Posture: No open findings] here>

Actions: **Open in Infrawrench** (web or desktop, by preference, with the other one next to it),
**Copy Resource ID**, **Copy Name**, **Copy Link**, and **Declare Incident Affecting This**,
which for a service fills in every resource the service contains.

### Who Is On Call

Every [on-call](./on-call.md) rotation with the person on call now, when they hand off, whether
it is a cover, and who is next. Copy or email the person on call.

### Open Incidents

Open and mitigated [incidents](./incident-mode.md), open first, worst severity first, with the
summary, affected services and who declared it.

### Declare Incident

Title, severity, summary, and whether to post to the incident Slack channel, pin a
[Moment](./moment.md) and open a change freeze. Declaring notifies people, so Raycast asks you to
confirm, naming the severity and title, before anything is sent.

## Setup

1. In Infrawrench, open **Settings > API keys** and create a key. Give it `resources:read`,
   `costs:read`, `iac:read`, `incidents:read` and `team:read`, plus `incidents:write` if you
   want to declare incidents from Raycast. A command whose permission the key lacks shows the
   reason instead of data.
2. Install the extension and paste the key into **API Key**.
3. For **Organization**, paste any Infrawrench address from inside your organization (the API
   keys page you are on works) or the organization id.
4. Optionally set **Open In** to **Desktop app** to open things in the
   [desktop app](../core-concepts/desktop-vs-web.md). The desktop app must be signed in and
   showing the same organization.

Set **Infrawrench URL** only if you run your own Infrawrench.
