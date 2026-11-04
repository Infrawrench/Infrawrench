---
title: Scenario models
description: Add known future cost, like a purchase, a new team or a migration, on top of a cost forecast, without changing the trend or your recorded spend.
sidebar_order: 9
---

A cost forecast is a **trend**. It extends what already happened, so it can't know about a purchase nobody has made yet, a reserved-instance charge landing next quarter, a team that starts in September, or a tier change that cuts the run rate by a fifth.

A scenario model fills that gap. It's the **known future cost** your team already expects, written down once and shown on top of the forecast.

The two answer different questions and are never merged into one number:

|                    | Answers                                     |
| ------------------ | ------------------------------------------- |
| **Trend forecast** | "If nothing changes, what does this cost?"  |
| **Scenario model** | "Here is what we already know is changing." |

When you apply a scenario, the chart draws **both** lines. The trend stays where it was, and the adjusted line sits beside it under the model's name. Every place that shows a scenario says which model is applied and what it added.

<insert [A cost graph with a solid actuals area, a dashed blue trend forecast, and a dotted amber scenario line diverging from it, with the amber "Projection includes scenario" caption visible under the title] here>

## What goes in a model

A model has a name, one currency, and a list of adjustments. Each adjustment is one of three kinds:

| Kind                    | What it says                                                      | Example                                                                             |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **One-off amount**      | A single charge on a single day                                   | An annual licence renewal on 12 September; a three-year reservation bought up front |
| **Recurring amount**    | The same amount every day or month from a date, optionally ending | A new team's fixed $8,000/month from October; a pilot that stops in November        |
| **Step change in rate** | ±X% of the trend from a date, optionally ending                   | A migration that takes 20% off compute; a pricing tier that adds 8%                 |

Amounts can be **negative**. "We're turning off the old cluster in November" is known future cost too.

### Scope an adjustment

Any adjustment can have a **scope**, using the same filters as cost graphs (provider, account, service, region, resource, tag, charge type, commitment). An empty scope means your whole organization.

Scope works a little differently for each kind:

- For a **step change in rate**, the scope is what the percentage applies to. `−20%` scoped to `provider = 'aws'` takes a fifth off the AWS trend and leaves everything else alone.
- For an **amount**, the scope decides whether it belongs on a given chart. A $40,000 GCP commitment won't show on a chart filtered to AWS. When a chart's filters exclude an amount, it's left out and the card names it, so you know it wasn't counted.

### Use one currency per model

Every amount in a model must be in the model's currency. A model mixing EUR and USD is refused when you save it.

If you apply the model to a chart in a different currency, Infrawrench converts the amounts using **your organization's own exchange rates** and says so on the card. If there's no rate for that pair, you get an error instead of a wrong line. Percentages have no currency, so a model of only rate changes works on any chart.

## What you can rely on

**A scenario never changes recorded spend.** Adjustments only apply to days after the last day with collected spend. You can date an adjustment in the past (a recurring cost that started in June, say). It just adds nothing to days that already have real spend. Your actuals are always what your providers billed.

**The trend stays visible.** The plain forecast and the adjusted projection are always shown together.

**Scenarios are always labelled.** The chart names the model in its legend, its tooltip, and a caption under the title that also says how much the scenario added over the forecast period. On mobile the same caption appears on the card. The `infrawrench` CLI always prints the trend total above the adjusted one.

## How overlapping adjustments add up

For each forecast day:

1. **Rate changes apply first**, each against the plain trend for its own scope.
2. **Amounts are added after that**, on top of the re-rated trend.
3. The result never goes below zero.

What that means in practice:

- **Rate changes never discount your amounts.** A $50,000 purchase alongside a −20% rate change shows as $50,000, not $40,000.
- **Rate changes add together, in any order.** `+10%` and `−20%` together is `−10%` (not `×1.1 × 0.8`). Two people adding rate changes to the same model in either order get the same result.

An example, on a chart trending at $100/day, with a `−50%` rate change and a $1,000 one-off both starting on the same day:

```
day 1:  100 × 0.5  +  1,000  =  1,050
day 2:  100 × 0.5           =     50
```

## Use a scenario in a budget

**Budgets use the plain trend unless you turn on a model for that budget.** A budget's forecast threshold decides when someone gets paged, so a scenario only affects a budget when you choose it there.

