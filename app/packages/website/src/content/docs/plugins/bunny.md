---
title: bunny.net
description: Manage bunny.net pull zones (purge, hostnames, SSL, edge rules, caching and security), Edge Storage with a file browser, DNS zones and records, Stream libraries, Edge Scripts and Magic Containers apps, and chart traffic, cache hit rate and spend.
sidebar_order: 50
---

Connect a bunny.net account to run its CDN, storage, DNS and edge compute from Infrawrench.

## What you can manage

- **Pull zones**: origin, tier, hostnames, this month's bandwidth and charges, and caching, security and geo settings. Create pull zones from an origin URL or a storage zone, and edit the origin URL, cache and browser cache times, query string handling, smart cache, Origin Shield, Optimizer, logging, origin SSL verification, the origin Host header, token authentication, blocked countries, allowed referrers, blocked IPs and which regions are served. Actions: **Purge URL**, **Purge by tag**, **Purge everything**, **Add hostname** and **Reset token key**.
- **Hostnames**: each hostname a pull zone answers on, whether it has a certificate, and Force SSL (editable). Add custom hostnames with a free certificate, request a certificate later with **Request free certificate**, and remove them.
- **Edge rules**: action, trigger, patterns and matching for every rule. Create, edit, enable, disable and delete rules. Rules with several triggers keep the extra ones when edited.
- **Storage zones**: region, replication regions, tier, size and file count, connected pull zones and 404 handling. Create zones (Standard or Edge tier, with replication regions picked from bunny.net's list), add replication regions, change 404 handling, **Reset password**, and delete. The **file browser** lists, uploads and deletes files and folders. The zone password and storage hostname are outputs you can export as environment variables.
- **DNS zones and records**: nameserver status, DNSSEC, logging and records. Create zones and records of every type bunny.net supports, edit records, turn DNSSEC and logging on or off, and delete. Zones and records also appear on the [Domains](../features/domains.md) page.
- **Stream libraries**: videos, storage and traffic, resolutions, player and security settings. Create libraries, edit their settings, **Reset API key**, and delete. The API key is an output.
- **Edge Scripts**: type, hostname, linked pull zones, and this month's requests, CPU time and cost. Create standalone or middleware scripts, rename them, **Publish latest code**, and delete.
- **Magic Containers apps**: status, endpoint, images, instances and regions. Change autoscaling, and **Restart**, **Deploy** or **Undeploy** an app. Apps can be put on a sleep schedule.
- **Account**: prepaid balance, this month's charges by product, and a **Purge a URL** action that works for any pull zone.

<insert [bunny.net pull zone detail page showing the Caching and security section and the Purge URL, Purge by tag and Purge everything actions] here>

## Credentials

In the bunny.net dashboard open **Account settings → API key** and copy the account API key. bunny.net has no scoped keys, so this one key manages everything. Storage zone files and Stream libraries use their own passwords and keys, which Infrawrench reads with the account key for you.

<insert [bunny.net Add-account form with the Account API Key field filled in] here>

## Metrics

- **Pull zones** (and the account, for all zones together): bandwidth, cached bandwidth, requests, cache hit rate, origin traffic, origin response time and 3xx, 4xx and 5xx responses, hourly for ranges up to three days and daily beyond.
- **Storage zones**: storage used and file count.
- **DNS zones**: queries, split into standard and smart queries.
- **Edge Scripts**: requests and CPU time.
- **Magic Containers apps**: CPU, memory, traffic, instances and latency.

## Costs and balance

The Costs page shows this month's spend split by product (CDN traffic per billing region, storage, DNS, Stream, scripting, containers and so on, with tax as its own charge type), and each earlier month as one total from bunny.net's monthly usage records. bunny.net bills by month, so amounts are dated to the first of each month. The account's prepaid balance is tracked as a credit balance with a burn rate and runway.

## Status

Open incidents on [status.bunny.net](https://status.bunny.net) show on the affected kind of resource: CDN incidents on pull zones, Edge Storage incidents on storage zones, DNS on DNS zones, and so on. API and dashboard incidents apply to everything.

## Terraform

Pull zones, hostnames, edge rules, storage zones, DNS zones and records, and Stream libraries export to the official `BunnyWay/bunnynet` provider with import IDs. Edge Scripts and Magic Containers apps are not exported, because their code and container templates are not part of the synced inventory.

## Limits

- Edit forms change the first trigger of an edge rule; more complex rules are easier to edit in the bunny.net dashboard.
- Storage zone replication regions can be added but not removed, and the main region cannot change.
- Edge Script code is edited in the bunny.net dashboard or deployed from your repository; Infrawrench publishes the latest saved code.
