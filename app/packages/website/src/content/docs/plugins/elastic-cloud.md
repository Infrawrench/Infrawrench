---
title: Elastic Cloud
description: Track Elastic Cloud spend by deployment, project and line item with prepaid ECU burndown, and manage hosted deployments, serverless projects, traffic filters, extensions and budgets.
sidebar_order: 20
---

Connect your Elastic Cloud organization to see what it costs and manage the cloud side of it. One account covers both **Elastic Cloud Hosted** (deployments) and **Elastic Cloud Serverless** (projects).

To work with the search engine inside a cluster (indices, documents, queries), use the [OpenSearch](./opensearch.md) plugin with the cluster's endpoint. This plugin manages the cloud around it.

## What you can manage

- **Organizations**: the organization your API key belongs to, found automatically, so there's no ID to look up. You see month-to-date spend by category, the current hourly rate, spend by deployment and project for the month, and your prepaid ECU balance with each order line and its expiry. The Metrics tab charts daily cost per deployment and project.
- **Hosted deployments**: version, region, hardware profile, status and health, total memory, autoscaling, tags, the Elasticsearch and Kibana endpoints and the Cloud ID (all copyable). The detail page lists the topology per tier and every Elasticsearch instance with its JVM memory pressure and disk use. The dashboard card shows health, the highest memory pressure and disk use. You can:
  - **Edit** the name, the tags (`key:value` pairs) and the hot tier: its size in GB of RAM per zone and its number of availability zones. Only the sizes Elastic Cloud offers for the deployment's hardware profile are accepted, and the detail page lists them under Topology.
  - **Restart Elasticsearch** (one availability zone at a time) or **Restart Kibana**.
  - **Apply or remove traffic filters**: the Traffic filters section lists every filter in the deployment's region with an Apply or Remove button.
  - **Delete**, which shuts the deployment down. Elastic Cloud takes a snapshot first and stops billing for it.
  - Chart its daily cost by line item on the Metrics tab.
- **Serverless projects**: Elasticsearch, Observability, Security and Vector Database projects, with region, status, product tier, search power and endpoints (Elasticsearch, Kibana, APM and the managed OTLP endpoint). You can:
  - **Create** a project by picking its type and a region, plus the hardware optimization for Elasticsearch projects or the product tier for Observability projects. The admin password is saved as the project's **Admin Password** output.
  - **Edit** the name, the search power (28 to 3000, Elasticsearch and Vector Database projects) and the tags.
  - **Reset credentials** to get a new admin password (saved as the Admin Password output), and **Resume** a suspended project.
  - Delete it, and chart its daily cost on the Metrics tab.
- **Traffic filters** (hosted): IP allowlists and private connectivity rulesets (AWS PrivateLink, Azure Private Link, GCP Private Service Connect) with their rules and the deployments they apply to. To create an IP filter, pick the region, list the allowed addresses or CIDR ranges and, if you like, the deployments to apply it to. You can edit the name, description, sources and whether new deployments get it automatically, remove it from a deployment on the filter's page, or delete it.
- **Serverless traffic filters**: the same for serverless projects, per region. Create IP filters and edit the name, description, sources and default inclusion.
- **Extensions**: custom Elasticsearch plugins and bundles (scripts, dictionaries, synonym files) with the deployments that use them. Register one from a download URL, edit its name, description, version or URL, or delete it.
- **Budgets**: monthly budgets in ECUs for the whole organization or for one deployment or project, with the alert thresholds Elastic emails about. To create one, pick what it applies to, an amount, the thresholds (for example 50, 80 and 100 percent) and who gets alerted. Edit the name, amount, thresholds and whether it's active, or delete it.

<insert [Elastic Cloud hosted deployment detail page showing the topology table, the Elasticsearch instances with memory pressure, and the traffic filters section with Apply and Remove buttons] here>

## Connect an account

There's one field: an **Elastic Cloud API key**. Create it in the Elastic Cloud console under **Organization > API keys**. The key's role decides what you can do:

| To                                                                 | The key needs                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Read costs, budgets and the prepaid balance                        | **Billing admin** (or Organization owner)                             |
| Create, edit and delete budgets                                    | **Billing admin** (or Organization owner)                             |
| List and manage hosted deployments, traffic filters and extensions | **Admin** or **Editor** on deployments (Viewer lists without changes) |
| List and manage serverless projects                                | **Admin** or **Editor** on the project types you use                  |

**Organization owner** covers everything. Anything the key's role can't reach shows as empty instead of breaking the whole account. So a Billing admin key gives you cost graphs without inventory, and a deployment-only key gives you inventory without costs.

<insert [Elastic Cloud Add-account form with the API key field filled] here>

## Cost graphs

Elastic Cloud accounts feed [cost graphs and budgets](../features/cloud-costs.md):

- **Daily, by deployment and project.** Every row belongs to one hosted deployment, serverless project or organization-level service (Synthetics, Cloud Connect usage) and links to it.
- **By line item.** The service is the billing category: **Capacity**, **Data Transfer In**, **Data Transfer Out**, **Data Transfer (Inter-Node)**, **Snapshot Storage**, **Snapshot Storage Requests**, and the serverless dimensions (ingest, retention, search and the rest) under Elastic's own names. The quantity behind each row (hours, GB) is shown with it.
- **Region and tags.** Capacity rows carry the region (`aws-us-east-1`, `gcp-europe-west1`, `azure-eastus2`). Every row is tagged with the `organization`, the `instance` name, the `instance_type` (Hosted deployment, Elasticsearch project, Observability project and so on) and, for hosted capacity, the `component` (elasticsearch, kibana, integrations_server).
- **Up to a year** of history is loaded when you connect. A day shows up once it has ended, and recent days are refreshed so late usage is picked up.

Amounts are shown in US dollars at Elastic's nominal rate of **1 ECU = $1.00**. If you bought prepaid ECUs at a discount, you see the nominal value, not the price you negotiated.

<insert [Cost graph grouped by service for an Elastic Cloud account, showing Capacity, Data Transfer Out and Snapshot Storage stacked by day] here>

## Prepaid ECU burndown

If you're on prepaid consumption, your balance shows in the [credit burndown](../features/credit-burndown.md) section. There's one pot per active order line, with what you bought, what's left and when it expires, so the runway accounts for an order that lapses before you spend it. Reading the balance needs a Billing admin key.

## Tips and limits

- **This isn't the OpenSearch plugin.** That one talks to a search cluster directly. This one manages Elastic Cloud itself. Use both if you want both.
- **Only the hot tier can be resized here.** You can edit its size and zone count. Warm, cold, frozen and machine learning tiers, autoscaling limits and version upgrades stay in the Elastic Cloud console, where the plan editor shows the full topology.
- **Delete shuts a deployment down.** Elastic Cloud keeps shut-down deployments for a while before removing them. Restore one from the console if you need it back.
- **Private connectivity filters are listed, not created.** Their rules need endpoint IDs from your cloud provider, so create them in the Elastic Cloud console. You can still edit their name, description and default inclusion here.
- **Provider status** follows the Elastic Cloud status page, matched to your deployments and projects by region.
