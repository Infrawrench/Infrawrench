---
title: Command palette (Cmd+K)
description: One shortcut to every resource, report, dashboard, budget, SLO and runbook you can open, plus your starred items, recent tabs and quick actions.
sidebar_order: 2
---

Press **Cmd + K** (macOS) or **Ctrl + K** (Windows and Linux) from anywhere in the app. The command palette opens over whatever you were doing. Type to find something and press **Enter** to open it.

<insert [The command palette open on an empty query: a Starred section with a cost report and a dashboard, each marked with a star, a Recent section listing the last few tabs, and a Quick actions section with Create cost report, Create dashboard, Create budget, New SLO and Connect account] here>

## What it finds

The palette searches everything you can open in the organization:

- **Resources** across every connected account, and **workflows**.
- **Cost**: cost reports, report folders, dashboards, budgets, canvases, saved filters, virtual tags, business metrics and scenario models.
- **Reliability**: SLOs, services, runbooks, status pages, probes, saved log queries and query monitors.

Results are grouped by kind, with the best match first. A group's position depends on how well its top result matches, so typing a report's exact name puts Cost reports at the top.

Results only include what you could open yourself. A report or dashboard that hasn't been shared with you doesn't appear, and neither does a budget outside your [cost visibility scope](../team-and-billing/cost-visibility.md). If your role can't read a kind at all (budgets without `budgets:read`, for example), the palette leaves that kind out.

Matching is forgiving. Every word you type has to match the name or a supporting label (the folder, the account, the kind), either as part of a word or as letters in order. So `prod db` finds `db-primary` in the Production account, and `cstrpt` finds "Cost report".

<insert [The command palette with the query "checkout" typed: results grouped under Services, SLOs and Cost reports, the top Services result highlighted with the Enter hint, and a star shown next to one starred SLO] here>

## Starred items

Star the things you open every day and they appear first when the palette opens. To star something:

- click the **star** next to the title of a cost report, dashboard, canvas, SLO, service or resource, or
- select it in the palette and press **Cmd + S** (macOS) or **Ctrl + S**, or use the **Star** button at the bottom of the palette.

Stars are personal and are kept per organization, so they follow you between the web app and the desktop app. If you lose access to a starred object, it drops off the list. It comes back if you get access again. You can have up to 200 starred items in each organization.

<insert [A cost report's page header with the filled star button next to the report name, and its tooltip "Starred: listed first in ⌘K"] here>

## Recent

The **Recent** section shows the last tabs you opened, most recent first. That includes pages like Costs and Settings as well as individual objects. Recents are kept per organization on each device, so the web app and the desktop app have separate lists.

## Quick actions

Quick actions do things instead of opening an object. Type **>** to show only actions. If you type without the **>**, the best-matching actions appear above the search results.

- **Create cost report**, **Create dashboard**, **Create budget**, **New SLO** and **Connect account** open the matching creation flow.
- **Go to** jumps to a page: Costs, Cost reports, Canvases, SLOs, Services, Incidents, Runbooks, Status pages, Probes, Logs or Workflows.
- **Open settings** opens any settings section you have access to, for example `>settings team`.
- **Switch to** switches organizations. On the desktop it can also switch back to the local workspace.

The palette only offers actions you have permission to use.

<insert [The command palette with ">bud" typed, showing only the Actions group with Create budget highlighted] here>

## Keyboard

| Key                        | Does                                  |
| -------------------------- | ------------------------------------- |
| Arrow up / down            | Move the selection                    |
| Page up / Page down        | Move five rows at a time              |
| Enter                      | Open the selection in the current tab |
| Cmd + Enter / Ctrl + Enter | Open the selection in a new tab       |
| Cmd + S / Ctrl + S         | Star or unstar the selection          |
| `>`                        | Show actions only                     |
| Escape                     | Close                                 |

The palette works with a screen reader. Focus stays in the search box, the selected result is announced as you move, and so is the number of results.

## On the desktop

In local mode (no organization selected), the palette searches the cached resource index and your local workflows, so it works offline. It still shows your recent tabs and the actions that apply locally, like creating a dashboard or connecting an account. Once you select a cloud organization, the palette also searches the organization's saved objects and shows your starred items.

## From other tools

- **CLI**: `infrawrench search <query>` searches the same index, and `infrawrench starred` lists your starred items. Both take `--json`. See [the CLI](./cli.md).
- **VS Code and Raycast**: the extensions' search commands also find cost reports, dashboards, budgets, SLOs and the other saved objects, and open them in the web or desktop app.
- **Mobile**: your starred items are listed above the dashboards on the home tab.
- **API**: `GET /api/org/{orgId}/search?q=…&kinds=all` returns the index, and `/starred` manages stars. Without `kinds` the endpoint returns resources and workflows only, as it always has.
