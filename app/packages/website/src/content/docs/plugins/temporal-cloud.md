---
title: Temporal Cloud
description: Track Temporal Cloud spend by namespace from billing reports, chart namespace metrics, and manage namespaces, export sinks, users, service accounts, API keys, Nexus endpoints and connectivity rules.
sidebar_order: 50
---

## What you can manage

- **Namespaces**: create one with a region picker, retention, API key or mTLS authentication and delete protection. Edit the retention period (1 to 90 days, checked before it is sent), description, delete protection, API key authentication, codec server endpoint, task queue fairness and tags. Each namespace shows its gRPC and web endpoints, regions and replicas, actions-per-second limit, capacity mode and its 7-day actions-per-second average, p90 and p99.
- **Custom search attributes**: add one (name and type, with Temporal Cloud's per-type limits checked first) or rename an existing one. Temporal Cloud does not support removing a custom search attribute, so there is no remove button.
- **High availability**: add a replica region to a namespace, fail a multi-region namespace over to its replica (you type the namespace name to confirm), or remove a passive replica.
- **Connectivity rules**: create public (optionally with stable IPs) or private rules (AWS PrivateLink, GCP Private Service Connect), see which namespaces use each rule, and choose a namespace's rules from its **Connectivity rules** button.
- **Export sinks**: workflow history export to S3 or GCS, with health and last export time. Create, edit the destination, enable or disable, validate access, and delete.
- **Users**: invite by email with an account role, change the role, grant or remove namespace access, and remove the user.
- **Service accounts**: create account-scoped (account role plus namespace access) or namespace-scoped service accounts, rename, change role and access, delete.
- **API keys**: metadata only (owner, expiry, state). Rename, disable or enable, and delete. Keys appear on the expiry radar and the access review, where **Revoke** disables the key.
- **Nexus endpoints**: create with a target namespace and task queue and pick the namespaces allowed to call it; edit and delete.

## Credentials

- **API Key**: a Temporal Cloud API key, ideally owned by a service account. Its account role decides what works:
  - **Admin** (or Owner) manages namespaces, identities, Nexus endpoints and connectivity rules.
  - **Owner** or **Finance Admin** is needed for billed cost (billing reports).
- **Metrics API Key** (optional): a service account key with the **Metrics Read-Only** role for namespace metrics. Leave it empty to use the main key.
- **Plan** and the three **price** fields (optional): only used when cost has to be estimated (see below). Leave them empty for the published prices.

Use **Check credentials** on the account to see which of these the key can do.

<insert [Temporal Cloud Add-account form with the API key, metrics key, plan and price fields] here>

## Costs

Infrawrench generates Temporal Cloud **billing reports** through the Cloud Billing API and reads the CSV. Every charge is attributed to its namespace, broken down by usage dimension (actions, active storage, retained storage, plan and support) and carries the namespace's tags, so tags you set on a namespace become a cost breakdown. Rows are daily for the current and previous two months and monthly before that (up to 11 months back). The current month is re-read on every collection until it closes.

If the key cannot create billing reports, or a report does not finish in time, the last 90 days are **estimated** instead: daily usage per namespace from Temporal Cloud, priced at the published rates (actions at $50 per million, with volume tiers on Business and above; active storage at $0.042 and retained storage at $0.00105 per GB-hour; the plan charge). Estimated rows carry the tag `cost_source=estimated` and billed rows `cost_source=billed`, so you can tell them apart in any cost view, and the next collection that gets a report replaces the estimates. Edit the account to set your contracted rates.

## Metrics

A namespace's Metrics tab reads Temporal Cloud's OpenMetrics endpoint: actions per second and the limit, throttled actions, workflow successes, failures, timeouts, cancellations and terminations, open workflows, activity failures, workflow schedule-to-close and service latency percentiles, service errors, task backlog, tasks that found no poller, schedule start delay and replication lag.

The endpoint only reports the latest minute, so the chart builds up history while the namespace is pinned to a dashboard. Temporal Cloud does not publish a schedule-to-start latency metric; task backlog, tasks with no poller and schedule start delay are the closest signals.

<insert [A Temporal Cloud namespace detail page with the Fail over, Add search attribute and Connectivity rules buttons] here>

## Notes

- Every change in Temporal Cloud is asynchronous. Infrawrench waits briefly for it to finish; slow changes (a new namespace, a failover) may still show as activating or updating for a minute.
- A namespace with delete protection on cannot be deleted; turn protection off with **Edit** first.
- Turning off API key authentication is refused when the namespace has no mTLS CA certificate, since no client could connect.
- [Export to Terraform](../features/terraform-export.md) writes `temporalio/temporalcloud` resources for namespaces, users, service accounts, Nexus endpoints and connectivity rules.
- The Temporal status page feeds [provider status](../features/provider-status.md) by region.
