---
title: Elastic Cloud
description: Track Elastic Cloud spend by deployment, project and line item with prepaid ECU burndown, and manage hosted deployments, serverless projects, traffic filters, extensions and budgets.
sidebar_order: 20
---

The Elastic Cloud plugin connects to your Elastic Cloud organization through the Elastic Cloud API. It covers **Elastic Cloud Hosted** (deployments) and **Elastic Cloud Serverless** (projects) in one account. To connect to the search engine inside a cluster (indices, documents, queries), use the [OpenSearch](./opensearch.md) plugin with the cluster's endpoint; this plugin manages the cloud around it.

## What you can manage

- **Organizations**: the organization the API key belongs to, found from the key, so there is no ID to look up. Each shows month-to-date spend broken down by category, the current hourly rate, spend by deployment and project for the month, and your prepaid ECU balance with each order line and its expiry. The Metrics tab charts daily cost per deployment and project.
- **Hosted deployments**: version, region, hardware profile, status and health, total memory, autoscaling, tags, the Elasticsearch and Kibana endpoints and the Cloud ID (all copyable). The detail page lists the topology per tier and every Elasticsearch instance with its JVM memory pressure and disk use; the dashboard card shows health, the highest memory pressure and disk use. You can:
  - **Edit** the name, the tags (`key:value` pairs) and the hot tier: its size in GB of RAM per zone and its number of availability zones. Only the sizes Elastic Cloud offers for the deployment's hardware profile are accepted; the detail page lists them under Topology.
  - **Restart Elasticsearch** (one availability zone at a time) or **Restart Kibana**.
  - **Apply or remove traffic filters**: the Traffic filters section lists every filter in the deployment's region with an Apply or Remove button.
  - **Delete**, which shuts the deployment down. Elastic Cloud takes a snapshot first and stops billing for it.
  - Chart its daily cost by line item on the Metrics tab.
- **Serverless projects**: Elasticsearch, Observability, Security and Vector Database projects, with region, status, product tier, search power and endpoints (Elasticsearch, Kibana, APM and the managed OTLP endpoint). You can:
  - **Create** a project by picking its type and a region from Elastic's list, plus the hardware optimization for Elasticsearch projects or the product tier for Observability projects. The admin password Elastic returns is stored as the project's **Admin Password** output.
  - **Edit** the name, the search power (28 to 3000, Elasticsearch and Vector Database projects) and the tags.
  - **Reset credentials** to issue a new admin password (stored as the Admin Password output), and **Resume** a suspended project.
  - Delete it, and chart its daily cost on the Metrics tab.
- **Traffic filters** (hosted): IP allowlists and private connectivity rulesets (AWS PrivateLink, Azure Private Link, GCP Private Service Connect) with their rules and the deployments they apply to. Create an IP filter by picking the region, listing the allowed addresses or CIDR ranges and, optionally, the deployments to apply it to. Edit the name, description, sources and whether new deployments get it automatically; remove it from a deployment from the filter's page, or delete it.
- **Serverless traffic filters**: the same for serverless projects, per region. Create IP filters and edit the name, description, sources and default inclusion.
- **Extensions**: custom Elasticsearch plugins and bundles (scripts, dictionaries, synonym files) with the deployments that use them. Register one from a download URL, edit its name, description, version or URL, or delete it.
- **Budgets**: monthly budgets in ECUs for the whole organization or for one deployment or project, with the alert thresholds Elastic emails about. Create one by picking what it applies to, an amount, the thresholds (for example 50, 80 and 100 percent) and who is alerted. Edit the name, amount, thresholds and whether it is active, or delete it.

<insert [Elastic Cloud hosted deployment detail page showing the topology table, the Elasticsearch instances with memory pressure, and the traffic filters section with Apply and Remove buttons] here>

## Credentials

One field: an **Elastic Cloud API key**. Create it in the Elastic Cloud console under **Organization → API keys**. Its role decides what the account can do:

| To                                                                 | The key needs                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Read costs, budgets and the prepaid balance                        | **Billing admin** (or Organization owner)                             |
| Create, edit and delete budgets                                    | **Billing admin** (or Organization owner)                             |
| List and manage hosted deployments, traffic filters and extensions | **Admin** or **Editor** on deployments (Viewer lists without changes) |
| List and manage serverless projects                                | **Admin** or **Editor** on the project types you use                  |

**Organization owner** covers everything. A part of the account the key's role does not reach lists empty rather than failing the whole account, so a Billing admin key gives you cost graphs without inventory, and a deployment-only key gives you inventory without costs.

<insert [Elastic Cloud Add-account form with the API key field filled] here>

## Cost graphs

Elastic Cloud accounts feed [cost graphs & budgets](../features/cloud-costs.md) from the Elastic Cloud Billing API:

- **Daily, by deployment and project.** Each day is read from Elastic's per-instance costs for that day, so every row belongs to one hosted deployment, serverless project or organization-level service (Synthetics, Cloud Connect usage) and is linked to that resource.
- **By line item.** The service is the billing category: **Capacity**, **Data Transfer In**, **Data Transfer Out**, **Data Transfer (Inter-Node)**, **Snapshot Storage**, **Snapshot Storage Requests**, and the serverless dimensions (ingest, retention, search and the rest) under Elastic's own names. The quantity behind each row (hours, GB) is kept with it.
- **Region and tags.** Capacity rows carry the region from Elastic's SKU (`aws-us-east-1`, `gcp-europe-west1`, `azure-eastus2`). Every row has tags for the `organization`, the `instance` name, the `instance_type` (Hosted deployment, Elasticsearch project, Observability project and so on) and, for hosted capacity, the `component` (elasticsearch, kibana, integrations_server).
- **Up to a year** is backfilled on the first sync, and the last four days are re-read on each collection so late usage records are absorbed. A day is collected once it has ended.

Amounts are recorded in US dollars at Elastic's nominal rate of **1 ECU = $1.00**. Organizations that bought prepaid ECUs at a discount see the nominal value, not the negotiated price.

<insert [Cost graph grouped by service for an Elastic Cloud account, showing Capacity, Data Transfer Out and Snapshot Storage stacked by day] here>

## Prepaid ECU burndown

Organizations on prepaid consumption see their balance in the [credit burndown](../features/credit-burndown.md) section: one pot per active order line, with what was bought, what is left and when it expires, so the runway accounts for an order that lapses before it is spent. Reading the balance needs a Billing admin key.

## Tips & limits

- **This is not the OpenSearch plugin.** That one talks to a search cluster directly; this one manages Elastic Cloud itself. Use both if you want both.
- **Deployments are resized one tier at a time here.** Only the hot tier's size and zone count are editable; warm, cold, frozen and machine learning tiers, autoscaling limits and version upgrades stay in the Elastic Cloud console, where the plan editor shows the full topology.
- **Delete shuts a deployment down.** Elastic Cloud keeps shut-down deployments for a while before removing them; restore one from the console if you need it back.
- **Private connectivity filters are listed, not created.** Their rules need endpoint IDs from your cloud provider; create them in the Elastic Cloud console. Their name, description and default inclusion are still editable here.
- **Provider status** follows the Elastic Cloud status page, matched to your deployments and projects by region.
