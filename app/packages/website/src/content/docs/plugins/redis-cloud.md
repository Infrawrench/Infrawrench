---
title: Redis Cloud
description: Manage Redis Cloud Pro and Essentials subscriptions and databases, ACLs and private connectivity, with billed cost from the Redis Cloud cost report.
sidebar_order: 50
---

The Redis Cloud plugin talks to the Redis Cloud REST API. It is separate from the [Redis](./redis.md) plugin, which connects to a single Redis server with a connection string; every Redis Cloud database hands its connection to that plugin, so the console and key browser are the same ones you already know.

## What you can manage

- **Subscriptions**, Pro and Essentials: cloud, region, deployment type, shard count and type, plan, list price per month, payment method. Rename either kind. On Pro, turn public endpoint access on or off, set **maintenance windows** and the **CIDR allow list**, see the pricing lines, and accept or reject **Transit Gateway invitations**. On Essentials, **change plan** from the plans compatible with the subscription.
- **Databases**: memory limit and dataset size, memory used, provisioned throughput, shards, capabilities (modules), replication, persistence, eviction policy, TLS, the default user, allowed source IPs, public and private endpoints, alerts and backup settings. Create, edit, delete, and:
  - **Resize memory** (Pro). The form refuses anything smaller than the data already stored plus 10% headroom, and has a dry-run option that asks Redis Cloud to validate the change without applying it. Essentials databases change size through **Change plan size**, which only lists plans that fit the stored data.
  - **Alerts**: every alert type the database's plan supports, with the ranges Redis Cloud accepts.
  - **Back up now**, to the configured location or a one-off path.
  - **Import data** from S3, Google Cloud Storage, Azure Blob Storage, HTTP, FTP or another Redis database.
  - **Upgrade Redis version**, from the versions Redis Cloud offers for that database.
  - **Tags**, which carry through to the cost report and therefore to cost allocation here.
  - **Flush** (Pro).
- **Redis tab**: the console and key browser of the [Redis](./redis.md) plugin, connected with the database's default user. It needs a reachable endpoint: the public endpoint, or a [bastion](../features/bastion-vms.md) inside the network you peered with Redis Cloud.
- **VPC peerings** (AWS and Google Cloud): create with a region picker, edit the routed CIDRs (AWS), delete. Pending peerings say what to do on your side.
- **Transit Gateways** (AWS): attach, detach and edit routed CIDRs.
- **Private Service Connect endpoints** (Google Cloud): create (the service is set up for you when the subscription has none), see the gcloud creation and deletion scripts, accept, delete.
- **ACL rules, roles and users**: create and edit each. Roles pick their rule and databases from lists; users pick their role.
- **Cloud accounts** registered for deploying Pro subscriptions into your own AWS account.
- **Account**: API key owner, payment methods, team members and their roles, and the most recent asynchronous tasks.

<insert [Redis Cloud database detail page showing the Capacity section, the Right-sizing hint, and the Resize memory, Alerts and Back up now buttons] here>

## Credentials

Redis Cloud needs two keys, both from **Access Management → API Keys** in the Redis Cloud console. The API is off by default: enable it there first.

- **Account key**: identifies the Redis Cloud account.
- **User key**: belongs to one team member and carries their role. Cost data needs **Owner**, **Viewer** or **Billing admin**; changes need **Owner**. If the key has a CIDR allow list, add the address Infrawrench connects from (or your bastion's).

<insert [Redis Cloud Add-account form with the Account Key and User Key fields] here>

## Cost graphs

Redis Cloud accounts feed [cost graphs & budgets](../features/cloud-costs.md) from the Redis Cloud **cost report** (FOCUS format), so the amounts are what Redis Cloud bills:

- Broken down by tier (Pro, Essentials, network and minimum-charge lines apart), region, and the database or subscription each line belongs to. Database tags and the resource name and type come through as tags.
- Each report line covers a period (a Pro database's hours between configuration changes, an Essentials plan's month). Infrawrench spreads the line evenly across the days in that period.
- Monthly network charges for Pro subscriptions take up to 72 hours to appear, so the last five days are re-read on every collection.
- If the user key's role cannot generate reports, Infrawrench prices today's inventory at list instead (shard-hours for Pro, the plan price for Essentials), tags those rows `costBasis: list-price-estimate`, and does not backfill earlier days from it. Switch to a key with the Owner, Viewer or Billing admin role for billed numbers.

## Metrics

Redis Cloud's API has no metric history, so the database Metrics tab combines three sources, each a current reading that Infrawrench samples over time:

- **Memory used** and **memory used of limit**, from the API, for every database.
- **Ops/sec, read and write latency, connections, evictions, expirations, hit ratio, keys and traffic** from the Pro subscription's Prometheus endpoint. That endpoint is on Redis Cloud's internal network, so it answers only through private connectivity, for example a bastion in the peered VPC.
- **Redis ·** series (ops/sec, clients, memory, evictions, hit ratio, command latency) from INFO over the database's endpoint, through the Redis tab's connection. This is what fills the tab for Essentials databases.

## Savings and security

- A paid database holding less than 5 MB shows under **Potential savings**.
- A Pro database using under a quarter of its dataset limit shows a **Right-sizing** hint with a smaller size, prefilled in Resize memory.
- The security posture view flags databases that do not require TLS, accept any source IP, or have no persistence, and Pro subscriptions with public endpoint access on.

## Logs

- A database's Logs tab has the **slow log** and the account **system log** filtered to that database.
- The account's Logs tab has the full **system log** and the **session log** (console sign-ins).

## Terraform export

Export to Terraform maps ACL rules, roles and users (passwords as variables), Essentials subscriptions and Pro databases to the `RedisLabs/rediscloud` provider. Pro subscriptions are left out: the provider needs the original sizing plan, which Redis Cloud does not report.

## Tips & limits

- Writes in Redis Cloud are asynchronous. Infrawrench waits a few seconds for each one; a resize or import that takes longer reports that it was submitted, and a refresh shows the result.
- Listing VPC peerings, Transit Gateways and Private Service Connect is itself asynchronous in the API, so those lists take a few seconds longer than the rest.
- Active-Active subscriptions list their peerings; their per-region Transit Gateway and Private Service Connect setup stays in the Redis Cloud console.
- The API allows 400 requests a minute per key.
