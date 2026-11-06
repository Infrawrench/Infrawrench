---
title: Instance pricing panel
description: See the prices, price history, regions and specs of what a resource runs, on its own page, for AWS, Azure, Google Cloud, Alibaba Cloud and RunPod.
---

Resource pages for the compute your accounts run have a collapsible **Instance pricing and specs** panel on their Overview tab. It brings the data from [instances.infrawrench.com](https://instances.infrawrench.com) to the resource, already set to its instance type, region and configuration, so you don't have to look anything up.

<insert [A resource detail page's Overview tab with the Instance pricing and specs panel expanded: the price cards, the pickers, the price history chart and the on-demand price by region bars] here>

The panel starts collapsed and loads nothing until you open it. It stays open or closed the way you left it, on this device. It works in the web app and in the desktop app, and the desktop app shows it even when you aren't signed in.

## What it covers

| Provider      | Resources                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| AWS           | EC2 instances, RDS instances, ElastiCache clusters, OpenSearch domains, Redshift clusters, EKS clusters (their node types) |
| Azure         | Virtual machines, AKS clusters (the VM size of their nodes)                                                                |
| Google Cloud  | Compute Engine instances, GKE clusters (their machine type)                                                                |
| Alibaba Cloud | ECS instances, ACK node pools                                                                                              |
| RunPod        | Pods, serverless endpoints (their GPU types)                                                                               |

## What it shows

- **Prices**: on demand, spot where the provider sells it, and each length of commitment, each with what it saves against on demand. Switch between hourly and monthly (730 hours) under **Show prices**.
- **Price history**: how each of those prices has moved in the region.
- **Prices by region**: on-demand and spot, cheapest first. The first eight appear until you choose **Show all**, and clicking a region switches the panel to it.
- **Comparison**: the on-demand price across one configuration choice, such as operating system or database engine.
- **Regions offering it over time**.
- **Specs and lifecycle**: vCPUs, memory, GPUs, processor, network and storage, when the type was first listed and how recent the price list is.
- **Family sizes**: every size in the family with its price. Each opens its page on the instances site.
- **Every committed term** and **every attribute the provider publishes**, collapsed below. An attribute that has changed lists each value it has had and when.

## Choosing a configuration

The pickers open on what the resource runs where the panel can tell, such as an RDS instance's engine and Multi-AZ setting, or an Azure VM's operating system. Anything the resource doesn't report opens on the cheapest option, and AWS doesn't report an EC2 instance's operating system in the fields Infrawrench syncs, so EC2 instances open on Linux. Change any picker to compare, including the region. A cluster that runs several instance types adds a picker for them.

If the price list doesn't sell what the resource runs in that region, for example an older instance type that has been retired, the panel says so and shows the closest match rather than presenting it as this resource's price.

The prices are the providers' public list prices in US dollars. They don't include your discounts or any other charges on the resource, so for what a resource really costs you, see [cloud costs](./cloud-costs.md).

To query the same data yourself, use the [Instance pricing SQL API](../team-and-billing/instance-pricing-api.md).
