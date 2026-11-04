---
title: Dashboard
description: Pin the resources, cost graphs, budgets, KPIs and notes you actually use to a draggable grid.
sidebar_order: 1
---

The dashboard is the first thing you see after you sign in. It's a grid of cards that you choose and arrange yourself. If you don't pin anything, it stays empty, and that's fine.

## Pin a resource

You pin from the dashboard, not from the resource. There are three ways:

- **The add tile.** An empty dashboard shows a large dashed tile that says _"Click to add to this dashboard"_. Once it has cards, the tile shrinks to a **+** labelled **Add**. Either one opens a menu: choose **Pin a resource** and search for what you want.
- **Spotlight.** The same menu entry opens the Spotlight picker. Type a few letters and press Enter to pin the highlighted resource.
- **Drag.** Drag a resource out of the sidebar (or off an account's detail page) and drop it on the dashboard grid, or onto a dashboard's entry in the sidebar. You can drag workflows the same way.

In the **desktop app**, each resource pill on an account's detail page also gets a 📌 **Pin to dashboard** button when you hover over it. There's no pin button on a resource's own detail page on either platform.

<insert [The dashboard "+" tile menu open on Pin a resource, with the Spotlight picker searching for a resource] here>

## Arrange cards

- **Move** a card by dragging it. Other cards move out of the way.
- **Resize** a cost, budget, KPI, text, custom graph, canvas or savings card with the handle in its bottom-right corner (it shows on hover). The card snaps to whole columns and rows as you drag, and the size is saved when you let go. From the keyboard, Tab to the handle and use the arrow keys: Right and Left add and remove a column, Down and Up a row. Each step is saved and read out by screen readers. Resource and workflow cards stay one column wide.
- **Duplicate** a card with the copy button next to the resize handle. The copy appears right after the original with the same settings and size, titled "Copy of …". Copying a budget or saved report card gives you a second view of the same budget or report, not a new one.
- **Unpin** a card with the **X** in its top-right corner. It shows on hover, and its tooltip reads "Remove from dashboard".

All cards can be dragged and share one order, so a cost graph or budget can sit between two resource cards instead of being stuck at the end. New cards go at the end. The order and sizes belong to each dashboard and are shared with everyone in the org.

The grid fits as many columns as the window allows, each at least 220 pixels wide, so a wider window shows more cards per row. A card wider than the columns on screen fills the row instead. Cards always grow to fit their content, so making a chart taller gives it more room and never cuts anything off.

<insert [Dashboard with a KPI card being resized from its corner handle, the dashed outline snapping to two columns, and the copy button beside the handle] here>

![Dashboard with a Droplet card, an EKS cluster card, and a Postgres database card](https://agent-assets.infrawrench.com/docs-screenshots/features/dashboard/pinned-resource-cards.png)

## What cards show

Each resource card shows the same summary as the sidebar: name, status badge, and one or two key facts (region, size, replica count and so on). Cards refresh every 30 seconds, along with the sidebar.

## Historical metrics

Pinned resources build up metric history. The sparkline on each card shows the most recent values. A resource's **Metrics** tab draws one chart per series, each labelled with the time window it covers. The window is set per resource type, and there's no range selector to change it.

History is recorded every 15 seconds. Raw points are kept for 7 days, 1-minute summaries for 30 days, and 1-hour summaries for a year.

Only **pinned** resources build up history. Unpin a resource and its history stops being collected (existing points expire on the schedule above).

Unpinned resources still get a chart: when there's no saved history, the Metrics tab fetches the data live from the provider. The tab only appears for resource types that report metrics, and if a resource has none yet it says "No metric data yet."

<insert [Resource Metrics tab showing CPU and memory series, each chart captioned with its "Last N min" window and no range selector anywhere on the tab] here>

## Cost graphs and budgets

The **+** tile on a dashboard is a menu. Besides pinning a resource, you can add (cloud orgs only):

- a **Cost graph**
- a **Saved report**
- a **New budget**, or an **Existing budget** you already have
- a **Custom graph**
- a **Realized savings** card
- a **KPI** or a **Text** card

Cost widgets chart the actual spend of your connected accounts and track monthly budgets with alerts: see [Cost graphs & budgets](./cloud-costs.md). Custom graphs are script-defined charts with their own controls: see [Custom graphs](./custom-graphs.md). A realized savings card shows what your optimization actions actually saved compared with what was projected: see [Realized savings](./realized-savings.md).

You drag these into place alongside resource cards like anything else. Cost graphs, custom graphs and realized savings cards start two columns wide and budgets one, and you can resize any of them. A cost graph can measure money, usage quantity or a count of billed services, accounts or resources, group by day up to quarter, show a running total, and draw as bars, lines, areas, a pie, a donut or a table: see [display options](./cloud-costs.md#display-options).

A budget card is a view of a budget, not the budget itself. Removing the card leaves the budget tracking and alerting, and the [**Costs** panel](./cloud-costs.md#the-costs-panel) lists every budget whether or not a dashboard shows it. **Saved report** cards work the same way: they point at a [cost report](./cost-reports.md), so editing the report updates every dashboard that shows it. A **Cost graph** is a one-off card that belongs to this dashboard alone. To pin a [canvas](./ai-canvas.md), use **Dashboards** in the canvas's own header. It shows as a two-column card with an **Open** link back to it.

![Dashboard "+" tile menu open showing Pin a resource, Cost graph, Saved report, New budget, Existing budget, and Custom graph entries](https://agent-assets.infrawrench.com/docs-screenshots/features/dashboard/dash-add-menu.png)

## KPI cards

A **KPI** card shows one big number, with the change since the previous period underneath as an amount and a percentage. The change is green when it moved the good way and red when it moved the bad way: spend going up is bad news, savings going up is good. The card picks a sensible direction from what it measures, and **A rise is** in its editor lets you change it (for a business metric such as active users, a rise is good news).

You pick every source from what your organization already has, so you never need to type an id:

| Source               | What it can show                                                                                                                                                                                                                          | Window                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Saved report**     | Spend, usage in one unit, a distinct count of the report's group-by (services, accounts, resources…), or the unit cost and business metric the report divides by. Spend, usage and the business metric can be a total or a daily average. | The report's own date range, or a range you pick for the card.                                                                                              |
| **Budget**           | Spent this period, projected at period end, remaining, or percent used, with the budget's limit underneath.                                                                                                                               | The budget's own period. The change compares with the same point of the previous period; the projection compares with how the previous period ended.        |
| **Commitments**      | Coverage and utilization of your reservations, savings plans and committed-use discounts, or the savings they realized.                                                                                                                   | Coverage and utilization use the commitments view's trailing 30 days and compare with the 30 days before. Savings use the last 30 days or a range you pick. |
| **Realized savings** | What your optimization actions saved, of every kind or one kind (right-sizing, orphan cleanup, sleep schedules…).                                                                                                                         | The last 30 days, or a range you pick.                                                                                                                      |

A report KPI keeps everything that defines the report: its filters, saved filter, cost basis and whether billing rules apply. The number uses your own access, so someone whose [cost visibility](../team-and-billing/cost-visibility.md) is limited sees their slice, just as on the report itself.

Coverage is shown as its lower bound (all usage), with the upper bound (commitment-eligible usage) in a note when they differ. The [commitments view](./cloud-costs.md#commitments) explains that range. There's no effective savings rate, because nothing records what covered usage would have cost on demand.

The editor shows a preview of the card as you build it.

<insert [KPI card editor with Saved report selected, the Measure dropdown on Spend, Daily average chosen, and the live preview card showing a figure with a red "+12.4%" badge] here>

## Text cards

A **Text** card holds notes in markdown: headings, **bold**, lists, links, quotes and `code`. Use one to label a section of the dashboard, explain what a chart is for, or link to a runbook. The editor has **Write** and **Preview** tabs.

Raw HTML isn't rendered, links open in a new window, and images show as a link to their address instead of loading, so a text card never fetches anything by itself. A card holds up to 20,000 characters and grows to fit its text.

<insert [Dashboard with a two-column text card titled "Read me first" with a heading, a bullet list and a runbook link, beside two KPI cards] here>

## Export and schedule

**Download PDF** in a dashboard's header turns every card into a PDF (a KPI as its figure and change, a text card as its paragraphs with link addresses written out). **Schedule delivery** sends it daily, weekly or monthly to Slack, Microsoft Teams or email with the PDF attached. See [PDF export and scheduled dashboards](./dashboard-pdf.md).

## Multiple dashboards

Create more dashboards from **Dashboards > New**. They're useful for splitting by environment (prod, staging) or by responsibility (mine vs team).

## Default dashboards

The dashboard you land on when you open the app (the web home page, a new tab on desktop, the top of the Dashboards tab on mobile) is chosen in three layers, most specific first:

1. **Your own default.** Open any dashboard and choose **Default > Set as my default**. You'll land there from then on, in this organization. **Default > Clear my default** goes back to the layers below.
2. **Your role's default.** An admin can give each role, built-in or custom, a default dashboard under **Settings > Roles**. Everyone with that role lands there unless they picked their own.
3. **The organization default.** The **Home** dashboard created when the organization was set up. It's the final fallback and can't be deleted.

The **Default** menu tells you which layer put you on the dashboard you're looking at, so you always know why the app opened where it did. A star on the button marks the dashboard you land on.

<insert [A dashboard header with the Default menu open, showing "You land here when you open the app: it is the default for your role, Finance." above the Set as my default entry] here>

A role default has to be a dashboard the role can open: the role needs `dashboards:read`, and the dashboard has to be [shared](../team-and-billing/cost-visibility.md#sharing-reports-and-dashboards) with the role or with the whole organization. Settings won't accept anything else and tells you why. If a dashboard's sharing is narrowed later, nobody is sent somewhere they can't see: they skip that layer and land on the next one, and the **Default** menu tells you if your own pick was skipped. Deleting a dashboard removes it as anyone's default.

<insert [Settings → Roles with the Finance role's card showing a Default dashboard picker set to "Spend overview", and the Member card set to "Organization default (Home)"] here>

You can also set role defaults in [config as code](./config-as-code.md) (a dashboard's `defaultForRoles`) and in Terraform with [`infrawrench_role_default_dashboard`](./terraform-provider.md). In the CLI, `infrawrench dashboards` marks the one you land on and says why (`--json` includes the full details).

Each member has one role today. If members could ever hold several, the choice stays predictable: a custom role's default beats a built-in role's, then Owner beats Admin beats Member, then role names in alphabetical order.

## On mobile

The [mobile app](./mobile-app.md) builds and edits dashboards too:

1. Tap **New dashboard** on the Dashboards tab.
2. Tap **Edit** on a dashboard to add cards, reorder them, set up a cost graph or budget, and rename or delete the dashboard.

**Set as my default** and **Clear my default** sit next to **Edit**, and the Dashboards tab lists the one you land on first.

A few things differ on the phone:

- Cards move with **Move up** and **Move down** instead of dragging. **Duplicate** copies a card.
- KPI and text cards are shown, but you edit them on web or desktop.
- The cost graph sheet has the same measure, unit, grouping and running total options, but a custom fixed date range is set on web and desktop.

Everything else works the same, so a dashboard built on a phone opens unchanged on web and desktop. See [building a dashboard on the phone](./mobile-app.md#building-a-dashboard-on-the-phone).

## When the dashboard is worth using

- You manage five or more accounts and don't want to hunt through the sidebar.
- You run the same check every day (is the prod DB healthy? is the worker pod running?).
- You want a wall-display view during an incident.

If you only have a handful of resources, the sidebar is usually fast enough. You don't have to pin everything.
