---
title: Migration estimates
description: See what a service, or any set of resources, would cost on another provider, side by side with what it costs today, save the estimate, generate the target's Terraform and turn the saving into a scenario model.
sidebar_order: 5
---

"What would this cost on Hetzner?" is usually a spreadsheet: list the machines, look each one up, find the nearest size on the other side, look that up too. A migration estimate does it from what Infrawrench already knows: your resources, what they cost you, and the target provider's [published list prices](./price-catalog.md).

Each resource is matched to the target's equivalent (a virtual machine to a virtual machine, a managed PostgreSQL to a managed PostgreSQL), sized at least as large as it is today, and priced beside its current cost. Resources with no equivalent are listed apart with the reason, so nothing goes missing without you knowing.

![A migration estimate for a service moving from AWS to Hetzner Cloud: the three summary cards (Today, On Hetzner Cloud, Change per month) above the table of resources with their size today, current cost, matched Hetzner Cloud size and estimate, and the "No equivalent on Hetzner Cloud" list below](https://agent-assets.infrawrench.com/docs-screenshots/features/migration-estimates/estimate.png)

## Start an estimate

- **From a service:** open the service on the [Services](./services.md) page and click **Estimate migration**. The estimate follows the service: resources added to it later are included the next time you open the estimate.
- **From a selection:** open a [resource report](./resource-reports.md), tick the resources you want, and click **Estimate migration**. Selections can span pages and providers.
- **From the list:** open **Migration estimates** in the sidebar (under Costs) and click **New estimate**, then pick a service.

![The Migration estimates list, with saved estimates for a service on Hetzner Cloud, a service on Google Cloud and a hand-picked set of resources on DigitalOcean](https://agent-assets.infrawrench.com/docs-screenshots/features/migration-estimates/list.png)

Pick the provider to price on and, optionally, a region. Leave the region on **Nearest to the resources** and Infrawrench picks the target's first region in the part of the world most of the resources run in.

![The Estimate migration dialog with the checkout-api service, Hetzner Cloud as the target provider, the region left on Nearest to the resources, and a suggested name](https://agent-assets.infrawrench.com/docs-screenshots/features/migration-estimates/new-estimate.png)

Estimates are saved, so you can come back to them. They store only what to price and your choices; the figures are worked out again every time you open one, from current spend and current list prices.

## How resources are matched

Every provider plugin says what each of its resource types is across providers (a virtual machine, a Kubernetes cluster or node pool, managed PostgreSQL, MySQL, Redis or MongoDB, object storage, a block volume, file storage, a load balancer, a container app, a serverless function, a container registry, a static IP, a DNS zone) and which of its fields carry the size: the instance type, vCPUs, memory, GPUs, disk, node count and region.

- **Size:** the cheapest target size with **at least** the source's vCPUs, memory and GPUs. An instance type such as `m7i.large` is looked up in the source provider's price list or create form to find its vCPUs and memory. A machine without a GPU is never matched to one with a GPU because it happens to be cheaper.
- **Type:** the target's type of the same category. When the target has several (a managed database type per engine, say), the first one it can create is used.
- **Your choice wins:** every row has a size picker, listing the target's sizes with qualifying ones first, and a type picker when there is more than one. Sizes smaller than today are marked. Your picks are saved with the estimate.

Matching is by published specs, not by name or product class. A general-purpose instance and a dedicated-vCPU server with the same vCPUs and memory are treated as equivalent; check the row if that difference matters to you.

If a Kubernetes cluster's node pools are in the estimate too, the nodes are priced on the node pool rows and the cluster row prices the cluster alone, so nodes are not counted twice.

## Where the numbers come from

**Today:**

1. **Billed:** the resource's own spend in your [cost data](./cloud-costs.md) over the last 30 days, scaled to a 730-hour month. This needs a provider that reports cost per resource. It respects your [cost visibility](../team-and-billing/cost-visibility.md): you only see spend you are allowed to see.
2. **Estimate:** otherwise, the provider plugin's [cost estimate](./cost-estimates.md) for the resource as configured.
3. **List price:** otherwise, its size's published price.

**On the target:** the target plugin's own estimate for the matched configuration when it has one (it can include disks and node counts), otherwise the matched size's list price times the node count.

Each figure says which of these it is. Target prices are **list prices**: discounts, credits, committed-use agreements and negotiated rates are not applied, and metered usage (data transfer, requests, IOPS) is not included.

**Unknown is not zero.** A figure nothing can price reads **Unknown**, with the reason underneath:

- **Connect an account on this provider to price it:** the target's price list or sizes need one of your organization's accounts on it (AWS, Google Cloud, DigitalOcean, Hetzner, Scaleway and Oracle Cloud read their price lists with your credentials).
- **Source size unknown:** the resource's vCPUs and memory couldn't be read, so no size can be shown to meet them.
- **No size meets the source:** the target sells nothing that large.
- **No published price:** a size was matched but its price isn't published where Infrawrench reads it.

## Totals and the change

The three cards at the top show today's total, the target's total and the change per month. The **change** only counts resources priced on both sides, so a resource priced on one side can't read as all saving or all cost; the card says how many that is. Unknown figures are counted, not added as zero.

Figures stay in the currency the provider publishes. If you've set a display currency and exchange rates in Settings (see [display currency](./cloud-costs.md)), the totals are converted at your rates; without them, mixed currencies are shown side by side and no change is computed.

Resources with no equivalent on the target are listed under **No equivalent**, with what they cost today, and left out of the totals.

## Region and latency

The estimate prices everything in one target region. The line under the cards says which region and why: the one you chose, the nearest to the resources, or the target's default when the resources' location is unknown. If some resources run in another part of the world than that region, it says so: latency to their users will change.

## Generate Terraform

If the target provider supports [Terraform export](./terraform-export.md) for the matched types, **Terraform** opens the target's HCL for the matched rows, with each row's type, size and region filled in, ready to copy or download. Rows the export can't map are listed with the reason. The file is a starting point: images, networks, credentials and anything else the estimate doesn't know still need filling in before `terraform plan`.

## Turn it into a scenario

**Create scenario** writes the change into a [scenario model](./scenario-models.md): one recurring monthly amount from the date you pick, so a forecast can show "the migration saves $X a month from March". It uses the change over resources priced on both sides, in one currency, and needs **Costs: write**. You can then apply the model to a cost graph or a budget like any other.

## Permissions

Viewing and computing estimates needs **Costs: read**. Saving, editing, deleting and creating a scenario needs **Costs: write**.

## Use the CLI, AI chat and the API

```
infrawrench migrate-estimate --service checkout-api --to hetzner
infrawrench migrate-estimate --service checkout-api --to gcp --region europe-west3 --json
infrawrench migrate-estimate --resources <id>,<id> --to digitalocean --save "Move the workers"
```

See [CLI](./cli.md). [AI chat](./ai-chat.md) and the [MCP server](./mcp.md) have `list_migration_targets`, `list_migration_estimates` and `estimate_migration_cost`, so you can ask "what would the checkout service cost on Hetzner?" and get an answer from your own resources and current list prices.

The API is under `/api/org/{orgId}/migration-estimates`: `GET /targets`, `POST /preview` (an unsaved estimate), the saved estimates (`GET`, `POST`, `GET`/`PUT`/`DELETE /{id}`), `GET /{id}/result`, `GET /{id}/terraform` and `POST /{id}/scenario`. See [the OpenAPI spec](../team-and-billing/openapi.md).

## Where it works

Web and the desktop app in cloud mode. Not in the mobile app.

## Providers covered

Resource types are matched for AWS, Google Cloud, Azure, Oracle Cloud, Alibaba Cloud, IBM Cloud, DigitalOcean, Hetzner, Linode / Akamai, Vultr, Scaleway, OVHcloud, Civo, UpCloud, Exoscale, Fly.io, Render, Koyeb, Heroku, Railway and Northflank. Any of them can be the source or, where it has types that can be created, the target. How precisely a target can be priced depends on what it publishes: providers in the [price catalog](./price-catalog.md) price virtual machines from their list, others from their create form's sizes or their cost estimates, and some only report the matched type with an unknown price.
