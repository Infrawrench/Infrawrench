---
title: Raycast extension
description: Search resources and services with their cost, status and ownership, see who is on call and what is on fire, and declare an incident, from Raycast.
sidebar_order: 41
---

The Infrawrench extension for [Raycast](https://www.raycast.com) puts the questions you ask most often one keystroke away. It uses an API key to reach your Infrawrench organization.

## Commands

### Search Resources

Type to search resources across every connected account, plus your [services](./services.md) and workflows. Select a resource to see:

- its provider, type, account, provider id and **status**
- what it **cost over the last 30 days**
- whether **Terraform** manages it, it has drifted, or no state covers it ([IaC reconciliation](./iac-reconciliation.md))
- the **service** that owns it
- open **posture findings** and any open **incidents** that list it
- the **[vulnerabilities](./vulnerabilities.md)** running on it ("2 critical, 1 high (1 known exploited)"). This row is hidden when no connected account runs a scanner.

Select a service to see its team, who is on call, its cost, open findings, SLO standing and scorecard levels.

The same search also finds what the [command palette](./spotlight-search.md) finds: cost reports, dashboards, budgets, canvases, SLOs, runbooks, status pages, probes and more, each in its own section. Opening one takes you to it in the web or desktop app (your **Open In** preference). You only see items the API key's owner can open.

<insert [Raycast's Search Resources command with "checkout" typed: a Services section with Checkout (Tier 1), a Resources section below, and the detail pane for an AWS load balancer showing Cost (30 days), Terraform: Managed, Service: Checkout, Posture: No open findings and Vulnerabilities: 1 high] here>

Actions you can take:

- **Open in Infrawrench** (web or desktop, by preference, with the other one next to it)
- **Copy Resource ID**, **Copy Name**, **Copy Link**
- **Open Vulnerabilities** (your organization's Vulnerabilities tab)
- **Declare Incident Affecting This**. For a service, this fills in every resource the service contains.

### Who Is On Call

Shows every [on-call](./on-call.md) rotation with who's on call now, when they hand off, whether it's a cover, and who's next. You can copy or email the person on call.

### Open Incidents

Lists open and mitigated [incidents](./incident-mode.md), open ones first and worst severity first, with the summary, affected services and who declared it.

### Declare Incident

Enter a title, severity and summary, and choose whether to post to the incident Slack channel, pin a [Moment](./moment.md) and open a change freeze. Declaring notifies people, so Raycast asks you to confirm the severity and title before anything is sent.

## Set it up

1. In Infrawrench, open **Settings > API keys** and create a key. Give it `resources:read`, `costs:read`, `iac:read`, `incidents:read` and `team:read`, plus `incidents:write` if you want to declare incidents from Raycast. If the key is missing a permission, the command that needs it tells you why instead of showing data.
2. Install the extension and paste the key into **API Key**.
3. For **Organization**, paste any Infrawrench address from inside your organization (the API keys page you're on works) or the organization id.
4. Optionally set **Open In** to **Desktop app** to open things in the [desktop app](../core-concepts/desktop-vs-web.md). The desktop app must be signed in and showing the same organization.

Only set **Infrawrench URL** if you run your own Infrawrench.
