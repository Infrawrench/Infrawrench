---
title: Confluent Cloud
description: Track Confluent Cloud spend by product, environment and resource, chart Kafka throughput, consumer lag and CKU utilization, resize clusters, pause and resume connectors, manage Flink compute pools, service accounts and API keys, and browse topics through the Kafka plugin.
sidebar_order: 51
---

The Confluent Cloud plugin manages your Confluent organization itself: environments, Kafka clusters, connectors, Flink, ksqlDB, Schema Registry, identities, networking and cost. It is separate from the [Kafka](./kafka.md) plugin, which connects to any Kafka cluster over the Kafka protocol; a Confluent cluster hands a connection to the Kafka plugin so you can browse its topics without adding it twice.

## What you can manage

- **Environments**: create, rename and delete environments, and change the Stream Governance package (Essentials or Advanced).
- **Kafka clusters**: every cluster in every environment, with its type (Basic, Standard, Enterprise, Freight or Dedicated), cloud, region, availability and capacity, plus topic and partition counts, retained bytes and the bytes produced and consumed over the last 7 days. The Metrics tab charts bytes and records in and out, requests, retained bytes, partitions, active connections, maximum consumer lag, and for Dedicated clusters the CKU count and CKU utilization (cluster load). **Resize** opens a picker of CKU counts for a Dedicated cluster (multi-zone clusters start at 2); elastic clusters get **Change eCKU limit** to move their ceiling. Rename a cluster or delete it from the detail page.
- **Topics and consumer groups**: the cluster's **Kafka** tab is the [Kafka](./kafka.md) plugin's browser, connected over SASL/PLAIN with a cluster API key. Click **Create Kafka API key** once: Confluent only reveals a key's secret when it is created, so Infrawrench creates the key and stores the secret with the account. Leave the owner empty to create the key for whoever owns the account's Cloud API key, or pick a service account and let Infrawrench grant it CloudClusterAdmin on the cluster.
- **Connectors**: fully managed connectors under their cluster, with their connector class, state, tasks, failed tasks, the last error and records moved in the last 7 days. **Pause**, **Resume**, **Restart** and delete. Pausing stops data but not task-hour billing; delete a connector to stop paying for it.
- **Flink compute pools**: create a pool in any Flink region (picked from Confluent's list), change its CFU ceiling, delete it, and chart current CFUs against the limit and CFU minutes consumed.
- **ksqlDB clusters**: CSUs, status, the Kafka cluster each reads from, and charts of CSUs, query saturation, storage utilization, processing errors and bytes consumed. Delete a cluster you no longer need.
- **Schema Registry**: each environment's registry with its package, region and endpoints, and charts of registered schemas and requests.
- **Service accounts**: create one, edit its description, and delete it. Service accounts appear on the [access review](../features/access-review.md).
- **API keys**: Cloud keys and cluster keys with their owner and scope. Rename a key, edit its description, or delete it to revoke it. Secrets are never shown again after creation.
- **Networks and private connections**: networks with their CIDR, zones, connection types and DNS domain, and their peerings, transit gateway attachments, private link accesses and private link attachments.
- **Encryption keys**: self-managed keys registered for cluster storage, with provider, state and validation.

## Credentials

- **Cloud API key** and **Cloud API secret**: create them under **Administration → Cloud API keys** in the Confluent Cloud Console. Use a Cloud API key, not a key scoped to one cluster: only Cloud keys can call the management, billing and metrics APIs.

<insert [Confluent Cloud Add-account form with the Cloud API key and secret fields filled] here>

### Roles

A Cloud API key acts with the role bindings of the user or service account that owns it. The safest setup is a dedicated service account for Infrawrench that owns the key. **Check credentials** on the add-account form or the account page probes one read per capability, and its [least-privilege generator](../core-concepts/credential-preflight.md) prints the Confluent CLI commands that bind the roles you select.

| Capability       | Role (organization scope) |
| ---------------- | ------------------------- |
| Inventory        | Operator                  |
| Cost data        | BillingAdmin              |
| Metrics          | MetricsViewer             |
| Service accounts | AccountAdmin              |
| Encryption keys  | OrganizationAdmin         |

Resizing clusters, pausing connectors and managing Flink compute pools need EnvironmentAdmin on the environment (or OrganizationAdmin); creating environments needs OrganizationAdmin. A role that is missing only hides what it covers: a key without MetricsViewer still lists everything, just without the usage figures and charts.

## Costs

Daily cost comes from Confluent's Billing Costs API and appears on the [Costs](../features/cloud-costs.md) panel and in cost reports:

- **Service** is the product: Kafka, Connect, Custom Connectors, ksqlDB, Flink, Schema Registry, Stream Governance, Cluster Linking, Audit Log, Tableflow and Support.
- **Resource** is the Kafka cluster, connector, compute pool, ksqlDB cluster or Schema Registry the line was billed to, so the same id links cost to the inventory.
- **Region** is the billed resource's region, filled in from the inventory because the Costs API does not report one.
- **Tags** carry the environment, the line type (CKUs, storage, ingress, egress, connector tasks, CFUs and so on), the network access type (internet, private link, peering, transit gateway) and the cloud.
- Amounts are net of discounts. Promotional credits are separate rows with the **credit** charge type, and the support plan uses the **support** charge type.

The Costs API keeps a year of history and data can take up to 72 hours to arrive, so the last few days are re-read on every pass. Confluent exposes no API for the remaining balance of promotional credits or a commitment, so those do not appear on the credit burndown.

## Savings

- **Idle resources**: the [orphan finder](../features/orphan-finder.md) flags Kafka clusters with no bytes produced or consumed in 7 days, connectors that moved no records in 7 days (they bill per task-hour regardless), and networks Confluent reports as idle. A resource is only flagged when the Metrics API measured it; without MetricsViewer nothing is flagged.
- **Oversized Dedicated clusters**: [right-sizing](../features/right-sizing.md) compares p95 CKU utilization with the cluster's CKU count and recommends fewer CKUs when the load would still fit with headroom. The saving is priced from what your organization actually paid per CKU-hour at that cloud, region and availability over the last month, so it needs BillingAdmin too. Applying it resizes the cluster online.

## More

- [Provider status](../features/provider-status.md) follows status.confluent.cloud. Incidents that name a region (for example "AWS us-east-1" or "Azure East US") are matched to your resources in that region; the rest apply to every Confluent resource.
- [Export to Terraform](../features/terraform-export.md) writes `confluentinc/confluent` resources for environments, Kafka clusters, Flink compute pools and service accounts, each with its import id.
