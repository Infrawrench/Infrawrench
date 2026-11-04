---
title: Billing rules
description: Apply markups, discounts, fixed charges and reallocations to your cloud spend in reports, with the collected figure always shown beside the adjusted one.
sidebar_order: 10
---

Collected spend is what your provider charged you. The number your organization reports internally is often different. A platform team adds a markup to cover shared overhead. A discount was negotiated outside the provider's pricing. A credit is split across teams. A shared Kubernetes cluster is charged back to the products that run on it.

Billing rules let you record those adjustments in Infrawrench, so you don't need a spreadsheet on the side.

## Collected and adjusted spend

You always have two numbers, and both stay visible.

|                     | What it is                                                                        | Where it comes from                     |
| ------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| **Collected spend** | What the provider billed. Reconciles against the invoice, line for line.          | Collected daily from the billing API.   |
| **Adjusted spend**  | What your organization charges itself. Markups, discounts, reallocations applied. | Computed from your rules, at read time. |

**Rules never change your cost data.** They are applied when a report runs. Collected spend always stays exactly what the provider reported, so it remains your audit trail. Editing, disabling or deleting a rule only changes what the next report shows. You never need to backfill anything.

**Adjusted spend is always shown with collected spend.** Every adjusted figure comes with the collected total and the names of the rules that changed it. A chart showing adjusted spend has an **Adjusted** badge next to its total and a caption with the collected figure and each rule in force. That way any number can still be checked against a bill.

