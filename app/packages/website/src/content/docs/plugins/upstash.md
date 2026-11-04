---
title: Upstash
description: Manage Upstash Redis databases, Vector and Search indexes, QStash schedules, queues and URL groups, and teams, with stats, daily spend, limits and a Redis console.
sidebar_order: 50
---

Connect an Upstash account to manage its serverless Redis databases, Vector and Search indexes, and QStash messaging from one place.

## What you can manage

- **Redis databases**: cloud, primary and read regions, plan, monthly budget, eviction, auto upgrade, daily backup, TLS, limits and this month's storage, requests, bandwidth and cost.
  - Create a database (cloud, region and read regions from pickers, plan, budget, and what happens when it's full).
  - Edit the name, budget, eviction, auto upgrade and daily backup.
  - Actions: **Change plan**, **Read regions**, **Back up now**, **Restore backup**, **Delete backup**, **Reset password**, **Enable TLS** and **Move to team**.
  - The host, port, password, connection string, REST URL and REST tokens are outputs, and the database opens in the Infrawrench Redis console.
- **Vector indexes**: region, plan, dense, sparse or hybrid type, similarity, dimensions, embedding models, limits and usage this month. Create indexes (with Upstash's hosted embedding models or your own vectors), rename them, **Change plan**, **Reset tokens** and **Move to team**. The REST URL and tokens are outputs.
- **Search indexes**: region, plan, limits and usage. Create, rename, **Reset tokens**, **Move to team** and delete.
- **QStash**: one entry per region your account uses, with its plan, budget, limits (and how many schedules, queues and URL groups use them), the dead letter queue with **Retry** and **Delete** per message, and the message log.
  - Edit the monthly budget.
  - Actions: **Change plan**, **Enable/Disable production pack**, **Retry all failed**, **Purge dead letter queue**, **Rotate signing keys**, **Reset token** and **Move to team**.
  - The QStash URL, token and both signing keys are outputs, so you can export `QSTASH_TOKEN` and the signing keys to a server or Kubernetes secret.
  - A **Publish** tab sends a message to any URL.
- **Schedules**: cron, destination, method, retries and the last and next run. Create schedules (with body, retries, delay and callback), **Pause**, **Resume** and delete.
- **Queues**: parallelism, waiting messages and paused state. Create queues, edit the parallelism, **Pause**, **Resume**, delete, and enqueue messages from the **Publish** tab.
- **URL groups**: endpoints. Create groups, edit the endpoint list, delete, and publish to every endpoint from the **Publish** tab.
- **Teams**: members and roles. Create and delete teams, **Add member** and remove members.
- **Account**: the audit log in the Logs tab.

<insert [Upstash Redis database detail page showing the Database, Limits and This month sections with the Change plan and Read regions actions in the header] here>

## Connect your account

Enter your Upstash **email** and a **Developer API key**. Create the key in the [Upstash console](https://console.upstash.com/account/api) under **Account > Developer API**. Choose **Read/Write** to manage resources from Infrawrench, or **Read Only** to just watch them.

Only accounts created on upstash.com can use the Developer API. Accounts created through the Vercel or Fly.io integrations can't, so they can't be connected here.

You never need to paste a QStash token. Infrawrench gets each region's token for you.

<insert [Upstash Add-account form with the Email and Developer API Key fields filled in] here>

## Metrics

Redis databases chart throughput, reads, writes, connections, keys, disk use, mean and P99 latency, cache hits and misses and bandwidth. Vector and Search indexes chart query and update throughput, latency, vector or document count and data size. QStash charts messages. Chart detail depends on the range you pick.

## Costs

Upstash reports a daily cost for each Redis database and each regional QStash account, shown per resource, region and service. Upstash only keeps about a week of daily figures, so history starts one week before you connect and grows from there. Vector and Search only report a month-to-date total, which shows on their detail pages but not on the Costs page.

## Limits and quotas

QStash schedules, queues and URL groups are tracked against your plan's limits, and each Redis database's storage against its storage limit, on the Quotas page.

## Status

Incidents on [status.upstash.com](https://status.upstash.com) show on the matching resources. Redis, Vector and QStash incidents are matched by product and region, and Upstash Console incidents apply to everything.

## Terraform

**Export to Terraform** writes `upstash/upstash` provider blocks for Redis databases (with an import id), Vector and Search indexes, QStash schedules and URL groups. The provider can't import Vector, Search or QStash resources, so applying those blocks creates new ones. The export notes this in a comment.

## Quirks

- TLS can't be turned off once it's on, and new databases always have it.
- Changing a Redis database's read regions replaces the whole list. Read regions must be on the same cloud as the primary region.
- Resources you can see through a team appear as long as your key can list them. You can't undo moving a resource to a team from here.
