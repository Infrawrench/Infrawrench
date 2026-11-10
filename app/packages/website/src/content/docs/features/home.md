---
title: Home and apps
description: Infrawrench is a set of apps, such as Costs, Observability and Security. Home shows them all, says what each one offers, and opens their tools.
sidebar_order: 0
---

Infrawrench is one application made of several apps. Each app covers one job, has its own page and its own tools, and can be used without the others. They all work on the same connected accounts and resources, so what one app knows shows up in the others.

**Home** is the page you land on. It shows every app as a card. It is also what a new tab opens on.

![The Home tab showing the grid of seven app cards, the search field above them, and the "Across every app" row with Dashboards and Chat](https://agent-assets.infrawrench.com/docs-screenshots/features/home/home-dark.png)

## The apps

| App               | What it is for                                                       | Tools                                                                                       |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Infrastructure    | Everything you run, across every provider, in one inventory          | Graph, Services, Changes, IaC, Resource reports, Domains, Quotas, Fan-out                   |
| Costs             | See what you spend, why it moved, and where to cut it                | Costs, Reports, Canvases, Kubernetes efficiency, Invoices, Price catalog                    |
| Observability     | Logs, metrics, uptime and objectives for what you run                | Logs, Alerts, Probes, SLOs, Query monitors, Wallboard                                       |
| Incident response | Declare an incident, run it, tell people, and learn from it          | Incidents, Status pages, Runbooks, Calendar                                                 |
| Security          | Find what is exposed, prove what is covered, and control who gets in | Posture, Vulnerabilities, Compliance, Access review, Just-in-time access, Expiring, Backups |
| Delivery          | Build, ship and measure every change                                 | Deploy, CI, Delivery, Environments, Env diff                                                |
| Automation        | Hand work to agents and workflows                                    | Agents, Workflows                                                                           |

Some tools need a cloud organization. In the desktop app without one, an app whose tools all need an organization still shows what it offers, and says that you need to sign in to use it. CI shows once it is turned on for your organization.

## Open an app

Click a card to open the app's page. It lists every tool in the app, with a line on what each one does. Click a tool to open it.

![The Costs app page showing its name and its list of tools](https://agent-assets.infrawrench.com/docs-screenshots/features/home/app-costs-dark.png)

Each app opens in its own tab, so you can keep several open side by side. **Home** in the breadcrumb at the top of an app's page takes you back to the grid.

## What each app does

### Infrastructure

- One inventory across all your providers, searchable and always synced
- A dependency graph that shows what breaks if a resource goes down
- A timeline of every resource that appeared, changed or disappeared
- Terraform state sorted into managed, drifted and unmanaged resources
- One command run across many hosts at once

### Costs

- Cost graphs, budgets and overspend alerts across every account
- Saved reports you can run by name and show on any dashboard
- Canvases the assistant builds from a description in plain words
- Kubernetes cost split by cluster, namespace, workload and label
- Published list prices compared across providers

### Observability

- Logs from several resources in one pane, searchable and saveable
- Threshold alerts on collected metrics, covering resources by query
- Uptime and latency checks run from outside your infrastructure
- Service-level objectives with burn-rate alerts
- Scheduled SQL queries that alert on what no metric shows
- A wallboard of everything that is wrong right now

### Incident response

- Incidents that freeze changes, notify your team and pre-fill the postmortem
- Public status pages built from the probes you already run
- Runbooks you run step by step, with a record of who did what
- One calendar of freezes, expiries, scheduled runs and incidents

### Security

- Posture checks such as public buckets and world-open firewall rules
- Vulnerability findings shown next to what is actually running
- Evidence mapped to SOC 2 and ISO 27001 controls
- Every principal in your clouds in one list, with stale access flagged
- Time-boxed roles that are removed again when the time is up
- One countdown for certificates, domains, tokens and passwords
- Backup coverage across every provider

### Delivery

- Deploys from your repositories, with history per service
- Pipelines on every push and pull request, each job in its own sandbox
- Deployment frequency, lead time, failure rate and time to restore
- Environments from a template that delete themselves when time runs out
- A side by side comparison of two accounts

### Automation

- Coding agents started on a cloud machine from any account that can run one
- TypeScript workflows across all your connected accounts
- Runs by hand, on a schedule, from a git push or from a budget

## Find a tool

Type in the search field on Home. It matches app names and tool names, so searching for `probes` shows the Probes tool and the Observability app it belongs to.

The **Tools** button in the sidebar is still there. It opens a launcher with every tool in one searchable grid, which is quicker when you already know the tool's name.

## The sidebar

- **Home** and **Tools** are always at the top.
- **Recent** lists the last few tools you used, newest first, so the ones you live in are one click away. It is remembered in this browser, per organization.
- **Dashboards** and **Chat** are always there.
- Your connected provider accounts and their resources belong to Infrastructure. They show while you are in Infrastructure (its page, its tools, an account or a resource) and on dashboards, where you drag resources from the sidebar to pin them. Elsewhere they are hidden, so the sidebar stays short.

## What sits across every app

Two things are not tied to one app:

- **[Dashboards](./dashboard.md)** pin resources, cost graphs, budgets and notes from any app to one grid. The Dashboards card opens your default dashboard.
- **[Chat](./ai-chat.md)** is one assistant that can use the tools of every app.

Both are also in the sidebar, under the **Home** and **Tools** buttons.
