---
title: Fastly
description: Track Fastly spend by product from invoices and the month-to-date bill, chart traffic per service, purge cache, activate versions, and manage services, domains, backends, logging endpoints, dictionaries, KV and config stores, TLS certificates and API tokens.
sidebar_order: 51
---

Connect your Fastly account to see what you spend, watch traffic, purge cache and manage your services without leaving Infrawrench.

## What you can manage

- **Account**: opens on your Fastly customer account. You see this month's bill so far by product, this month's billable usage by product (Compute requests, Image Optimizer, Next-Gen WAF, log streaming and the rest, in the units Fastly invoices), the last 12 months of posted invoices, and traffic across every service for the last 24 hours. The Metrics tab charts requests, bandwidth, cache hit ratio, 4xx and 5xx responses for the whole account. **Purge URL** purges one URL from any service.
- **Services**: delivery (VCL) and Compute services with their active and latest version, domains, backends and enabled products. Each service has:
  - a **Metrics** tab with requests, bandwidth, cache hit ratio, 4xx and 5xx responses, errors and origin offload, plus Compute requests and CPU time, Image Optimizer responses, Next-Gen WAF inspected and blocked requests and streamed log lines when the service uses them;
  - a **Live** panel with requests per second, throughput, hit ratio and errors over the last two minutes, and totals for the last 24 hours;
  - **Purge URL**, **Purge surrogate keys** (one or many, instant or soft) and **Purge everything** (asks you to confirm first);
  - **Activate version** (pick any version from the list), **Clone active version** to start a new draft, and **Deactivate**;
  - **Products** to turn Next-Gen WAF, Image Optimizer, Bot Management, DDoS Protection, Brotli compression, WebSockets, Fanout, Origin and Domain Inspector, Log Explorer & Insights and API Discovery on or off. Products are billed separately once enabled.
  - **Edit** to rename a service or change its comment. You can also create an empty service, or delete one that has no active version.
- **Service versions**: every version of every service. Activate, deactivate, clone, lock or validate a version, and edit its comment.
- **Domains**, **backends** and **logging endpoints** on each service's active version (or its newest version when none is active). Backends show the address, TLS and certificate-verification settings, shield POP, health check and timeouts. Logging endpoints show the destination type (S3, BigQuery, Datadog, Splunk, HTTPS and 23 more), where the logs go, the format and the condition. A backend that talks to its origin without TLS, or without verifying the origin's certificate, shows up on the [security posture](../features/posture-checks.md) page.
- **Edge dictionaries**: the dictionaries attached to each VCL service. In the **Keys** tab you can list, read, add, change and delete items without a new service version. Items in a write-only dictionary can be written but never read back.
- **KV stores** and **config stores**: browse and edit keys and values in the **Keys** tab, create stores, rename config stores and delete stores. A config store also shows which services use it.
- **Secret stores**: listed by name. Fastly never returns secret values.
- **TLS certificates** (custom certificates you uploaded) and **TLS subscriptions** (Fastly-managed certificates from Let's Encrypt, Certainly or GlobalSign) with their domains, state and expiry. Both appear on the [Expiring](../features/expiry-radar.md) page, and a certificate Fastly flags for key rotation shows up on the security posture page.
- **API tokens**: the token owner's tokens with their scope, services, last use and expiry. **Revoke** a token you no longer need (you can't revoke the token this account uses from here). Tokens appear in the [access review](../features/access-review.md), and global tokens that never expire are flagged on the security posture page.

<insert [Fastly service detail page showing the Live panel, the last-24-hours totals and the purge actions in the header] here>

## Connect an account

There's one field: an **API token**. Create one in Fastly under **Account > API tokens > Create Token**.

What the token can do depends on its **scope** and its **owner's role**:

| You want                                                     | Scope          | Owner role            |
| ------------------------------------------------------------ | -------------- | --------------------- |
| Services, stores, TLS, tokens and traffic charts             | `global:read`  | any                   |
| Cost data                                                    | `global:read`  | Billing or Superuser  |
| Purge by URL and surrogate key                               | `purge_select` | any                   |
| Purge everything                                             | `purge_all`    | any                   |
| Activate versions, edit services and stores, enable products | `global`       | Engineer or Superuser |

Scopes combine: `global:read purge_all` reads everything and can purge. **Check credentials** on the add-account form or the account page tells you which of these your token can do. Its [least-privilege generator](../core-concepts/credential-preflight.md) tells you which token settings to choose for the features you tick. A token limited to some services only shows those services. If you narrow a token later, what Infrawrench already stored for a type or a service the token can no longer read stays listed with its last known details instead of disappearing. The desktop app keeps nothing between syncs, so there a type the token can't read shows the refusal instead.

<insert [Fastly Check credentials panel listing inventory and costs as OK and purge and change configuration as missing for a global:read token] here>

## Costs

Fastly bills monthly and doesn't publish daily costs, so costs are monthly, dated to the first of the month, and broken down by product. Each row is tagged with the invoice's region and the product line and group (Network Services, Security, Compute). Credits, tax and support lines are kept separate.

- **Past months** come from your posted invoices and match them line for line.
- **The current month** is the month-to-date bill from Fastly's billing page. It's refreshed regularly and replaced by the invoice once the month closes. Until that invoice posts (usually in the first days of the month), last month keeps its final month-to-date figures.

Invoices don't split cost by service. For per-service numbers, use each service's traffic charts and the account's **Billable usage this month** table for quantities by product.

## Status

Incidents come from Fastly's status page. Incidents at a POP show under the POP code, product incidents (Compute, Object Storage, Image Optimizer, Next-Gen WAF, log streaming, TLS) under the product, and API or delivery incidents against every Fastly resource.

## Limits

- Changing a service's domains, backends or logging endpoints needs a new service version. Clone the active version here, then edit and activate it in Fastly or with the Fastly CLI.
- Upload certificates and create TLS subscriptions in Fastly.
- Large accounts refresh in turns. Each sync reads full details for up to 2,000 services, logging endpoints for 100 services and dictionaries for 500, starting somewhere different each time. The rest keep their last values until their turn comes.
