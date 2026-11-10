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

Click a card to open the app's page. The page has:

- **Tools**: every tool in the app, with a line on what it does. Click one to open it.
- **What it does**: a short list of what the app covers.
- **Works with**: the other apps it shares data with, and what they share. Click one to go to that app.

![The Costs app page showing its header, the Tools list, the "What it does" list and the "Works with" cards](https://agent-assets.infrawrench.com/docs-screenshots/features/home/app-costs-dark.png)

Each app opens in its own tab, so you can keep several open side by side. **Home** in the breadcrumb at the top of an app's page takes you back to the grid.

## Find a tool

Type in the search field on Home. It matches app names and tool names, so searching for `probes` shows the Probes tool and the Observability app it belongs to.

The **Tools** button in the sidebar is still there. It opens a launcher with every tool in one searchable grid, which is quicker when you already know the tool's name.

## What sits across every app

Two things are not tied to one app:

- **[Dashboards](./dashboard.md)** pin resources, cost graphs, budgets and notes from any app to one grid. The Dashboards card opens your default dashboard.
- **[Chat](./ai-chat.md)** is one assistant that can use the tools of every app.

Both are also in the sidebar, under the **Home** and **Tools** buttons.
