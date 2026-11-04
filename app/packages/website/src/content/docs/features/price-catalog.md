---
title: Price catalog
description: Search and compare instance types across providers by their published list prices, filter by vCPU, memory, GPU, region and price, and open any of them in the create form with its estimate.
sidebar_order: 4
---

[Cost estimates](./cost-estimates.md) price the one machine on your screen. The price catalog helps with the question before that: what could I run, where, and what would it cost? It puts every supported provider's published list prices into one table you can search, filter and sort, and it compares similar machines across providers by their specs.

Open it from the **Price catalog** tile in the sidebar. It opens as a workspace tab in the web app and in the desktop app (cloud mode).

<insert [Price catalog tab in Search mode, filtered to 4+ vCPU and 16+ GB in Europe, with rows from several providers sorted by monthly price and the "Use in estimate" link visible on a row] here>

## Search instance types

Each row is one instance type, priced in one region:

- **Instance:** the provider's own name for it (`m7i.large`, `Standard_D4s_v5`, `CX32`), with the provider, service and series.
- **Specs:** vCPUs, memory, GPUs (count and model) and included disk, as the provider publishes them.
- **Rate:** the price in the provider's own unit (per hour or per month) and currency. Below it you'll see any other rates the provider publishes for the same machine in that region: spot, reserved and savings-plan terms.
- **Per month:** the rate as a 730-hour month, the same as [cost estimates](./cost-estimates.md) use.

Filter by text (instance name, family, GPU model), provider, vCPU and memory ranges, GPU (with, without, or a specific model) and a monthly price cap. Click a column header to sort. Cheapest first is the default.

**Area and region.** Pick an area (North America, Europe, Asia Pacific and so on) and each provider is priced in its first region there, so you can compare like with like without learning every provider's region names. Pick a single provider and you get a picker for its exact regions.

**Rate.** Switch between on-demand, spot, reserved and savings-plan prices. If a provider doesn't publish a rate type, it simply has no rows for it.

## Compare providers

**Compare providers** finds the cheapest instance at each provider that meets every spec you give: at least the vCPUs, memory and GPUs you ask for, and optionally a GPU model. Providers are listed cheapest first, each with its best match and a couple of runners-up. You can also click **Compare** on any search row to find equivalents of that machine.

Matches are based on published specs only. An `m7i.large` and a `CX22` are compared because both list 2 vCPUs, not because they're the same class of machine.

<insert [Compare providers mode for 8 vCPU / 32 GB in North America, showing one row per provider with the cheapest match, its monthly price and runners-up] here>

## Use in estimate

**Use in estimate** opens that provider's create form with the instance type and region filled in, so the [estimate badge](./cost-estimates.md) prices the whole setup (disks, node counts and all) before you create anything. You need an account on that provider. If you have several, pick which one to use.

## Where the prices come from

Every figure is the provider's **published list price**. Your discounts, credits, committed-use agreements and negotiated rates aren't applied. [Cloud costs](./cloud-costs.md) shows what you were actually charged.

| Provider                                   | Source                                       | Rates                                    | Needs an account                                                           |
| ------------------------------------------ | -------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| [AWS](../plugins/aws.md)                   | Price List Query API, EC2 spot price history | On-demand, reserved (1 and 3 year), spot | Yes: `pricing:GetProducts` (spot also uses `ec2:DescribeSpotPriceHistory`) |
| [Azure](../plugins/azure.md)               | Retail Prices API                            | On-demand, spot, reserved, savings plan  | No                                                                         |
| [Google Cloud](../plugins/gcp.md)          | Cloud Billing Catalog API                    | On-demand, spot, committed use           | Yes: lists machine types for the region                                    |
| [DigitalOcean](../plugins/digitalocean.md) | Droplet sizes API                            | On-demand                                | Yes                                                                        |
| [Hetzner](../plugins/hetzner.md)           | Server types API (net prices, VAT excluded)  | On-demand                                | Yes                                                                        |
| [Linode / Akamai](../plugins/linode.md)    | Linode types API                             | On-demand                                | No                                                                         |
| [Scaleway](../plugins/scaleway.md)         | Instance types API                           | On-demand                                | Yes                                                                        |
| [Oracle Cloud](../plugins/oracle-cloud.md) | Oracle price list, compute shapes            | On-demand                                | Yes: lists shapes                                                          |
| [CoreWeave](../plugins/coreweave.md)       | CoreWeave's published GPU pricing            | On-demand                                | No                                                                         |

Where a provider needs credentials to read its price list, Infrawrench uses one of your organization's accounts on that provider. The prices are still public list prices, not your account's. Without such an account, the provider shows as not searched rather than as having nothing.

Prices refresh daily (spot prices hourly where available). If a provider's price API is down, you see the last list it returned, with a note saying so.

**Currencies.** Prices stay in the currency the provider publishes (USD for most, EUR for Hetzner and Scaleway). If you've set a display currency and exchange rates in Settings (see [display currency](./cloud-costs.md)), monthly figures are also converted at your rates and sorting uses them. Otherwise the catalog tells you when it's sorting mixed currencies by face value.

## Use the CLI and AI chat

```
infrawrench prices search --min-vcpus 4 --min-memory 16 --area europe
infrawrench prices compare --vcpus 8 --memory 32 --json
```

See [CLI](./cli.md). [AI chat](./ai-chat.md) and the [MCP server](./mcp.md) have the same catalog as tools (`search_price_catalog`, `compare_instance_prices`), so you can ask "what's the cheapest 8 vCPU machine in Europe with at least 32 GB?" and get an answer from current list prices.
