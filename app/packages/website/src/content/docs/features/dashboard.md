---
title: Dashboard
description: Pin the resources you actually use to a draggable grid.
sidebar_order: 1
---

The dashboard is the first thing you see after sign-in. It is a grid of pinned resource cards that you choose and arrange yourself. If you do not pin anything it stays empty — that is fine.

## Pin a resource

Pinning is done from the dashboard, not from the resource. There are three ways in:

- **The add tile.** An empty dashboard shows a large dashed tile reading _"Click to add to this dashboard"_; once it has cards, the same tile shrinks to a **+** labelled **Add**. Either one opens a menu — choose **Pin a resource** and search for what you want.
- **Spotlight.** The same menu entry opens the Spotlight picker in pin mode: type a few letters and press Enter to pin the highlighted resource.
- **Drag.** Drag a resource out of the sidebar (or off an account's detail page) and drop it on the dashboard grid, or onto a dashboard's entry in the sidebar. Workflows can be dragged the same way.

The **desktop app** additionally puts a 📌 **Pin to dashboard** button on each resource pill on an account's detail page, revealed on hover. There is no pin button on a resource's own detail page on either platform.

<insert [The dashboard "+" tile menu open on Pin a resource, with the Spotlight picker searching for a resource] here>

## Arrange cards

- **Drag** a card to move it. Other cards reflow.
- **Resize** a cost, budget, KPI, text, custom graph, canvas or savings card with the handle in its bottom-right corner (it appears on hover). Drag it and the card snaps to whole columns and rows as you go; let go and the size is saved. From the keyboard, Tab to the handle and use the arrow keys: Right and Left add and remove a column, Down and Up a row, and each step is saved and read out by screen readers. Resource and workflow cards stay one column wide.
- **Duplicate** a card with the copy button beside the resize handle. The copy lands right after the original with the same settings and size, titled "Copy of …". Copying a budget or saved report card gives you a second view of the same budget or report, not a new one.
- **Unpin** with the **X** icon in the card's top-right corner — it appears on hover, and its tooltip reads "Remove from dashboard".

Every kind of card is draggable and they all share one order, so a cost graph or budget can sit between two resource cards rather than being stuck at the end of the grid. New cards are added at the end. The order and the sizes are per dashboard and shared with everyone in the org.

The grid fits as many columns as the window allows, at least 220 pixels each, so a wider window shows more cards per row. A card wider than the columns on screen fills the row instead. A row height is a minimum: a card always grows to fit its content, so making a chart taller gives the chart more room and never cuts anything off.

<insert [Dashboard with a KPI card being resized from its corner handle, the dashed outline snapping to two columns, and the copy button beside the handle] here>

![Dashboard with a Droplet card, an EKS cluster card, and a Postgres database card](https://agent-assets.infrawrench.com/docs-screenshots/features/dashboard/pinned-resource-cards.png)

## What cards show

Each card shows the same summary the sidebar uses — name, status badge, and one or two key facts (region, size, replica count, etc.). Cards auto-refresh every 30 seconds along with the sidebar.

## Historical metrics

Pinned resources accumulate metric history. The dashboard sparkline on each card shows the most recent values; a resource's **Metrics** tab draws one chart per reported series, captioned with the window it covers — that window comes from the plugin, and there is no range selector to change it.

Behind the scenes, the poller writes a datapoint every 15 seconds to a time-series store. Raw points are kept for 7 days, 1-minute rollups for 30 days, and 1-hour rollups for a year.

Only **pinned** resources accumulate history. Unpin a resource and its history stops being collected (existing points age out via the retention windows above).

Unpinned resources still get a chart: when a resource has no accumulated history, the Metrics tab fetches the series live from the provider on demand. The tab itself only appears for resource types whose plugin reports metrics; where a resource has none yet, it says "No metric data yet."

<insert [Resource Metrics tab showing CPU and memory series, each chart captioned with its "Last N min" window and no range selector anywhere on the tab] here>

## Cost graphs and budgets

The **+** tile on a dashboard is a menu: pin a resource, add a **Cost graph**, place a **Saved report**, create a **New budget**, place an **Existing budget** you already have, add a **Custom graph**, a **Realized savings** card, a **KPI** or a **Text** card (all cloud orgs only). Cost widgets chart the actual spend of your connected accounts and track monthly budgets with alerts: see [Cost graphs & budgets](./cloud-costs.md). Custom graphs are script-defined charts with their own controls: see [Custom graphs](./custom-graphs.md). A realized savings card shows what your optimization actions actually saved against their projection: see [Realized savings](./realized-savings.md). They drag into place alongside resource cards like anything else on the grid; cost graphs, custom graphs and realized savings cards start two columns wide and budgets one, and any of them can be resized. A cost graph can measure money, usage quantity or a count of billed services, accounts or resources, bin by day up to quarter, accumulate, and draw as bars, lines, areas, a pie, a donut or a table: see [display options](./cloud-costs.md#display-options).

Budget cards are views onto a budget, not the budget itself: removing one leaves the budget tracking and alerting, and the [**Costs** panel](./cloud-costs.md#the-costs-panel) lists every budget whether or not a dashboard shows it. **Saved report** cards work the same way — they point at a [cost report](./cost-reports.md) by id, so editing the report updates every dashboard showing it, and a **Cost graph** stays the one-off card owned by this dashboard alone. A [canvas](./ai-canvas.md) is pinned from its own page (**Dashboards** in its header) and renders as a two-column card with an **Open** link back to it.

![Dashboard "+" tile menu open showing Pin a resource, Cost graph, Saved report, New budget, Existing budget, and Custom graph entries](https://agent-assets.infrawrench.com/docs-screenshots/features/dashboard/dash-add-menu.png)

## KPI cards

A **KPI** card is one big number with the change against the previous period underneath it, as an amount and a percentage. The change is green when it moved the good way and red when it moved the bad way: spend going up is bad news, savings going up is good. The card picks a sensible direction from what it measures, and **A rise is** in its editor lets you overrule it (a business metric such as active users is good news when it rises).

Every source is picked from what your organization already has; nothing asks for an id:

| Source               | What it can show                                                                                                                                                                                                                          | Window                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Saved report**     | Spend, usage in one unit, a distinct count of the report's group-by (services, accounts, resources…), or the unit cost and business metric the report divides by. Spend, usage and the business metric can be a total or a daily average. | The report's own date range, or a range you pick for the card.                                                                                              |
| **Budget**           | Spent this period, projected at period end, remaining, or percent used, with the budget's limit underneath.                                                                                                                               | The budget's own period. The change compares with the same point of the previous period; the projection compares with how the previous period ended.        |
| **Commitments**      | Coverage and utilization of your reservations, savings plans and committed-use discounts, or the savings they realized.                                                                                                                   | Coverage and utilization use the commitments view's trailing 30 days and compare with the 30 days before. Savings use the last 30 days or a range you pick. |
| **Realized savings** | What your optimization actions saved, of every kind or one kind (right-sizing, orphan cleanup, sleep schedules…).                                                                                                                         | The last 30 days, or a range you pick.                                                                                                                      |

A report KPI keeps everything that defines the report: its filters, saved filter, cost basis and whether billing rules apply. The number is measured with your own access, so someone whose [cost visibility](../team-and-billing/cost-visibility.md) is scoped sees their slice, exactly as on the report itself. Coverage is shown as its lower bound (all usage), with the upper bound (commitment-eligible usage) in a note when they differ, the same range the [commitments view](./cloud-costs.md#commitments) explains. There is no effective savings rate: nothing records what covered usage would have cost on demand, and an estimate of it would be read as a buying signal.

The editor previews the card as you build it.

<insert [KPI card editor with Saved report selected, the Measure dropdown on Spend, Daily average chosen, and the live preview card showing a figure with a red "+12.4%" badge] here>

## Text cards

A **Text** card holds notes in markdown: headings, **bold**, lists, links, quotes and `code`. Use them to label a section of the dashboard, explain what a chart is for, or link to a runbook. The editor has **Write** and **Preview** tabs. Raw HTML is not rendered, links open in a new window, and an image shows as a link to its address rather than loading, so a text card can never fetch anything by itself. A card holds up to 20,000 characters and grows to fit what it says.

<insert [Dashboard with a two-column text card titled "Read me first" with a heading, a bullet list and a runbook link, beside two KPI cards] here>

## Export and schedule

**Download PDF** in a dashboard's header renders every card as a PDF (a KPI as its figure and change, a text card as its paragraphs with link addresses spelled out), and **Schedule delivery** sends it daily, weekly or monthly to Slack, Microsoft Teams or email with the PDF attached. See [PDF export and scheduled dashboards](./dashboard-pdf.md).

## Multiple dashboards

You can create additional dashboards from **Dashboards → New**. Useful for splitting by environment (prod, staging) or by responsibility (mine vs team).

## On mobile

The [mobile app](./mobile-app.md) builds and edits dashboards too: **New dashboard** on the Dashboards tab, then **Edit** on a dashboard to add cards, reorder them, configure a cost graph or budget, and rename or delete the dashboard. Cards move with **Move up** / **Move down** instead of being dragged, **Duplicate** copies a card, KPI and text cards are shown but edited on web or desktop, the cost graph sheet offers the same measure, unit, binning and cumulative options, and a cost graph's custom absolute date range stays on web and desktop; everything else is the same options over the same API, so a dashboard built on a phone opens unchanged here. See [building a dashboard on the phone](./mobile-app.md#building-a-dashboard-on-the-phone).

## When the dashboard is worth using

- You manage five or more accounts and do not want to hunt through the sidebar.
- You run the same smoke-check daily (is the prod DB healthy? is the worker pod running?).
- You want a wall-display view during an incident.

If you only have a handful of resources, the sidebar is usually fast enough — don’t feel you have to pin everything.
