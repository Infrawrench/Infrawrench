---
title: Cost graphs & budgets
description: Graph your cloud spend, set monthly budgets, and get overspend alerts for your connected accounts, right on the dashboard.
sidebar_order: 2
---

Cost graphs show the billing data from your connected provider accounts as dashboard widgets. You can see spend over time, broken down by provider, account, service, region, resource or tag. Budgets alert you before the bill does.

Your budgets live in the **Costs** panel in the sidebar. Dashboards show cards, but the panel is the full list. See [The Costs panel](#the-costs-panel).

Related pages:

- To name a graph and reuse it on several dashboards, save it as a [cost report](./cost-reports.md).
- To see **cost per unit** of what your business does (per customer, per request, per GB), declare a [business metric](./unit-costs.md). Any cost graph can divide by it. The same page covers margin.
- To get the rows instead of a graph, for a warehouse or a finance system, set up a [scheduled cost export](./cost-exports.md): CSV or NDJSON, on a schedule, to an S3-compatible bucket or an HTTPS endpoint.

> **Cloud only.** Cost data is collected by Infrawrench Cloud. On the desktop app the widgets appear when you are signed into a cloud org. Local-only mode does not collect cost data.

> Costs are **billed history**. To see what a resource would cost before you create or resize it, see [live cost estimates](./cost-estimates.md).

## Add a cost graph

1. Open a dashboard and click the **+** tile.
2. Choose **Cost graph**.
3. Pick a chart type, date range and grouping, then click **Save**.

This card belongs to this dashboard only. To save the same setup under a name and show it on several dashboards, make a [cost report](./cost-reports.md) and choose **Saved report** from the same menu.

![Dashboard "+" tile open with the add menu showing Pin a resource / Cost graph / Saved report / New budget / Existing budget](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/dash-add-menu.png)

![Cost graph config modal with chart type, binning, date range, group-by, and a provider filter row](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/cost-graph-config-modal.png)

You can drag cost and budget cards around the grid like pinned resources. See [Arrange cards](./dashboard.md#arrange-cards).

### What you can configure

| Option     | Choices                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chart type | Stacked bar, bar, line, area, pie, donut, or a table. See [display options](#display-options)                                                                                                    |
| Measure    | **Cost** (money), **Usage quantity** in one unit, or **Count** of distinct group values billed per bin                                                                                           |
| Binning    | Daily, weekly, monthly, quarterly (hourly shows as disabled, see below)                                                                                                                          |
| Cumulative | Running totals from the start of the range, at any bin size                                                                                                                                      |
| Date range | Last 7/30/90 days, month/quarter/year to date, last month, last 12 months, or custom dates                                                                                                       |
| Group by   | Provider, account, service, region, resource, tag, charge type, or commitment                                                                                                                    |
| X axis     | **Date** (the default), or a dimension's values: one bar per service, account, tag value... ranked by spend. See [chart axes](./cost-chart-axes.md)                                              |
| Filters    | Any of the same dimensions, `is` / `is not`, multiple rules, as rows or as [text](#filters-as-text)                                                                                              |
| Cost basis | **Cash** (what you were charged), **Amortized** (commitments spread over the term they buy) or **Blended** (amortized, with commitment discounts shared evenly across eligible usage). See below |
| Top groups | Show the top N groups (default 5). The rest fold into **Other**                                                                                                                                  |
| Compare    | Overlay the previous period as a dashed line or as paired bars beside each bar, with a % change badge                                                                                            |
| Forecast   | Project the recent trend forward as a dashed line                                                                                                                                                |

![A stacked-bar cost graph grouped by service with a forecast dashed line and previous-period comparison](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/cost-graph-service-forecast.png)

Currencies are never merged unless you turn on [conversion](#currency). If your accounts bill in more than one currency, the graph shows one series per currency and says so under the title.

### Display options

These options are in the graph editor on web, desktop and mobile. They are saved with the card or [report](./cost-reports.md).

- **Measure** is what the Y axis adds up.
  - **Cost** is money, per currency. This is the default.
  - **Usage quantity** adds up the usage amounts providers report next to the money: instance hours, GB-months, requests. You can't add hours to gigabytes, so a usage chart sums exactly one unit. Pick it from the **Usage unit** list, which shows the units your providers report, spelled their way. Only rows in that unit count. If no connected provider reports usage, the editor tells you.
  - **Count** shows how many distinct values of the **Group by** dimension had a nonzero cost in each bin. For example, how many services were billed each day, or how many accounts spent anything each week. It needs a group-by, since that is what it counts. The headline total counts each value **once over the whole range**, so a service billed on all thirty days is one service. Empty values (rows with no resource id, untagged rows) are not counted.
- **Chart type**: **Stacked bar**, **Bar** (side by side), **Line** and **Area** draw a time axis. **Pie** and **Donut** draw each group's total for the period, and the donut shows the total in its hole. **Table** lists every bin as a row with a column per series and the bin's total. With **Compare previous period** on, it adds the previous period's figure. Count is a single series, so pie and donut aren't offered for it.
- **Binning**: daily, weekly (starting Monday), monthly or quarterly (quarters start on 1 January, April, July and October, UTC). **Hourly** is listed but disabled, because providers report cost per day. It turns on by itself if an account ever reports hourly rows.
- **Cumulative** shows running totals from the start of the range, at any bin size. Totals then read the last point. Count can't be cumulative, since it would count the same service once per bin.
- **Compare previous period** overlays the same span shifted back one period, for every measure. It shows as a dashed totals line, or on a bar chart as a muted bar beside each bar. Tables add previous, change and change % columns.
- **X axis** can show a dimension instead of dates: one bar per value, ranked by spend, split by the group-by or by date bin. Click a bar (or a slice, a legend entry, a table value) to drill into it. See [Chart axes, comparison & drill-down](./cost-chart-axes.md).

Forecasts, scenarios, billing rules and unit costs only apply to money, so they are switched off for the usage and count measures. A usage or count card says under its title what it measures, so a number with no currency sign is never mistaken for dollars.

<insert [Cost graph editor with Measure set to Usage quantity, the Usage unit list open showing provider units such as Hrs and GB-Mo, Binning set to Quarterly with the disabled Hourly option and its explanation visible] here>

<insert [A dashboard cost card in Table view, quarterly bins, grouped by service with Count as the measure, showing the "Distinct values with nonzero cost per bin" caption under the title] here>

### Annotations

Every cost chart, this card included, shows your org's **annotations**: dated notes that explain what happened, marked on the bucket that holds their day. Click a bar to write one, or read existing ones from the numbered strip under the chart. A dashboard card shows the org-wide notes. A [cost report](./cost-reports.md#annotations) also shows its own. Annotations never change a series, a total or an axis.

## Filters as text

Filter rows are the easy way to narrow a graph: every dimension is in the dropdown and every value comes from your own spend. But rows are awkward in a script, an API call or a message to a colleague. So you can also write the same filter as one line of text in the **cost query language**.

The **Query** toggle above the filter rows switches between the two. They are two views of the same filter. Switching either way keeps exactly what you had.

![Cost graph config modal with the filter editor in Query mode, showing the text box containing provider = 'aws' AND tag['env'] != 'dev' and the Rows/Query toggle above it](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/cost-graph-query-mode.png)

### The grammar

```
query     := (nothing) | term (AND term)*
term      := dimension operator value | dimension IS [NOT] SET
dimension := provider | account | service | region | resource | tag['key'] | charge_type | commitment | virtual_tag['key']
operator  := = | != | IN | NOT IN | ~= | CONTAINS | NOT CONTAINS | STARTS WITH
value     := 'text'            for = and !=
           | ('a', 'b', …)     for IN and NOT IN
           | 'text' | ('a', 'b', …)   for ~=, CONTAINS, NOT CONTAINS and STARTS WITH
```

- Keywords (`AND`, `IN`, `NOT`, `CONTAINS`, `STARTS WITH`, `IS SET`) and dimension names are case-insensitive.
- Quote values with single or double quotes. To put a quote inside a value, double it (`'it''s'`) or use a backslash (`'it\'s'`). `\\`, `\n` and `\t` also work. Any other backslash escape is an error.
- The `tag` dimension takes its key in brackets: `tag['owner'] = 'platform'`.
- The `virtual_tag` dimension works the same way, with the key of one of your [virtual tags](./virtual-tags.md): `virtual_tag['team'] = 'payments'`.
- Kubernetes node and volume labels have shorthands: `k8s_node_label['team'] = 'payments'` means `tag['k8s_node_label:team'] = 'payments'`, and `k8s_pvc_label['…']` does the same for PersistentVolumeClaim labels. See [Kubernetes node and volume labels](./kubernetes-costs.md#node-and-volume-labels).
- An empty query means no filter, the same as no rows.

### Match text instead of exact values

`=` and `IN` match a value exactly, which is right when the value comes from the picker. But people type tag values, and the same environment shows up as `Prod_Env`, `prod-env` and `PROD ENV`. Four operators match text more loosely, and one pair checks whether a tag is there at all:

| Operator       | In the rows editor | Matches                                                                                                                                      |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `~=`           | is like            | equal once letter case, spaces, underscores and hyphens are ignored: `tag['env'] ~= 'prod-env'` matches `Prod_Env`, `PROD ENV` and `prodenv` |
| `CONTAINS`     | contains           | the value appears anywhere, ignoring letter case: `service CONTAINS 'compute'`                                                               |
| `NOT CONTAINS` | does not contain   | the value appears nowhere, ignoring letter case                                                                                              |
| `STARTS WITH`  | starts with        | the value is a prefix, ignoring letter case: `resource STARTS WITH 'arn:aws:rds'`                                                            |
| `IS SET`       | is set             | the tag or virtual tag has a value: `tag['owner'] IS SET`                                                                                    |
| `IS NOT SET`   | is not set         | the tag or virtual tag is missing or empty: `tag['owner'] IS NOT SET`                                                                        |

- The four text operators take one value or a list. A list matches when any value does (for `NOT CONTAINS`, when none does): `tag['env'] ~= ('prod', 'production')`.
- Letter case means the English letters A to Z. Accented letters and other scripts are compared as written.
- `IS SET` and `IS NOT SET` take no value and only work on `tag[…]` and `virtual_tag[…]`. A tag that is present but empty counts as not set.
- In the rows editor, a text operator swaps the value picker for a box you type into (press Enter after each value). Values from your spend are suggested as you type, and the row tells you how many of them your text matches.
- An empty text value is refused, because it would match everything. So is a `~=` value made only of spaces, underscores and hyphens. Use `IS NOT SET` for "has no value".

<insert [Cost graph filter rows with one row set to tag env "is like" Prod_Env, showing the typed value chip and the "Matches 3 known values" hint underneath] here>

### Examples

| Query                                                | Reads as                                       |
| ---------------------------------------------------- | ---------------------------------------------- |
| `provider = 'aws'`                                   | AWS only                                       |
| `region != 'us-east-1'`                              | everything except us-east-1                    |
| `service IN ('AmazonEC2', 'AmazonS3')`               | EC2 and S3                                     |
| `charge_type NOT IN ('credit', 'refund')`            | gross spend, without the things that offset it |
| `tag['env'] = 'prod'`                                | resources tagged `env=prod`                    |
| `provider = 'aws' AND tag['team'] IN ('core', 'ml')` | AWS spend owned by either of two teams         |
| `commitment != '' AND charge_type = 'usage'`         | usage covered by a commitment                  |
| `tag['env'] ~= 'prod'`                               | `prod`, `Prod` and `PROD` alike                |
| `service NOT CONTAINS 'support'`                     | everything but the support plans               |
| `tag['owner'] IS NOT SET`                            | spend nobody has tagged with an owner          |

### There is no OR

Terms are joined by `AND` only. Writing `OR` is an error, so you never get a number that answers a different question from the one you asked.

Most uses of `OR` are really a list of values for one dimension, and `IN` covers that:

```
provider = 'aws' OR provider = 'gcp'      ✗ rejected
provider IN ('aws', 'gcp')                ✓ the same question
```

Unrelated alternatives ("AWS in Europe, or GCP anywhere") need two graphs. `LIKE` patterns, regular expressions, `>` and grouped parentheses are also errors. The error message points you to `~=`, `CONTAINS` and `STARTS WITH` instead.

### When a query doesn't parse

The error tells you where it went wrong and what was expected. For a misspelled dimension, it suggests the nearest real name and lists them all:

```
$ infrawrench costs --where "provider = 'aws' AND regionn = 'us-east-1'"
--where: Unknown dimension "regionn". Did you mean "region"? Valid dimensions are
provider, account, service, region, resource, tag, charge_type, commitment.
  provider = 'aws' AND regionn = 'us-east-1'
                       ^^^^^^^
```

In the graph editor the same message appears under the text box as you type. **Save** stays disabled until the query parses, so a half-typed query is never saved by accident.

### From the CLI

```
infrawrench costs --where "provider = 'aws' AND tag['env'] != 'dev'" --last 30d --group-by service
```

A typo fails straight away, before anything is sent. `--json` shows both the text you wrote and the filter it turned into.

### From the API and the AI

`POST /costs/query` accepts the same text in an optional `query` field, instead of the structured `filters` array. See the [HTTP API](../team-and-billing/openapi.md). Sending both is an error. A query that doesn't parse returns a 400 with the position of the problem. The `query_costs` [MCP tool](./mcp.md) accepts it too.

## Saved filters

You probably rebuild the same filters ("prod only", "team platform's accounts") in lots of graphs, reports and budgets. A **saved filter** lets you build the rows once, name them, and apply the name everywhere.

Applying a saved filter links to it rather than copying it. Edit "prod only" once (say, to add a new production account) and every graph, report and budget using it changes on its next refresh.

![The cost graph editor's Filters section with a "Prod only" saved-filter chip applied above the filter rows](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/saved-filter-chip.png)

### Apply or create a saved filter

Every filter editor (the cost graph editor, the report editor and the budget scope) has an **Apply saved filter…** picker. The applied filter shows as a chip. You can still add rows underneath, and they are combined with the saved filter by AND. So "the saved prod scope, narrowed to this one service" is one chip plus one row.

To go the other way, build rows worth keeping and click **Save these rows as a filter…**. Name it, and the rows become the chip.

Manage saved filters on the **Costs** panel, in the **Saved filters** section of the **Allocation** tab. Each row shows the filter as query text. When you edit one, Infrawrench warns you by naming every graph, report and budget that uses it.

![The Costs panel's Saved filters section listing two filters with their query text, with the edit modal open showing the "Saving changes budget ..." referent warning](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/saved-filters-edit-modal.png)

### You can't delete a filter that's in use

Deleting a saved filter that a budget uses would widen that budget to _all spend_, and its alerts would be wrong. So deletion is refused while anything uses the filter. The error names every budget, report and dashboard graph that uses it, so you can detach them first. If a saved filter can't be found when a query runs, the query fails instead of running unfiltered.

### From the CLI, the API and the AI

```
infrawrench costs --filter "prod only" --last 30d --group-by service
infrawrench costs --filter "prod only" --where "provider = 'aws'"   # AND-composed
```

`--filter` takes the saved filter's name or id, and always uses its current rows. `--json` shows the id, name and the rows it used.

On the API, `POST /costs/query` takes an optional `savedFilterId` alongside `filters` or `query` (it combines with either). `/saved-cost-filters` lets you create, read, update and delete them, plus `GET /:id/referents` to see what uses one. In MCP, use the `list_saved_cost_filters` tool and the `savedFilterId` field of `query_costs`.

On your phone, graph and budget sheets show an applied saved filter read-only, with its current query text. Creating and editing saved filters is web and desktop only.

## Charge types, and cash vs amortized

A bill is not all one thing. Next to the usage you consumed, providers charge you for commitments you bought, refund you, credit you and tax you. If all of that lands in one number, a month where usage doubled can look flat because a credit absorbed it.

So every cost row has a **charge type**:

| Charge type                  | What it is                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Usage**                    | Consumption billed on demand. The default, and most of any bill.                                                             |
| **Commitment-covered usage** | Consumption a reservation, savings plan or committed-use discount covered. Still consumption, just at the commitment's rate. |
| **Commitment fee**           | Buying a commitment: a reservation's up-front payment, a savings plan, a committed-use contract.                             |
| **Commitment discount**      | The negative line where a commitment covered usage that would otherwise be on-demand.                                        |
| **Credit**                   | Promotional or negotiated credit applied against the bill.                                                                   |
| **Tax**                      | VAT, sales tax and the like, billed separately from the service.                                                             |
| **Refund**                   | Money returned for a past charge.                                                                                            |
| **Adjustment**               | A billing correction that is none of the above.                                                                              |
| **Support**                  | A support plan, usually priced off the rest of the bill rather than any one service.                                         |
| **Other**                    | A category the provider uses that doesn't match the ones above.                                                              |

Group by **Charge type** to see the split, or filter on it to answer a specific question. The most useful one is "consumption only, ignore the credits", because it tells you whether spend is really growing. Select **both** usage types for that: covered hours are consumption too, and leaving them out understates the workloads you committed to.

**Commitment-covered usage shows as zero on a cash basis.** AWS and Azure price covered hours at zero, because you paid when you bought the commitment. To see what those hours are really worth, use the **amortized** basis below. [Commitments](./commitments.md) coverage is calculated on the same basis.

Not every provider reports charge types. Where a provider doesn't, or for older data, rows are **Usage**.

### Cash, amortized and blended

**Cost basis** decides which number the graph adds up. Hover the select (or read the line under it) for a short reminder of what each one means.

- **Cash** is what the provider charged, on the day it charged it. This is your bank statement.
- **Amortized** spreads a commitment's up-front fee across the term it buys. A one-year reservation paid up front is one huge charge on the purchase day on a cash basis, and 1/365th of it on each of the 365 days on an amortized basis.

If you hold reservations, savings plans or committed-use discounts, amortized is the honest number. On a cash basis the month you sign a three-year commitment looks terrible and every month after looks oddly cheap. A cash budget will breach on the purchase and then stay quiet for three years. Amortized answers "what did July cost us?". Cash answers "what left the bank in July?". Both are real questions, just different ones.

Providers that don't report an amortized amount use their cash amount instead, so an amortized graph still covers everything. The option only appears when at least one connected account's provider reports amortized cost.

Budgets have the same setting. A budget on amortized spend keeps alerting sensibly through a commitment's term.

#### Blended

**Blended** starts from amortized, then spreads each commitment's _discount_ evenly across all the usage it could have covered. Providers apply shared commitments unevenly. AWS puts a Savings Plan on the hours with the deepest discount first, and a regional reservation on whichever matching hours ran first. A GCP committed-use discount goes to whichever projects were running when it had room. So on an amortized basis, two teams with identical workloads in the same account can pay very different rates, just by chance.

On the blended basis every eligible hour in a commitment's scope gets the same effective rate. Covered rows get more expensive and uncovered rows get cheaper, but **every day's total stays exactly the amortized total**. Only the split between teams, accounts, regions and resources changes. That makes it the fair basis for [showback](./tag-policy-and-showback.md), team budgets and [invoices](./managed-accounts.md) when commitments are bought centrally.

How each provider's discount is shared:

| Provider  | Shared across                                                                      | On-demand equivalent of covered usage                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS**   | Each day and service, since Compute Savings Plans span regions                     | Savings Plan covered usage reports its on-demand cost directly. Reservation-covered hours use Cost Explorer's reservation utilization ("on-demand cost of RI hours used") |
| **Azure** | Each day and service within the subscription                                       | Covered usage per meter, at the subscription's own on-demand rate for that meter, or the public retail price if it never ran on demand                                    |
| **GCP**   | Resource-based committed-use discounts: each day and region. Spend-based: each day | Each line's cost before credits, for every SKU that received that kind of committed-use credit that day                                                                   |

Rows outside these groups (fees, tax, credits, other services) keep their amortized amount. So does any group a provider couldn't price fully, so blended never guesses. Like amortized, **Blended** only appears when at least one connected account's provider supports it.

From the terminal:

- `infrawrench costs --basis amortized` or `--basis blended` picks the basis.
- `infrawrench costs --charge-type usage` filters by charge type (repeat the flag for more than one).
- `--group-by charge_type` prints the split.

The text output names the basis next to the total, so a copied number says what it is.

![Cost graph config modal showing the Cost basis select set to Amortized, next to the Group by select set to Charge type](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/config-amortized-charge-type.png)

![Two cost graphs side by side for the same month: one on a cash basis with a single tall commitment-fee bar, one amortized with that fee spread evenly across the days](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/cash-vs-amortized.png)

### When the number is an estimate

Some providers have no billing API. For those, Infrawrench prices your inventory against the provider's published rates. You still get a spend graph, but it's a calculation rather than an invoice, and any graph that includes such an account says so above the chart.

Expect an estimate to read low, for three reasons:

- **Anything deleted mid-period is missing.** A machine that ran for three weeks and was destroyed on the 22nd isn't there to price.
- **Every rate is list price.** Negotiated pricing, volume tiers, committed-use and sustained-use discounts aren't included.
- **Non-resource lines never appear.** Credits, tax, refunds and one-off charges are missing.

Before you reconcile a number against a bill, check the provider's page under [Plugins](../plugins/aws.md) to see whether its costs are collected or estimated.

`infrawrench costs` prints the same note above the chart and lists these accounts as `estimatedAccounts` under `--json`. In `GET /costs/status` it is the `estimated` flag on each account, next to `chargeTypes` and `amortization`.

![Dashboard showing the neutral "Spend for Hetzner is estimated" banner above a cost widget, with the explanation about list rates and deleted resources](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/hetzner-estimated-banner.png)

## Currency

Spend is shown in the currency each provider bills in, and **currencies are never merged by default**. If a graph covers a EUR account and a USD account, it draws one series per currency and the total reads `€4,100 + $9,300`. That means an org billing in two currencies can't see one "what do we spend" figure.

To fix that, go to **Settings > Currency**. Set a display currency, then state exchange rates yourself, turn on **automatic exchange rates** (the European Central Bank's daily reference rates), or both. Every cost view then converts the currencies it has a rate for.

![Settings → Currency page with a display currency of USD set and three exchange rate rows (EUR, GBP, SEK) with different effective dates](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/currency-settings.png)

### It's off until you turn it on

With no display currency set, nothing is converted. Clearing the display currency turns conversion off everywhere but keeps the rates you stated, so you can switch it back on later without retyping them.

### Where the rates come from

You choose between two sources.

**Rates you state.** Finance teams often need a converted total to match the rate their accounting system used for the period, not today's market rate. So you can state your own. Each rate has a from-currency, a to-currency, a rate, an **effective date** and, optionally, an **end date**.

- Each day's spend uses the stated rate with the latest effective date on or before that day. So restating a rate for this month doesn't rewrite months you already closed.
- An end date makes the rate a temporary override. After it, automatic rates take over if they're on. Otherwise those days are unconverted. An older stated rate never comes back after an end date.
- A date range that spans a rate change is converted day by day. The note under the figure names every rate used.
- Stated rates are used directly. A USD to EUR rate is never flipped to give EUR to USD, and two rates are never chained through a third currency.
- There is one rate per currency pair per effective date. Adding the same pair and date again replaces the rate, which is how you fix a typo. **Edit** on a row opens it in the form.
- Rates are stored exactly as you type them.

**Automatic exchange rates.** Turn these on and Infrawrench fills every day without a stated rate using the [European Central Bank's euro foreign exchange reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html). They are free and public, published around 16:00 CET on every TARGET working day for about thirty currencies, with history back to January 1999. Turning them on gives you the full history straight away.

- **Weekends and holidays** have no rate, so those days use the last published rate. The converted figure shows the publication date used.
- **Pairs without the euro** (GBP to USD, say) are calculated through EUR from the same day's rates.
- **Currencies the ECB doesn't publish** only convert when you state a rate. Otherwise they are shown unconverted. The Currency page lists the currencies the ECB covers.
- **Daily or end-of-month.** Choose whether each day converts at its own rate, or every day in a month converts at the month's last-day rate (which matches how most month-end closes book foreign costs). The current month uses the latest rate until it ends. This choice only affects automatic rates.

**A rate you state always wins.** For any day it covers, your stated rate is used. So you can leave automatic rates on and pin the months your books closed at a different rate.

The Currency page also shows the latest ECB publication and, if the last daily fetch failed, the error. A failed fetch never removes stored rates. Every converted figure names the date of the rate it used, so a stale rate is easy to spot.

<insert [Settings → Currency page with automatic exchange rates turned on, the end-of-month basis selected, the latest ECB publication date and covered currencies listed, and a stated EUR to USD rate with an end date in the table below] here>

Adding or removing a rate needs the **org settings** permission and is recorded in the [audit log](../team-and-billing/audit-log.md). Viewing the rates only needs `costs:read`, so anyone who can see a converted total can see how it was calculated.

### Upload rates from a CSV

If your finance system already produces a rate table (a month-end close per currency, say), upload it instead of typing each row. Under the rate table on the Currency page, click **Download template** for a file with the right header and an example of each row type. Then click **Upload CSV…** to upload yours.

The file needs a header row. Columns are matched by name, ignoring case, spaces and underscores, so `From Currency` and `from_currency` both work. Columns it doesn't recognise are ignored.

| Column           | Meaning                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `from`           | The currency spend is in, e.g. `EUR`.                                                            |
| `to`             | The currency to convert into, normally your display currency.                                    |
| `rate`           | Multiply an amount in `from` by this to get `to`. A comma decimal (`1,0850`) is accepted.        |
| `effective_from` | The first day the rate applies, `YYYY-MM-DD`.                                                    |
| `effective_to`   | Optional last day, `YYYY-MM-DD`. Leave it empty for open-ended.                                  |
| `billing_period` | Instead of the two dates: `YYYY-MM`, meaning exactly that month, from its first to its last day. |

Each row needs either `effective_from` or `billing_period`, not both. Comma, semicolon and tab separated files all work, up to 2,000 rows.

Nothing is saved when you pick the file. First you see a preview of every row and what it will do:

- **New**: no rate for that pair and start date yet.
- **Replaces**: a rate exists with a different value or end date (shown next to it).
- **Unchanged**.
- **Error**, with the reason and the line number. Two rows for the same pair and start date in one file make the second one an error.

Click **Import** to save the new and replaced rows together. Your other rates are left alone, so re-uploading a corrected file is safe.

If any row has an error, nothing is saved unless you tick **Skip the rows with errors**.

**Uploaded rates work exactly like rates you type.** They win over automatic rates for every day they cover. A `billing_period` row (or one with an `effective_to`) only covers its own days. After that, conversion goes back to the next stated rate, or the automatic rate if that's on. That's usually what a month-end close means, and it stops an old close rate carrying forward for months.

<insert [Settings → Currency page with an uploaded CSV previewed under the rate table: a summary line reading 12 new, 2 replace a stored rate, 0 unchanged, 1 with errors, the per-row table with one Error row naming its line, and the Skip the rows with errors checkbox next to the Import button] here>

From a terminal:

- `infrawrench currency template > rates.csv` writes the template.
- `infrawrench currency import rates.csv` shows the same preview and asks before saving. Use `-y` to skip the question and `--skip-invalid` to import only the valid rows.

Over the API, send `POST /api/org/{orgId}/currency/rates/import` with `{"csv": "...", "dryRun": true}` for the preview, then the same body without `dryRun` to save. Saving an upload needs the org settings permission and is recorded in the audit log as one `exchange_rate.import` entry with the counts and currency pairs.

### Converted numbers are always labelled

Every place that shows a converted figure labels it: the graph card's footnote, a notice above the Costs panel, the weekly digest, scheduled report deliveries, dashboard PDFs, the mobile cost cards, and `infrawrench costs` in both text and `--json` output. The label names the currencies that were converted and, for each, **where the rate came from and its date**: your stated rates with their effective dates, or the ECB rates with the range of publication dates. Hover a bar or point on a cost graph to see the rate for that bucket, its source and date. Invoice CSVs include `rate_source` and `rate_effective_from` columns for every line.

Spend already in the display currency is left as it is.

### A currency with no rate is shown, not dropped

If your data includes a currency with no rate, Infrawrench does **not** leave it out of the total, since that would understate your spend. Instead:

- It keeps its own series and its own entry in the totals, in its own currency.
- A notice names it: "Spend in SEK is not included in the USD figure."

The same goes for a currency with a rate for only part of the range. If any day has no stated or automatic rate, that currency is left unconverted for the whole range rather than half-converted. Add a stated rate covering those days, or turn on automatic rates, to include it.

<insert [Costs panel showing a converted USD total with the neutral "Amounts are converted to USD" notice listing EUR at 1.0850, and below it the amber "Spend in SEK is not included in the USD figure" notice] here>

### Budgets and currency

A budget keeps its own currency. The display currency doesn't change it, and every threshold and alert stays in the budget's currency.

What changes is which spend counts:

- If a budget's currency **is** your display currency, spend in other currencies is converted into it first, using your stated rates and automatic rates if they're on. So a USD budget in a mixed-currency org tracks all your spend.
- A budget in any other currency, or in an org with no display currency, only counts spend already in its own currency.

A currency with no rate is left out of the budget, and the alert message names it.

### Elsewhere

- **Showback** converts each cost centre at the rate in force on the last day of the period, so "August, at the August rate" is something finance can reproduce.
- **The weekly digest** uses the display currency and adds the same note under the spend figure.
- **Invoices** for [managed accounts](./managed-accounts.md) convert at the rate in force on the period's last day, and lock the rate and its source when approved.
- **The CLI**: `infrawrench costs --currency USD` converts. The conversion note prints above the chart in text mode and is included in `--json`, along with any currencies that couldn't be converted. `infrawrench currency` prints your settings, the ECB feed status and your stated rates. `infrawrench currency rate EUR 2026-09-30` tells you which rate a day uses and why. `infrawrench currency feed` lists the ECB rates for a day.
- **MCP and the AI chat** have `get_currency_settings` and `lookup_exchange_rate`, and quote a converted figure's rate source and date.
- **Terraform**: `infrawrench_currency_settings` takes `auto_rates` and `rate_basis`, and `infrawrench_exchange_rate` takes `effective_to`. See [Terraform provider](./terraform-provider.md).
- **Mobile** shows converted totals with their note, including the rate source. Currency settings and rates can only be edited on web and desktop.

## Budgets & alerts

A budget is an amount tracked against a scope (all spend, or a slice: one provider, one account, a tag) for each period. By default it tracks monthly spend. A budget can also [track a usage quantity](#usage-budgets), use a [custom period](#budget-periods), and [roll up child budgets](#budget-hierarchies).

Create one from the **Costs** panel, or from a dashboard's **+** tile > **New budget**. A budget also has a [cost basis](#cash-amortized-and-blended). Leave it on cash to track what you're charged, or switch to amortized so a commitment purchase doesn't blow the budget in the month you sign it.

Each budget has one or more thresholds:

- **Actual** thresholds fire when spend (or usage) so far this period crosses a percentage of the budget.
- **Forecast** thresholds fire when the projected end-of-period total crosses it. This is your early warning while there's still time to react.

Each threshold fires at most once per period (per calendar month for a monthly budget). Alerts show up:

- as a badge on the budget card
- as a [mobile push notification](./mobile-push-notifications.md) to org members who have the app and budget alerts turned on in their notification preferences for the org
- in any [Slack](./slack-alerts.md) or [Microsoft Teams](./teams-alerts.md) channel set up for budget alerts
- as an SMS to your on-call recipients, if your org has Twilio set up on the **Settings > Notifications** page
- by email to anyone in the budget's **Email recipients** field (members or approved addresses). See [email alerts](./email-alerts.md).

![Budget card showing a progress bar at 72% with threshold ticks, a forecast marker, and an alert badge](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/budget-card.png)

### Usage budgets

Set a budget's **Measure** to **Usage quantity** to limit a quantity instead of money: tokens, GB, instance-hours, requests, credits, whatever your providers report. Pick the unit from the units in your cost data. Units are matched exactly and never converted (`GB` and `GB-Mo` are different). Thresholds and forecasts work the same way, in that unit. The card, the alert and the CLI all show the quantity with its unit.

Usage quantities come from providers that report them (OpenRouter requests, Cloudflare consumed units, Hetzner, ElevenLabs and Cartesia credits, Speechmatics hours, among others) and from [cost rows you push](./server-push.md) with `usageAmount` and `usageUnit`. Usage budgets don't support scenario models or billing rules, since both adjust money.

<insert [The budget editor with Measure set to Usage quantity, the usage unit picker open listing tokens, Requests and GB, and an amount per period filled in] here>

### Budget periods

The **Period** control sets which days a budget counts:

- **Calendar month** (the default): the 1st to the last day of each month, UTC.
- **Custom cadence**: every N days, weeks, months, quarters or years from a start date. For example, a fortnight starting on a sprint's first Monday. Each period starts where the last one ended. Days before the start date aren't counted.
- **Explicit periods**: a list of date ranges, each with its own amount. Use this for a launch quarter or a fiscal calendar that doesn't line up with months. Days outside every period aren't counted, and the card says when the next period starts.

The forecast projects to the end of the current period, whatever its length.

### Budget hierarchies

Pick a **Parent budget** to nest a budget under another. A parent's actual and forecast are the **sum of its children's**, each measured over the parent's own period. So a yearly parent over monthly team budgets still adds up a full year. While a parent has children, its own scope is ignored.

- Parent and children must track the same thing (one currency, or one usage unit).
- Hierarchies go up to four levels deep.
- Deleting a budget moves its children up to its own parent.

The Costs panel shows budgets as an expandable tree, each level with its own actual and forecast against its own amount. A parent warns you when its children outgrow it: when their amounts for the same period add up to more than the parent's, when together they've already passed it, or when they're forecast to. Parent thresholds alert on the rolled-up figures like any other budget, and the alert says it's a sum of child budgets. A dashboard card for a parent lists its children, collapsed.

<insert [The Costs panel budget tree with a parent budget expanded to show two child budgets, the parent showing the "Child budgets allocate ..." warning] here>

### Explain a budget alert

Whoever reads a budget alert usually knows why it fired within minutes ("the Q3 load test, ends Friday"). Write it down where everyone will see it. Each threshold that fired this month is listed on the budget card in the **Costs** panel, with **Explain** next to it. Your note is:

- **Saved on the alert**, with your name and the time, and shown on the budget card on web, desktop and the [mobile app](./mobile-app.md).
- **Shown on every cost chart** as an org-wide [annotation](./cost-reports.md#annotations) on the day the alert fired, marked **Explains a budget alert**. So the jump in the graph still makes sense months later.
- **Posted after the alert**: as a reply in the Slack thread of each alert message, and as a follow-up card to the Teams webhooks it reached (Teams webhooks can't reply in a thread). The composer tells you how many it reached. Budget alerts aren't sent by email, so there is no email follow-up. Alerts that fired before notes existed, or that [quiet hours](./alert-routing.md#quiet-hours) held and delivered later, only get the note on the budget and the charts.

**Edit note** rewrites the note and updates the same chart marker. Deleting the marker from a chart keeps the note on the alert. A note doesn't silence the budget: later thresholds still fire. Writing a note needs `costs:write` and is recorded in the [audit log](../team-and-billing/audit-log.md) as `budget_alert.note`.

<insert [Costs panel budget card with two fired thresholds this month, one showing a note with its author and date, the other with an Explain link; the Explain this alert dialog open beside it] here>

From the terminal:

- `infrawrench budgets` lists every budget with how many of this month's alerts are still unexplained.
- `infrawrench budgets "Prod"` shows one budget's alert history with each note.
- `infrawrench budgets annotate "Prod" --note "Q3 load test, ends Friday"` explains the latest alert. Use `--event <id>` to pick another.

All three take `--json`. In chat and MCP the tool is `annotate_budget_alert`, and event ids come from `get_budget`.

### File a budget alert as an issue

When an overspend needs someone to act on it, file it as an issue. With [Jira](./jira.md), [Linear](./linear.md) or [GitHub issues](./github-issues.md) connected, each threshold that fired this month has **File an issue** next to **Explain** on the budget card (or **File in Jira**, **File in Linear**, **File in GitHub** when only one is connected). This works on the Costs panel and on dashboards.

The issue opens prefilled with everything the reader needs: the budget, the period, which threshold fired (actual or forecast) and when, spend so far against the limit, the forecast for the period, the budget's scope, whether billing rules apply, and any note already written. You pick the project, team or repository the same way as for any other finding.

Once filed, the alert shows the issue key and its [live status](./jira.md#live-status), so the next person to look at the budget can see who's working on it. The mobile app shows the same issue and status on the budget card. A [routing rule](./alert-routing.md) with the GitHub issues destination can also file budget alerts automatically, one issue per alert. Private budgets are never filed automatically, since their spend would end up in a repository the whole team can read.

<insert [Costs panel budget card with a fired "Actual 100% on Oct 14" threshold showing a filed Jira key OPS-418 with a blue "In Progress" status, next to the Explain link] here>

Budgets alert on totals you choose. For spend you didn't see coming (a provider or service suddenly billing far above normal, or one that never billed before), see [cost anomaly alerts](./cost-anomaly-alerts.md). They work with no setup and can be [tuned](./cost-anomaly-alerts.md#tuning-detection) if they're too loud or too quiet. Anomalies can text the same on-call recipients as budgets, but [only once you turn that on](./cost-anomaly-alerts.md#paging-by-sms).

## The Costs panel

Click **Costs** in the sidebar to open the Costs panel. It is split into tabs and remembers the one you used last. The first tab, **Overview**, shows this month's spend for the whole org, broken down by provider, account or service, followed by all your budgets.

| Tab                       | What is on it                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**              | This month, and Budgets.                                                                                                                                                                                                                   |
| **Alerts**                | Recently detected [anomalies](./cost-anomaly-alerts.md), [change alerts](./cost-change-alerts.md), and [commitment and unit-cost alerts](./commitment-and-unit-cost-alerts.md).                                                            |
| **Savings**               | [Potential savings](./orphan-finder.md), [Oversized](./right-sizing.md), [Extended support](./extended-support.md), [Seats](./saas-seats.md), [Sleep schedules](./sleep-schedules.md), and [Realized savings](./realized-savings.md) last. |
| **Commitments & credits** | [Credit burndown](./credit-burndown.md) and [Commitments](./commitments.md).                                                                                                                                                               |
| **Network**               | [Network costs](./network-costs.md) and [Kubernetes network costs](./kubernetes-costs.md).                                                                                                                                                 |
| **Carbon**                | [Estimated carbon](./carbon.md). Shown only where the app supports it.                                                                                                                                                                     |
| **Allocation**            | [Unit costs](./unit-costs.md), Saved filters, [Scenario models](./scenario-models.md), and Tags & allocation ([tag compliance, untagged spend, and showback](./tag-policy-and-showback.md)).                                               |

The mobile app has the same tabs except Network. Its **Commitments** tab has no credit burndown.

A budget belongs to the org, not to a dashboard. It keeps tracking and alerting whether or not any dashboard shows it, and the panel is the one place you can always find it. Each row says which dashboards show a card for it, or **On no dashboard** if none do.

From a budget's row you can:

- **Edit** it: amount, scope filters and thresholds.
- **Dashboards**: add or remove its cards, one per dashboard.
- **Delete** it: the budget stops tracking and alerting, and its cards are removed from every dashboard.

### Cards vs the budget itself

| You do this                            | What happens                                                            |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Remove a budget card from a dashboard  | The card goes. The budget stays, keeps tracking, keeps alerting.        |
| Delete the budget from the Costs panel | The budget goes, alerts stop, and every card pointing at it is removed. |

Removing a card only changes what you see. Deleting a budget is the real change.

### Show an existing budget on a dashboard

A dashboard's **+** tile has two options:

- **New budget** creates a budget and adds a card for it to this dashboard.
- **Existing budget** picks one you already have. Budgets already on this dashboard aren't listed.

The same budget can appear on as many dashboards as you like. [Cost reports](./cost-reports.md) work the same way for graphs.

![Costs panel showing the month-to-date spend chart at the top and two budget cards below, one labelled "On no dashboard"](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/costs-panel-overview.png)

### Unit costs

On the **Allocation** tab, **Unit costs** lists your org's business metrics (what a cost graph can divide by) and how many days each one has values for. A metric with no values would make a chart full of gaps, so it's flagged in amber here. See [Unit costs & margin](./unit-costs.md).

### Potential savings

**Potential savings** lists resources that look orphaned or idle, such as volumes attached to nothing or IPs assigned to nothing. Where the provider reports cost per resource, it shows the last 30 days of spend. It uses the state your accounts last synced, so it makes no provider API calls. It also appears in local-only desktop mode, scanning this machine's workspace, without a cost column. See [Orphan & idle resource finder](./orphan-finder.md) for what each provider flags.

### Oversized

**Oversized** finds machines doing real work on more hardware than they use. Infrawrench looks at each machine's p95 CPU and memory over the last 14 days. Where usage sits well under the size, it recommends the provider's cheapest smaller size that still leaves headroom, with a live-priced monthly saving and one-click apply. See [Right-sizing](./right-sizing.md).

### Sleep schedules

**Sleep schedules** manages your off and on windows. For example, stop a staging VM at 19:00 and start it at 08:00, Monday to Friday, with the projected monthly saving based on its recent spend. Create schedules from an eligible resource's Schedule tab. This section lists them all with the next change, the last run's result, and pause, edit and delete. See [Sleep/wake schedules](./sleep-schedules.md).

## On your phone

Cost graphs and budgets work in the [mobile app](./mobile-app.md) too, with the same data, series colors, thresholds and forecast marker. The **Costs** tab mirrors the panel: this month's spend and every budget in the org, so a budget push notification always has somewhere to open even if no dashboard shows that budget. Cost cards also appear on any dashboard that has them.

You can create and edit on your phone too. **Edit** on a dashboard offers the same **Add a card** choices and the same graph and budget editors, using chips instead of dropdowns. Only a custom date range on a cost graph is web and desktop only.

## Ask the AI instead

The same cost data is available in the [MCP server](./mcp.md) and the [AI chat](./ai-chat.md) through `query_costs`, `list_cost_dimension_values`, `get_cost_status` and the budget tools. So you can ask "what did we spend on AWS last month, grouped by service?" from Claude Desktop or the in-app chat without building a graph first. Cost and budget tools respect the caller's `costs:read` / `budgets:*` [role permissions](../team-and-billing/roles-and-permissions.md).

## Where the data comes from

Each provider that supports cost reporting fetches spend from its own billing API, once a day per account. (Billing APIs are rate-limited, and some, like AWS Cost Explorer, charge per request.) When you first connect an account, Infrawrench fetches up to a year of history in the background. The graph shows "Backfilling…" until it's done. Recent days are fetched again each time, so late usage and credits from the provider are picked up.

If a provider is set up correctly but has nothing to report yet (say, a billing export switched on an hour ago), Infrawrench keeps trying to fetch the full history until real data arrives.

Some providers only publish monthly invoice totals, not daily costs. Their spend shows on period boundaries, so daily graphs show it as monthly steps. The graph notes this when such a provider is included.

### Add spend from somewhere else

For anything without a provider plugin (a SaaS invoice, an internal chargeback, a colo bill), you can report the numbers yourself. They show up in graphs, filters and budgets like any other spend. There are two ways:

- A [workflow](./workflows.md#reporting-your-own-cost-data) calling `infra.costs.write(...)`, when Infrawrench can reach the numbers. These show **Workflow** as their provider. Unless the workflow assigns them to one of your accounts, they appear in the account dimension as "&lt;workflow name&gt; (workflow)".
- Your own server [pushing rows over the API](./server-push.md#cost-rows) to `POST /costs/rows`, when it can't. These show **External** as their provider and appear as "&lt;source&gt; (external)".

Either way, reporting a day again replaces it rather than adding to it, and neither can overwrite data collected from a provider.

## When collection fails

If cost collection keeps failing for an account (often because the provider needs some setup), you won't just see an empty graph. A banner appears above the cost widgets on the dashboard, on web, desktop and mobile:

![Dashboard with an amber "Cost collection is failing for Infrawrench GCP" banner above the cost widgets, showing the billing-export message and its link](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/gcp-failing-banner.png)

When Infrawrench can tell what's missing, the banner links straight to the provider page that fixes it, for example GCP's Cloud Billing export settings for the account's project. Fix the cause and the next collection fills in the missed days. The banner clears itself after the first success.

`infrawrench costs` prints the same warnings above the chart and includes them as `collectionFailures` under `--json`. The `get_cost_status` MCP tool and `GET /costs/status` return the failure as `costPollError` with an optional `helpLink`.

## When there's no data yet

Sometimes collection works but finds nothing. This is normal for a newly set up provider. For example, GCP's Cloud Billing export to BigQuery creates its table straight away but can take a day or two to write the first rows.

In that case the account gets a calmer banner instead of a blank graph:

![Dashboard showing the neutral "No spend data yet for Infrawrench GCP" banner above an empty cost widget](https://agent-assets.infrawrench.com/docs-screenshots/features/cloud-costs/gcp-empty-banner.png)

It clears as soon as the first data arrives. If it's still there after a couple of days, the export is usually set up but not delivering. Check it at the provider.

`infrawrench costs` lists these accounts above the chart too, and includes them as `awaitingData` under `--json`. In `GET /costs/status`, the account has no `costPollError` and a null `coverage`.

See each provider's page under [Plugins](../plugins/aws.md) for what its cost integration needs (extra IAM permissions, token scopes) and any caveats, such as list-price-only figures.

Kubernetes clusters have no billing API, so their per-namespace and per-workload costs are calculated from node prices. See [Kubernetes cost allocation](./kubernetes-costs.md).

## Forecasts are trend estimates

Forecasts are a least-squares fit over the last 30 days of daily totals, projected forward. They show the trend, not a billing prediction. One-off purchases, reserved-instance charges and tier changes won't be anticipated.

Every forecast shows a shaded **range** around its dashed line: the 80% prediction interval. It gets wider when recent spend is noisy and further into the future. Budgets show the same range next to their projected figure. See [Cost forecasts](./cost-forecasts.md) for how it's calculated, and for named forecasts on a cost report.

For known future costs a trend can't see, use a **scenario model**. You write them down once, and they're shown beside the trend rather than replacing it. See [Scenario models](./scenario-models.md).

The forecast follows the graph's [cost basis](#cash-amortized-and-blended). This matters: a trend through a cash series with one huge commitment purchase projects a month-end total that can't happen. On an amortized basis that purchase is already spread out, so the forecast follows your real usage.

## Tags you define yourself

When provider tags are messy or missing, a **virtual tag** gives you the dimension you want to report on. Merge `env`, `Environment` and `ENV` into one key, assign values with any cost filter, or split a shared cost across teams by percentage or by a business metric. Group by **Virtual tag** in any graph or report, or filter on one in a budget, saved filter, change alert, allocation rule or export. See [Virtual tags](./virtual-tags.md).

## What you report internally

Collected spend is what the provider charged. What you report internally is often different: a platform team's markup to cover shared overhead, a discount negotiated outside the provider's pricing, or a shared cluster charged back to the teams that use it.

**Billing rules** handle this. They're applied when a report runs, not written into your cost data, so collected spend still matches the invoice. The adjusted figure is always shown next to the collected one and names the rules that changed it. See [Billing rules](./billing-rules.md).

Budgets, anomaly detection, change alerts, the digest and cost exports all keep using collected spend. Each budget can opt in to billing rules. The billing rules page lists the details.

## What you bill somebody else

If you run infrastructure for other people, you can invoice them. A **managed account** is a customer: contact details, a billing currency, and the cost centres whose spend is theirs. An **invoice** is what you send them: line items from the same allocation the showback report uses, with adjustments applied, and a total that locks when you approve it. See [Managed accounts & invoices](./managed-accounts.md).

## Prepaid credit

For providers that work off a prepaid balance rather than an invoice, the more urgent question is "how long until it runs out?". See [credit burndown](./credit-burndown.md), on the Costs panel's **Commitments & credits** tab.

## Commitments

To see whether the reservations and savings plans you bought are paying for themselves, see [Commitments](./commitments.md). It shows your holdings, how much of your usage they cover, their utilization, and a planner that sizes what to buy next. It's also on the **Commitments & credits** tab.

## What your savings actually saved

The finders on the **Savings** tab show what you could save. **Realized savings**, the last section on that tab, shows what your actions did save: each resize, orphan cleanup, sleep schedule, commitment discount and logged saving, measured against the resource's own spend before the change and shown next to its projection, with shortfalls flagged. See [Realized savings](./realized-savings.md).

## Where the egress went

A spend graph can tell you `AWSDataTransfer` cost $4,100. It can't tell you which two services were talking, because a network charge is about a **pair** of endpoints. See [Network costs](./network-costs.md) for priced source to destination breakdowns from your VPC flow logs, on the Costs panel's **Network** tab.

Those figures are estimates and are kept separate from collected spend, so the same traffic isn't counted twice.

## Who spent it on AI

A provider bill shows what each model cost, not which team or feature sent the requests. See [AI spend by caller](./ai-attribution.md). Request logs from Bedrock, a Cloudflare AI Gateway, a LiteLLM proxy or your own JSONL files split each billed AI line by caller. Anything that can't be matched is labelled `(unattributed)`, and billed totals don't change. Caller dimensions show up here as the tag keys `caller:<dimension>`, and AI provider lines carry `ai:provider`, `ai:model` and `ai:token_type` tags you can group by today.

## Manage budgets and cost settings in Terraform

Everything on this page that is configuration rather than data can be managed from Terraform instead of the UI, one object at a time, with plans and `terraform import`. That includes budgets, saved filters, cost centres and their allocation rules, [reports](./cost-reports.md), [change alerts](./cost-change-alerts.md), [scenario models](./scenario-models.md), [billing rules](./billing-rules.md) and [exports](./cost-exports.md). See the [Terraform provider](./terraform-provider.md).

This is different from [Terraform export](./terraform-export.md), which writes your _cloud resources_ out as HCL, and from [config as code](./config-as-code.md), which moves a whole org's configuration as one document.
