---
title: Couchbase Capella
description: Manage Capella projects, clusters, App Services, buckets, credentials, backups, XDCR, users and API keys, with billed cost and prepaid credits.
sidebar_order: 50
---

The Couchbase Capella plugin talks to the Capella Management API v4 with one API key for one organization.

## What you can manage

- **Projects**: create, rename and describe, delete.
- **Clusters** (operational and free tier): state, cloud, region, CIDR, Couchbase Server version, service groups, support plan, deletion protection, connection string and bucket memory. Create a provisioned cluster (cloud, region from Capella's supported list, node size from the sizes that cloud offers, node count, disk, services, availability, support plan) or a free-tier cluster, delete, and:
  - **Edit** the name, description, support plan, deletion protection, and the node count and node size of the service group that runs the data service.
  - **Turn off** and **Turn on** (with its App Service). Sleep/wake schedules can drive these too.
  - **On/off schedule**: Capella's own weekly schedule, with a timezone, the days the cluster runs and its hours. **Remove schedule** deletes it.
  - **Audit logging** on or off, and **Load sample data**.
- **App Services**: create on a cluster, edit node count and size, turn on and off, delete.
- **Buckets**: create (type, storage backend, memory quota, replicas, durability, max TTL, flush), edit, delete, **Back up now**, set the weekly **Backup schedule**, and **Flush** when flush is enabled. Items, ops/sec, disk and memory used come with each bucket.
- **Scopes and collections**: create and delete, and edit a collection's max TTL.
- **Database credentials**: create with read or read-write access to all or picked buckets. Infrawrench keeps the password (generated or yours), so the credential's connection string output works; **Reset password** sets a new one.
- **Allowed CIDRs**: add a permanent or expiring range, delete.
- **Backups**: list with size and status, **Restore** into a cluster, delete.
- **XDCR replications**: pause, resume, delete. **Network peers** and **private endpoints** are listed; peers can be deleted.
- **Users**: invite with organization roles and a project role, change roles, remove.
- **API keys**: create with roles, allowed CIDRs and expiry (the token is shown once in the new resource's outputs), **Rotate**, revoke.

<insert [Couchbase Capella cluster detail page showing the Capacity section and the Turn off, On/off schedule and Load sample data buttons] here>

## Credentials

1. In the Capella UI open **Organization Settings → API Keys → Generate Key**.
2. Give it the **Organization Owner** role to manage everything and to read cost and prepaid credits. A key with **Project Owner** on a project can manage that project's clusters but not billing.
3. Add the address Infrawrench connects from to the key's **Allowed CIDRs** (or your bastion's).
4. Paste the token, then pick the **Organization** from the list Infrawrench loads with it.

<insert [Couchbase Capella Add-account form with the API Key Token field and the Organization picker] here>

## Cost and credits

Capella accounts feed [cost graphs & budgets](../features/cloud-costs.md) from Capella's billing API, so the amounts are what Capella bills:

- Daily, by billing category (operational compute and storage, backups, data transfer, private endpoints, App Services, analytics, AI services, Data API).
- Cluster spend carries the cluster as its resource, its region, and project and cluster tags. Spend not tied to a cluster (App Services, analytics, AI services) is the organization total minus the clusters' share.
- Organizations on prepaid credits report credit spend in place of currency.

Prepaid credit commitments appear in **credit burndown**, with what is left and when each expires.

## Metrics and logs

- Cluster Metrics show the bucket memory allocated against what the cluster has; bucket Metrics show items, ops/sec and disk and memory used. Capella reports these as current values, so Infrawrench samples them over time.
- The Logs tab on a cluster or project shows Capella's activity events (deployments, scaling, sign-ins, alerts), with a filter for warnings and critical events.

## Savings and security

- A bucket with no documents shows under **Potential savings**, as do inactive users.
- The security posture view flags clusters open to `0.0.0.0/0`, API keys usable from any address and clusters without deletion protection.
- Backups count towards each cluster's coverage on the Backups view.

## Status

Incidents from [status.couchbase.com](https://status.couchbase.com) appear against your resources. AWS incidents are matched to clusters in the affected region.

## Terraform export

Export to Terraform maps projects, provisioned clusters, buckets, scopes, collections, allowed CIDRs and App Services to the `couchbasecloud/couchbase-capella` provider, with its `key=value` import ids. Free-tier clusters, credentials, users and API keys are left out.

## Tips & limits

- The API allows 100 requests a minute per key, so a large organization takes a little longer to sync.
- Changing a cluster's node size or count rebalances it; it stays online but takes a while.
- Capella has no API listing regions or node sizes, so the create form offers the ones Capella documents for each cloud.
