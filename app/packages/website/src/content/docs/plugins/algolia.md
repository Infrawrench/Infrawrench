---
title: Algolia
description: Manage Algolia indices and their settings, API keys, A/B tests and crawlers, with usage, search analytics, cluster latency, API logs and cluster status.
sidebar_order: 51
---

Algolia is hosted search. Each Algolia account you add in Infrawrench is one Algolia application.

## What you can manage

- **Application**: application ID, number of indices, total records and data size, API key count, the allowed sources on the Admin API key, and (with a Monitoring API key) the Algolia clusters the application runs on. The application ID, search host and Admin API key are outputs. The **Algolia environment variables** export writes `ALGOLIA_APP_ID` and `ALGOLIA_ADMIN_API_KEY` into a Kubernetes secret or a server's environment.
- **Indices**: records, data and file size, last build time, primary or replica, synonym and rule counts, any A/B test, and the top searches and searches with no results over the last week. Edit searchable attributes, custom ranking, facets, attributes to retrieve and hide, replicas, hits per page, pagination limit, typo tolerance, distinct, plurals, stop words, query and index languages, prefix matching, word removal, rules, personalization and search mode. Use the **Manifest** tab to edit the full settings JSON for anything else. **Copy index** copies everything or just the configuration, **Move into** swaps one index onto another, and **Clear records** empties an index but keeps its configuration. Create an index empty with its first settings, or start from another index's configuration.
- **API keys**: description, ACL, allowed indices, referrers, forced query parameters, rate and hit limits, and expiry. Create a key by picking permissions and indices from lists, edit any of those, or delete it. The key value is a sensitive output. Expiring keys show on the [expiry radar](../features/expiry-radar.md).
- **A/B tests**: status, the two indices and the traffic split, click-through for each variant, and significance. Create a test between two indices with a traffic split and end date, stop it, or delete it.
- **Crawlers** (needs crawler credentials): status, start URLs, schedule, index prefix, crawled URLs by outcome and any blocking error. Resume, pause, start a full recrawl, or delete. Crawlers can go on a [sleep schedule](../features/sleep-schedules.md).

The application and each index have a **Logs** tab with Algolia's API logs. Filter by all, query, build or error.

## Connect your account

Get your keys from **Settings > API Keys** in the [Algolia dashboard](https://dashboard.algolia.com/account/api-keys):

- **Application ID** and **Admin API Key** (required). Managing API keys needs the Admin API key itself.
- **Usage API Key** (optional, in the Usage section): adds usage charts.
- **Monitoring API Key** (optional, in the Monitoring section, on plans with monitoring): adds the application's clusters, their latency and indexing time, and links Algolia's cluster incidents to this application.
- **Analytics Region** (optional): United States or Germany, wherever the application's analytics live. Leave it empty to let Algolia choose.
- **Crawler User ID** and **Crawler API Key** (optional): from the settings page of the [Crawler](https://crawler.algolia.com/admin/), to manage crawlers.

<insert [Algolia Add-account form with the application ID, Admin API key and the optional usage and monitoring keys] here>

## Metrics

- **Application**: search and write operations, records, data size, average, p90 and p99 processing time, peak QPS, search capacity used and queries degraded by capacity (Usage API key), plus search latency and indexing time per cluster (Monitoring API key).
- **Index**: search and write operations, records, data size and processing time (Usage API key), and daily searches, users, no-result rate and click-through rate from Search Analytics (needs the analytics ACL, and click-through needs click events).

Ranges up to a week are hourly. Longer ranges are daily.

<insert [Algolia index detail page showing the Metrics tab with searches, no-result rate and click-through rate] here>

## Status

Algolia incidents show in [provider status](../features/provider-status.md). Incidents are per Algolia cluster, so they're linked to your application only when you add a Monitoring API key.

## Export to Terraform

You can [export](../features/terraform-export.md) primary indices and API keys to Terraform for Algolia's `algolia/algolia` provider. Indices import by name. API keys import by their value, which isn't written into the export, so copy it from the key's output.

## Limits

- Algolia has no billing API, so there's no cost data. The Usage API counts operations, not money.
- Index settings sync for the first 150 indices. In larger applications, edit the rest through the Manifest tab.
- A/B tests need a plan that includes them, plus the analytics ACL. You can't change a test's settings after creating it, only stop it.
- Moving an index replaces the destination entirely.
