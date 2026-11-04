---
title: Carbon estimate
description: See estimated CO2e beside every price in Infrawrench, with every assumption shown and no number for anything that can't be placed.
sidebar_order: 15
---

Wherever Infrawrench shows a price, it also shows an estimate of the emissions from running that compute. You'll see it:

- on the [Costs](./cloud-costs.md) page, where the **Carbon** tab has your organization's total
- in a resource's header
- in the create and edit forms
- in [right-sizing](./right-sizing.md)
- in an [ephemeral environment](./ephemeral-environments.md)'s estimate
- in the [CLI](./cli.md), to agents over [MCP](./mcp.md), and in [workflows](./workflows.md) and [custom graphs](./custom-graphs.md)

<insert [The Estimated carbon section on the Costs page Carbon tab, showing total kg CO2e over 30 days, the Estimated and Not estimated counts, the by-provider list and the one-line assumptions footnote] here>

## How the estimate is calculated

**Nothing here is measured.** Providers don't report power draw per resource, so the estimate multiplies published figures together:

```
vCPUs × watts-per-vCPU × hours × datacentre overhead ÷ 1000 × grid intensity
```

- **Grid intensity** for AWS, Google Cloud and Azure comes from the [Cloud Carbon Footprint](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint) (CCF) project's per-region tables. For every other provider it comes from [Ember](https://ember-energy.org/data/yearly-electricity-data/)'s 2024 figure for the country the datacentre is in. US sites use the same EPA eGRID region figures CCF uses, so a server in Ashburn reads the same grid whichever provider runs it. Each figure tells you which source it came from.
- **Watts per vCPU** are CCF's per-provider averages. Providers CCF doesn't cover use its AWS average, which is what CCF itself does for Alibaba.
- **Datacentre overhead (PUE)** is each provider's published figure, per region where they publish one (Google, Scaleway). Hetzner's own parks are 1.13 and OVHcloud's group average is 1.24. DigitalOcean, Fly.io, Linode, Oracle Cloud and Hetzner's US and Singapore sites publish no figure, so they use the Uptime Institute's 2025 industry average of 1.54.

Grid figures are **location-based**: what the local grid emits, not what a provider's renewable contracts offset. That keeps the comparison fair across providers. Several providers buy renewable power, and their own market-based figures would be lower.

## What's included

- **Processors only.** Storage, memory, network egress and the emissions from manufacturing hardware are excluded.
- **CPU utilisation is assumed to be 50%.** This is the biggest source of error. It's a constant applied the same way across every provider, and it's shown to you.
- Resource types with no processor to measure (a bucket, a DNS record, a serverless function) are out of scope, rather than "not estimated".
- A managed Kubernetes cluster's estimate (EKS, GKE, AKS, DigitalOcean Kubernetes, Kapsule, OVHcloud Managed Kubernetes, LKE) shows on the cluster and in its create form, but **isn't added to the total**. Its nodes are already listed as droplets, EC2 instances and so on, so adding both would count every node twice. For the same reason, a Kubernetes node whose machine is already listed as an instance is counted once, and the page tells you how many were.

Two resources of the same size in different regions can show very different numbers. `eu-north-1` and `ap-south-1` differ by more than a hundredfold, so moving a workload is often a much bigger lever than shrinking it.

## Resources that can't be estimated

If a resource's region isn't in the data set, or its size has no known vCPU count, it gets **no estimate**. It's listed beside the total with the reason. A guessed figure could end up in a report, so Infrawrench shows nothing instead, and keeps the count of what couldn't be estimated right next to the total so you know how complete it is.

vCPU counts come from each provider's own size list (the one the create form's size picker shows), or from the resource itself where the provider reports it (Fly.io machines, Kubernetes nodes).

## Where you'll see it

- **Create form.** Each size card shows its estimate for the region you picked, and the header shows the total for your configuration beside its price.
- **Resource header and edit form.** The header shows the resource's monthly estimate. Click it to see what it's based on. The edit form shows how a change affects carbon, next to how it affects your bill.

  <insert [A resource detail header with the Estimated carbon chip expanded, showing vCPUs, grid zone and figure, PUE and the assumed utilisation, beside the Estimated cost chip] here>

- **Right-sizing.** Each recommendation shows the CO2e a resize would save each month, next to the money.
- **Ephemeral environments.** The instantiate dialog's estimate includes the environment's monthly CO2e and how many members couldn't be estimated.

## Permissions

Viewing your organization's estimate needs **Costs: read**. A single resource's figure comes with its price and needs the same permission as the price.

## Use it from the CLI, MCP, workflows and graphs

```sh
infrawrench carbon --days 30
infrawrench carbon --json
```

`infrawrench estimate <resource>` prints the carbon line under the price, and `infrawrench oversized` has a CO2e column.

Over [MCP](./mcp.md), `get_carbon_estimate` returns the organization's estimate, and `estimate_resource_footprint` returns one resource's monthly price and carbon, optionally for a proposed edit.

In a [workflow](./workflows.md), `infra.carbon.estimate({ windowDays })` and `infra.carbon.resource(resourceId, fields?)` read the same figures, for example to check a resize before you apply it. A [custom graph](./custom-graphs.md) can call `graph.carbon.estimate()`.

## Use it from the API

`GET /api/org/{orgId}/carbon?windowDays=30` returns the rows, the groupings, the resources that couldn't be estimated and the assumptions. `POST /api/org/{orgId}/resources/cost-estimate` returns a `carbon` field beside the price. See the [OpenAPI reference](../team-and-billing/openapi.md).
