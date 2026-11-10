---
title: Home and apps
description: Infrawrench is a set of apps, such as Costs, Observability and Security. Home shows them all, says what each one offers, and opens their tools.
sidebar_order: 0
---

Infrawrench is one application made of several apps. Each app covers one job, has its own page and its own tools, and can be used without the others. They all work on the same connected accounts and resources, so what one app knows shows up in the others.

**Home** shows every app as a card. It is what a new tab opens on, and where you land the first time you open Infrawrench.

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

- **The sidebar** lists the apps under **Apps**, below Dashboards and Chat. Click an app to expand it, then click a tool to open it. The apps you opened stay open, and the app of the tool you are looking at is always expanded.
- **Recent**, above the apps, lists the last few tools you used, newest first. It is remembered in this browser, per organization.
- **Search on Home** matches app names and tool names, so searching for `probes` shows the Probes tool and the Observability app it belongs to.
- **[Spotlight](./spotlight-search.md)** (Cmd/Ctrl + K) has a "Go to" entry for Home and for every tool.

## The rest of the sidebar

From the top:

- **Home**.
- **Dashboards** and **Chat**.
- **Recent** and **Apps**.
- Your connected provider accounts and their resources. They belong to Infrastructure, so they show while you are in Infrastructure (its page, its tools, an account or a resource) and on dashboards, where you drag resources from the sidebar to pin them. Elsewhere they are hidden, so the sidebar stays short.
- **Manage accounts**, at the bottom, lists every connected account by provider from anywhere in the app. Click one to open it, or **Add account** to connect another.

## Where you land

Opening Infrawrench takes you back to the tab you had open last time. If there is none, you land on Home. A link to a specific page always opens that page.

## Turn apps off

An organization that does not use an app can turn it off. Open **Settings**, then **Apps**, and switch the app off. The change is saved at once and applies to everyone in the organization.

![The Apps page in Settings with a switch per app, Incident response turned off and Infrastructure locked on](https://agent-assets.infrawrench.com/docs-screenshots/features/home/settings-apps-dark.png)

Infrastructure cannot be turned off. It holds your accounts and resources, which every other app reads.

**Who can do it.** Changing the switches needs the `org:settings:write` permission. Owners hold it. The built-in Admin role does not, so an admin sees the page but cannot change it. A [custom role](../team-and-billing/roles-and-permissions.md) can be given the permission. Every member can open the page and see which apps are on.

**What it hides.** An app that is off is removed from:

- Home, including search on Home
- the **Apps** list and **Recent** in the sidebar
- the "Go to" entries in [Spotlight](./spotlight-search.md)

Opening a link to the app's page says that your organization has turned the app off.

**Chat and MCP follow.** The [chat](./ai-chat.md) assistant and the [MCP server](./mcp.md) are not offered the tools of an app that is off, and a call to one is refused with a message that names the app. Tools for resources, accounts and domains always stay available.

**What it does not do.** Turning an app off does not delete anything. Data keeps being collected, alerts and schedules that are already set up keep running, and switching the app back on shows everything as it was. It also does not block the [HTTP API](../team-and-billing/openapi.md): API keys, the CLI and the Terraform provider can still call the routes behind the app, under the permissions they hold. To stop someone using a feature, take the permission away from their role or key.

The desktop app follows the setting when it is signed in to a cloud organization. Without one, every app shows.

## What sits across every app

Two things are not tied to one app:

- **[Dashboards](./dashboard.md)** pin resources, cost graphs, budgets and notes from any app to one grid. The Dashboards card opens your default dashboard.
- **[Chat](./ai-chat.md)** is one assistant that can use the tools of every app.

Both are also in the sidebar.
