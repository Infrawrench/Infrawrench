---
title: Carbon estimate
description: Estimated CO2e beside the cost, with every assumption on the page — and no number at all for anything we cannot place.
sidebar_order: 15
---

At the bottom of the [Costs](./cloud-costs.md) page is an estimate of the
emissions from running your compute.

<insert [The Estimated carbon section on the Costs page, showing total kg CO2e over 30 days, the resources-estimated and could-not-be-estimated counts, and the "What this rests on" assumptions box] here>

## It is an estimate, and it is built to say so

**Nothing here is measured.** Your providers do not expose per-resource power
draw, so this multiplies four published figures together:

```
vCPUs × watts-per-vCPU × hours × datacentre overhead ÷ 1000 × grid intensity
```

The grid intensity and the watt figures come from the
[Cloud Carbon Footprint](https://github.com/cloud-carbon-footprint/cloud-carbon-coefficients)
coefficients project, which sources them from government and grid-operator
publications. They are reproduced, with their vintage recorded, not derived by
us.

## Anything we cannot place gets no number

If a resource's provider has no published grid figures, its region is not in
the coefficient set, or no vCPU count is known for its size, it produces **no
estimate**. It is listed, with the reason, beside the total.

That is the central decision in this feature. A carbon figure computed against
a guessed grid is worse than no figure, because it is a number somebody will
put in a report. And a total that silently covered two thirds of an estate
would read exactly like a complete answer, which is why the count of what could
_not_ be estimated sits next to the total rather than at the bottom of the page.

vCPU counts come from each plugin's own size catalogue — the same declaration
[right-sizing](./right-sizing.md) uses. A provider that gains right-sizing
gains a carbon estimate at the same time, and a resource type that declares no
size is an explainable gap rather than a guess.

## The assumptions are on the page

- **CPU utilisation is assumed at 50%.** This is the single largest source of
  error. The product does not collect per-resource CPU history for every
  provider, and a figure derived from the few that do would be quietly
  inconsistent across an estate — so it is a constant, and it is shown to you.
- **Datacentre overhead (PUE)** is each provider's published figure.
- **Coverage is operational compute.** Storage, network egress, managed
  services, and the emissions from manufacturing the hardware are all excluded.

Two resources in different regions with the same size will show very different
numbers — that is the point. `eu-north-1` and `af-south-1` differ by more than
a hundredfold, and moving a workload is usually a far larger lever than
shrinking it.

## Permissions

Reading it needs **Costs: read** — it is a reporting figure that sits beside
spend, is grouped the same way, and is the sort of number that ends up in a
board pack.

## Over the API

`GET /api/org/{orgId}/carbon?windowDays=30` returns the rows, the groupings,
the unestimatable resources and the assumptions. See the
[OpenAPI reference](../team-and-billing/openapi.md).