When you pick a model in a budget:

- The budget's **forecast** thresholds are checked against the scenario-adjusted month total.
- The plain trend forecast is still shown alongside it, so the budget card shows both numbers.
- The alert names the model. A threshold crossed on an adjusted number reads `… (includes scenario "Q4 plan")`, so you can tell why you were paged from the message itself.
- **`actual` thresholds are never affected.** They measure money already spent.

You can't delete a model a budget is using (see below), so a budget never quietly switches back to the trend.

![Budget editor showing the Scenario dropdown with "Q4 plan" selected and the warning text explaining that forecast thresholds will be judged against the adjusted figure](https://agent-assets.infrawrench.com/docs-screenshots/features/scenario-models/budget-scenario-picker.png)

## Create and edit models

Go to the **Costs** panel, open the **Allocation** tab, and find the **Scenario models** section (next to saved filters).

Creating and editing needs `costs:write`. Viewing needs `costs:read`.

![The Scenario models section of the Costs panel listing two models with their adjustments summarized underneath each name](https://agent-assets.infrawrench.com/docs-screenshots/features/scenario-models/models-section.png)

Charts, reports and budgets all point at the same model, so editing it changes every projection that uses it. Before you save, the editor lists what uses the model and calls out budgets in particular:

![The scenario model editor with three adjustment rows (a one-off, a recurring monthly amount, and a scoped rate change) and the amber warning naming the budgets and dashboards that reference it](https://agent-assets.infrawrench.com/docs-screenshots/features/scenario-models/model-editor.png)

**You can't delete a model that's still in use.** You'll see a list of what uses it. Remove it from those charts and budgets first.

## Apply a model to a graph

1. Open any cost graph's editor.
2. Turn on **Forecast**.
3. Pick a model from **Scenario**.

The **Scenario** picker only appears once your organization has at least one model, and it's disabled while **Forecast** is off.

This works anywhere a cost graph does: a dashboard card, a saved [cost report](./cost-reports.md), or the graphs on the Costs panel.

![The cost graph editor's options row with Forecast checked and the Scenario dropdown open showing the org's models](https://agent-assets.infrawrench.com/docs-screenshots/features/scenario-models/graph-editor-scenario-picker.png)

## Use the CLI

```
infrawrench scenarios
```

Lists your organization's models with every adjustment and its scope.

```
infrawrench scenarios "Q4 plan" --last 60d
```

Applies a model to your organization's forecast. It prints the **trend total and the adjusted total together**, then what each adjustment contributed over the forecast period, then anything outside the query's scope. Add `--json` to get both projections as arrays for a script to compare.

## Use MCP and chat

Two tools:

- `list_scenario_models`: the models and their adjustments.
- `apply_scenario_forecast`: a cost query with a model applied. It returns `forecast` (the plain trend) and `scenario` (the adjusted projection) together, plus `contributions`, `outOfScope` and `convertedFrom`. The assistant always reports both.

## Use the API

`GET`, `POST`, `PUT`, `DELETE /api/org/{orgId}/cost-scenarios` manage models (`costs:read` / `costs:write`), and `GET /cost-scenarios/{id}/referents` tells you what uses a model before you change it.

To apply one, send `scenarioModelId` with `forecast: true` on `POST /costs/query`. The response includes the plain `forecast` and a `scenario` object with the adjusted `points`, per-adjustment `contributions`, the signed `totalDelta`, any `convertedFrom` currency, and the `outOfScope` labels. Sending `scenarioModelId` without a forecast returns a `400`. See [the OpenAPI spec](../team-and-billing/openapi.md).

## Combine models in a named forecast

A graph applies one model. To combine several, save them as a **named forecast** on a cost report: pick the models, put them in priority order, and optionally base the starting line on a business metric's planned values. Each model adjusts the line the ones before it produced, and the report's Forecasts view compares the result with the automatic forecast. You can't delete a model a forecast uses until the forecast stops using it. See [Cost forecasts](./cost-forecasts.md).

## On mobile

The [mobile app](./mobile-app.md) shows an applied scenario read-only: the second dashed line, the model's name in the legend, and the same caption with the model and its total effect. You create and edit models on web and desktop.
