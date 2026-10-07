---
title: DataStax Astra
description: Manage Astra DB Serverless databases, keyspaces, collections, access lists, CDC and PCU groups, plus Astra Streaming tenants, roles, users and tokens.
sidebar_order: 50
---

The DataStax Astra plugin talks to the Astra DevOps API, the Astra Streaming API and each database's Data API, all with one application token.

## What you can manage

- **Databases** (Astra DB Serverless, vector or non-vector): status, cloud, regions, keyspaces, storage, API endpoint, access-list state and PCU groups. Create (name, type, cloud and region from the regions Astra offers your organization, keyspace, optional PCU group), terminate, and:
  - **Enforce the access list** from Edit. Infrawrench refuses to enforce an empty list, which would lock every client out.
  - **Resume** a hibernated database.
  - **Secure connect bundle**: download links for CQL drivers, for the primary region or every region.
- **Regions**: add a region to a database (same cloud), terminate one, **assign or move it to a PCU group**, remove it from one, and set the **private link principals** allowed to connect.
- **Keyspaces**: create and drop (the default keyspace cannot be dropped).
- **Collections** (Data API): list with vector dimension, similarity metric, embedding provider, lexical search and reranking settings, an estimated document count, and create or delete. Only active databases are read: a Data API request wakes a hibernated database.
- **Access list entries**: add an address or CIDR, enable or disable it, change its description, delete it.
- **CDC tables**: stream a table's changes into an Astra Streaming tenant in the same region, and turn it off again.
- **Private endpoints**: register an endpoint you created in your cloud account against a region's private link service, edit its description, delete it.
- **Snapshots**: the backups Astra keeps for each database, and **Clone into a database** to restore one into another database.
- **PCU groups**: reserved and burst capacity. Create, edit title, description and reserved, minimum and maximum PCUs, **Park** and **Unpark**, delete. Park and unpark also drive sleep/wake schedules.
- **Streaming tenants**: create on a streaming cluster with an owner picked from your users, delete. The broker and admin URLs are outputs.
- **Roles**: create custom roles with permissions picked from Astra's list and the resources they apply to, edit them, delete them. Default roles are read-only.
- **Users**: invite with roles, change roles, remove.
- **Application tokens**: generate with roles (the token is shown once, in the new resource's outputs), revoke.

<insert [DataStax Astra database detail page showing the Capacity and Connectivity sections and the Resume and Secure connect bundle buttons] here>

## Credentials

Generate an **application token** in the Astra Portal under **Settings → Tokens → Generate token**, and copy the `AstraCS:…` value.

- **Organization Administrator** covers everything the plugin does, including users, roles and tokens.
- **Database Administrator** is enough for databases, regions, keyspaces, collections and access lists.
- Metrics need a paid plan and a role with the **Manage Metrics** permission.

<insert [DataStax Astra Add-account form with the Application Token field] here>

## Metrics

The database Metrics tab shows requests per second, CQL connections, read, write and range-read latency (p99 and p50), read and write failures and timeouts, rate-limited requests and tombstone failures. PCU groups show CPU and cache utilization, read latency and PCUs in use. Astra publishes these as current values from its Prometheus scrape endpoint, so Infrawrench samples them over time. On the Free plan the tab stays empty.

## Savings, security and backups

- A hibernated database shows under **Potential savings**, as does an active PCU group with no database on it.
- The security posture view flags databases whose access list is not enforced and enabled `0.0.0.0/0` entries.
- Snapshots count as backups of their database on the Backups view.
- Users and tokens appear on the access review, with Organization Administrator holders marked as admins.

## Status

Incidents from [status.astra.datastax.com](https://status.astra.datastax.com) appear against your resources. AWS and Azure incidents are matched to databases in the affected region.

## Terraform export

Export to Terraform maps databases, keyspaces, custom roles, streaming tenants and PCU groups to the `datastax/astra` provider, with import ids. Tokens are left out because their secret cannot be read back, and access lists because Terraform manages them as one block per database.

## Tips & limits

- Astra has no cost or usage API for ordinary organizations (consumption reports need an enterprise token), so Astra spend does not appear in cost graphs.
- A newly created database takes a few minutes to become active; collections appear once it is.
- Streaming namespaces, topics, sinks and sources are not listed yet.