![A cost graph with an "Adjusted" badge beside the total and the amber caption underneath reading "Billing rules applied, collected spend $84,120. In force: Platform overhead (+15% on tag team=platform)."](https://agent-assets.infrawrench.com/docs-screenshots/features/billing-rules/adjusted-cost-graph.png)

## How a rule works

A rule **matches** spend and then **adjusts** it.

You match spend with the same fields [allocation rules](./tag-policy-and-showback.md) use: tag key and value, account, provider and service. You can also match on **charge type**, so an overhead markup can apply to usage without also marking up credits, refunds and reservation purchases. Every field you set must match. A rule with no fields set matches all spend.

Three kinds of adjustment apply everywhere adjusted spend is shown. Two more only price [managed-account invoices](./managed-accounts.md) (see [Rules that price customer invoices](#rules-that-price-customer-invoices)).

### Markup or discount

A signed percentage. `+15` marks matched spend up by 15%. `-10` discounts it by 10%. Use it to recover shared overhead, to reflect a negotiated rate, or to add an internal cost-of-capital loading.

### Fixed amount

A flat amount per day or per month, such as "the platform team charges $5,000 a month". It isn't multiplied by anything and can't be reallocated. Over a range shorter than a full period it is **pro-rated**: a $3,000/month charge shown across ten days of a thirty-day September contributes $1,000.

### Reallocation

Moves matched spend onto a different **cost centre** or **account**. Use it to charge back shared infrastructure, for example "everything on the shared EKS cluster is billed to the Data cost centre". A reallocation never changes the total. It only changes who the money belongs to.

## Rule order

When several rules match the same spend, they run in order of **ascending priority, then creation time**. Each kind behaves a little differently:

- **Every matching markup or discount applies, and they compound.** Two 10% markups give **21%**, not 20%. Order doesn't change the result.
- **Only the first matching reallocation applies.** Spend moves at most once, so **the total after reallocation always equals the total before.**
- **Fixed amounts stand on their own.** They are pro-rated over the period and reported as a separate figure.

To change the order, use the up and down arrows on a rule in **Settings > Billing Rules**. The new order is saved in one step, with one audit entry.

## Rules that price customer invoices

If you bill customers through [managed accounts](./managed-accounts.md), you get two more kinds of rule. They apply **only when a customer's invoice is computed**. They never change the Costs panel, budgets, showback or anything else about your own organization, and the "adjusted" caption on a graph never lists them. You can limit each one to particular customers. With no customers ticked, it applies to every customer whose billing rules are on.

### Tiered rate

A markup or discount in tiers on a customer's monthly spend, for example **+8% up to 10,000, +5% to 50,000, +3% above**. Thresholds are set in one currency. Spend in other currencies isn't tiered, and the invoice says so.

- **Marginal** (the default): each slice of the month's spend is charged at its own tier's rate, like income tax. At 60,000 that is 8% of the first 10,000, 5% of the next 40,000 and 3% of the last 10,000. Crossing a threshold never makes earlier spend more expensive.
- **Whole volume**: the whole month is charged at the rate of the tier the total falls in. Easier to quote, but with a jump at every threshold. A tier's upper bound is exclusive, so exactly 10,000 falls in the second tier.

You can measure volume over the customer's **overall** matched spend or **per service**. The amount a tier adds is spread across the lines that made up the volume, in proportion to their cost, so every invoice line carries its share.

### Custom expression

A short formula that sets a line's new cost:

```
if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1
```

This is not SQL or code. It is checked when you save it, against a fixed list of fields and functions, and nothing you type is run by a database or script engine. If there's a mistake, the editor shows you where as you type, and the API returns a 400 pointing at the character.

| Fields                                                                                | What they are                                                                                                          |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cost`                                                                                | The line's amount so far, after every earlier rule                                                                     |
| `collected`                                                                           | What the provider charged for the line, before any rule                                                                |
| `list_cost`, `has_list_price`                                                         | The provider's public on-demand price for the line when it reports one; `list_cost` falls back to the collected amount |
| `usage`, `unit`                                                                       | The usage quantity and its unit                                                                                        |
| `service`, `provider`, `account`, `account_name`, `region`, `charge_type`, `currency` | Where the line came from                                                                                               |
| `month`                                                                               | The calendar month, `YYYY-MM`                                                                                          |
| `customer`                                                                            | The customer being invoiced                                                                                            |
| `tag.env`, `tag["cost-centre"]`                                                       | A tag's value, or empty when the line does not carry it                                                                |

Operators are `+ - * /`, `== != < <= > >=`, `and or not`, and `in ["a", "b"]`. Functions are `min`, `max`, `abs`, `round(x, places)`, `contains`, `starts_with`, `ends_with`, `lower` and `has_tag("key")`. Use `if … then … else …` to choose between values. At the top level you can leave out the `else`, and lines that don't match keep their cost.

A line is one calendar month of one service in one account, region and charge type. If an expression can't price a line (a division by zero, for example), that line keeps its previous cost, and the invoice and preview tell you how many lines failed and why. A line never silently becomes zero.

The editor's **Insert** pickers add real service, provider, account and tag names, so you don't need to know what a provider calls its services.

### The order on an invoice

Every invoice line goes through these steps in order, and each step records what it changed:

1. The customer's [re-rating to public pricing](./managed-accounts.md#re-rating-to-public-pricing), if on.
2. The customer's [discount treatment](./managed-accounts.md#discounts-credits-and-commitment-benefits).
3. Markups and discounts, tiered rules and expressions, **in rule order**. Markups still compound. An expression sees the running `cost` at its position. A tiered rule measures the running cost of the lines it matches.

Reallocation decides which customer a line belongs to before any of this, and fixed amounts are still their own invoice lines.

<insert [Settings → Billing Rules with the editor open on a Custom expression rule: the expression box, the green "The expression is valid" note, the Insert pickers, the customer checkboxes, and a preview underneath showing Without/With totals for last month] here>

### Preview a rule

Click **Preview** in the editor to price last month (or any month) twice, without the rule and with it. You see both totals, each rule's effect in order, any expression failures and the lines that moved most. Pick a customer to preview against their invoice, or leave it on the whole organisation. Nothing is saved.

To change an existing rule, click **Edit**. The whole rule is saved as one audited change.

## Manage your rules

Rules live in **Settings > Billing Rules**.

- Anyone with `costs:read` can see them, so everyone reading an adjusted number can see why it was adjusted.
- Creating, editing and deleting them needs **`org:settings:write`**, not `costs:write`. A billing rule changes every internal figure your organization reports, including opted-in budgets and chargeback statements, so it sits behind the same permission as [setting an exchange rate](./cloud-costs.md#currency) or [creating a cost export](./cost-exports.md).
- Every create, edit and delete is [audit-logged](../team-and-billing/audit-log.md).

![The Settings → Billing Rules page showing three rules: a +15% platform overhead markup, a disabled -8% discount, and a reallocation moving AmazonEKS spend to the Data cost centre, with the priority number and one-line summary on each row](https://agent-assets.infrawrench.com/docs-screenshots/features/billing-rules/settings-rules-list.png)

You can switch a rule off instead of deleting it. That way a markup paused for a quarter keeps the exact wording finance agreed to when you switch it back on.

## See adjusted numbers

Adjusted spend only shows when you ask for it. Once your organization has a rule in force, the **Costs** panel shows an **Apply billing rules** checkbox above the month-to-date chart. Tick it and the chart redraws with the badge and caption described above.

Cost graphs on dashboards and in saved [cost reports](./cost-reports.md) work the same way. Turn on the graph editor's `adjusted` option and the card shows adjusted spend and labels itself, so a screenshot still carries both figures.

## Where billing rules apply

The general rule: **anything that alerts a person uses collected spend unless you opt in.**

### Budgets: opt in per budget

A budget measures **collected spend** by default. Adding a markup won't suddenly trigger budget alerts for money nobody actually spent.

You can opt a budget in (`useAdjustedSpend`) so it measures the internal figure. Unlike a [scenario model](./scenario-models.md), which only affects the forecast, this applies to **actual thresholds too**, so month-to-date and forecast are measured the same way.

An alert from an opted-in budget says so in its message and includes the collected figure.

### Showback: opt in per request

[Showback](./tag-policy-and-showback.md) is the one report where **fixed-amount** rules are fully attributed. The pro-rated amount is added to the cost centre the rule names, which gives you the "platform team charges $5,000/month to Engineering" line. A fixed rule that names an account, or names nothing, lands in **Unallocated**.

Adjustments are off by default here too, so a chargeback statement never shows marked-up numbers unless you ask.

### Cost exports: always collected

[Cost exports](./cost-exports.md) contain your collected rows and are never adjusted, so they always match your invoices. If you need adjusted figures downstream, apply your rules there.

### Unit costs, anomalies, change alerts and the weekly digest: always collected

[Unit costs](./unit-costs.md) divide collected spend by a business metric, so a markup can't make your unit economics look worse.

[Cost anomaly alerts](./cost-anomaly-alerts.md) and [cost change alerts](./cost-change-alerts.md) always watch collected spend, so changing a rule never triggers them. The [weekly digest](./cloud-costs.md) reports collected spend too.

### Commitments: never adjusted

[Commitment coverage and utilization](./commitments.md) are based on provider-reported amounts. Billing rules don't affect them.

### Totals on cost graphs

On a cost graph, the **total is always the sum of the series drawn**. Fixed-amount charges have no series, so they are reported separately (`adjustment.fixedTotals`), and the caption says the internal figure is the total plus that amount. On a showback report, fixed amounts are attributed to a centre as described above, so a centre's total already includes them.

## From the terminal

```
infrawrench billing-rules
infrawrench billing-rules "Platform overhead"
infrawrench billing-rules --json
```

This lists your rules in the order they apply, with a one-line summary of what each does to which spend. It also reminds you that collected spend is never changed, and that markups compound while a reallocation applies once. The command is read-only. Create and edit rules in Settings.

```
infrawrench billing-rules preview "Volume tiers" --customer northwind --month 2026-09
infrawrench billing-rules preview "Prod EC2 surcharge" --json
```

`preview` is a dry run of one saved rule against a month of real spend. It shows totals without and with the rule, and the lines it moved.

See the [CLI reference](./cli.md).

## From AI chat and MCP

The [MCP server and AI chat](./mcp.md) offer `list_billing_rules` and `preview_billing_rule` (a dry run of a rule or a customer's pricing against a month of spend). `query_costs` and `query_showback` both take `adjusted`. The assistant quotes collected spend unless you ask for the internal figure, and gives both when it reports an adjusted one.

If a total doesn't match an invoice, ask for `list_billing_rules`. Each rule says what it does to which spend.

## API

- `GET /billing-rules`: the rules in the order they apply (`costs:read`)
- `POST /billing-rules`, `PUT /billing-rules/{id}`, `DELETE /billing-rules/{id}`, `POST /billing-rules/reorder` (`org:settings:write`)
- `POST /billing-rules/preview` (`costs:read`, plus `invoices:read` when it names a customer)
- `POST /costs/query` with `adjusted: true`, and `GET /costs/showback?adjusted=true`

See the [OpenAPI reference](../team-and-billing/openapi.md).
