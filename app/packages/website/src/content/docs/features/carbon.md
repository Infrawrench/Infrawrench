---
title: Carbon estimate
description: Estimated CO2e beside every price, with every assumption on the page, and no number at all for anything we cannot place.
sidebar_order: 15
---

Wherever Infrawrench quotes a price, it also quotes an estimate of the
emissions from running that compute: on the [Costs](./cloud-costs.md) page, on
a resource's header, in the create and edit forms, in
[right-sizing](./right-sizing.md), in an
[ephemeral environment](./ephemeral-environments.md)'s estimate, in the
[CLI](./cli.md), to agents over [MCP](./mcp.md), and from
[workflows](./workflows.md) and [custom graphs](./custom-graphs.md).

<insert [The Estimated carbon section on the Costs page, showing total kg CO2e over 30 days, the Estimated and Not estimated counts, the by-provider list and the one-line assumptions footnote] here>

## It is an estimate, and it is built to say so

**Nothing here is measured.** Your providers do not expose per-resource power
draw, so this multiplies published figures together:

```
vCPUs × watts-per-vCPU × hours × datacentre overhead ÷ 1000 × grid intensity
```

- **Grid intensity** for AWS, Google Cloud and Azure comes from the
  [Cloud Carbon Footprint](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint)
  project's per-region tables. For every other provider it comes from
  [Ember](https://ember-energy.org/data/yearly-electricity-data/)'s 2024 figure
  for the country the datacentre is in, and for US sites from the same EPA
  eGRID region figures CCF uses, so a server in Ashburn reads the same grid
  whichever provider runs it. Each figure says which source it came from.
- **Watts per vCPU** are CCF's per-provider averages. Providers CCF does not
  cover use its AWS average, which is what CCF itself does for Alibaba.
- **Datacentre overhead (PUE)** is each provider's published figure, per region
  where they publish one (Google, Scaleway). Hetzner's own parks are 1.13 and
  OVHcloud's group average is 1.24. DigitalOcean, Fly.io, Linode, Oracle Cloud and
  Hetzner's US and Singapore sites publish no figure, so they read the
  Uptime Institute's 2025 industry average of 1.54.

Grid figures are **location-based**: what the local grid emits, not what a
provider's renewable contracts offset. That is the like-for-like comparison
across providers. Several of them buy renewable power, and their own
market-based figures would be lower.

## Which providers are covered

OVHcloud's group average is 1.24. DigitalOcean, Fly.io, Linode, Oracle Cloud and
Hetzner's US and Singapore sites publish no figure, so they read the
Uptime Institute's 2025 industry average of 1.54.

Types with no processor anyone publishes a figure for (a bucket, a DNS record,
a serverless function) are outside the scope rather than "not estimated".

A managed cluster's estimate (EKS, GKE, AKS, DigitalOcean Kubernetes, Kapsule,
OVHcloud Managed Kubernetes, LKE) shows on the cluster and in its create form, but
is **not added to the total**: its nodes are listed in their own right, as
droplets, EC2 instances and so on, and adding both would count every node
twice. For the same reason a Kubernetes node whose machine is already listed as
an instance is counted once, and the page says how many were.

## Anything we cannot place gets no number

If a resource's region is not in the coefficient set, or no vCPU count is known
for its size, it produces **no estimate**. It is listed, with the reason, beside
the total.

That is the central decision in this feature. A carbon figure computed against
a guessed grid is worse than no figure, because it is a number somebody will
put in a report. And a total that silently covered two thirds of an estate
would read exactly like a complete answer, which is why the count of what could
_not_ be estimated sits next to the total rather than at the bottom of the page.

vCPU counts come from each provider's own size catalogue, the same one the
create form's size picker shows, or from the resource itself where the
provider reports it (Fly.io machines, Kubernetes nodes).

## The assumptions are on the page

- **CPU utilisation is assumed at 50%.** This is the single largest source of
  error. The product does not collect per-resource CPU history for every
  provider, and a figure derived from the few that do would be quietly
  inconsistent across an estate, so it is a constant, and it is shown to you.
- **Coverage is processors.** Storage, memory, network egress and the emissions
  from manufacturing the hardware are all excluded.

Two resources of the same size in different regions will show very different
numbers, and that is the point. `eu-north-1` and `ap-south-1` differ by more
than a hundredfold, and moving a workload is usually a far larger lever than
shrinking it.

## Beside every price

- **Create form.** Each size card shows its own estimate for the region you
  picked, and the header shows the configuration's total beside its price.
  Nothing is fetched for this: the size picker already carries each size's
  vCPUs.
- **Resource header and edit form.** The header shows the resource's monthly
  estimate; click it for what it rests on. The edit form shows what a change
  does to it, beside what it does to the bill.

  <insert [A resource detail header with the Estimated carbon chip expanded, showing vCPUs, grid zone and figure, PUE and the assumed utilisation, beside the Estimated cost chip] here>

- **Right-sizing.** Each recommendation shows the CO2e the resize would save
  each month, beside the money.
- **Ephemeral environments.** The instantiate dialog's estimate includes the
  environment's monthly CO2e, and how many members could not be estimated.

## Permissions

Reading the organization's estimate needs **Costs: read**. It is a reporting
figure that sits beside spend, is grouped the same way, and is the sort of
number that ends up in a board pack. A single resource's figure rides along with
its price and needs what the price needs.

## From the CLI, MCP, workflows and graphs

```sh
infrawrench carbon --days 30
infrawrench carbon --json
```

`infrawrench estimate <resource>` prints the carbon line under the price, and
`infrawrench oversized` has a CO2e column.

Over [MCP](./mcp.md), `get_carbon_estimate` returns the organization's estimate
and `estimate_resource_footprint` returns one resource's monthly price and
carbon, optionally for a proposed edit.

In a [workflow](./workflows.md), `infra.carbon.estimate({ windowDays })` and
`infra.carbon.resource(resourceId, fields?)` read the same figures, for
example to check a resize before applying it. A
[custom graph](./custom-graphs.md) can call `graph.carbon.estimate()`.

## Over the API

`GET /api/org/{orgId}/carbon?windowDays=30` returns the rows, the groupings,
the unestimatable resources and the assumptions.
`POST /api/org/{orgId}/resources/cost-estimate` returns a `carbon` member beside
the price. See the [OpenAPI reference](../team-and-billing/openapi.md).
