---
title: Dynatrace
description: Browse Dynatrace hosts, services, process groups, web applications and Kubernetes clusters with their metrics and logs, triage problems, manage SLOs, synthetic monitors, alerting profiles, maintenance windows and access tokens, run DQL against Grail, and track platform subscription cost.
sidebar_order: 50
---

Connect a Dynatrace environment to see what it monitors, act on what it finds, and keep its configuration next to the rest of your infrastructure.

## What you can manage

- **Environment**: its version, how many hosts, services and web applications it monitors, how many problems are open, and this month's platform subscription cost by capability. With a platform token, a **Query** tab runs DQL against Grail.
- **Hosts**: every host OneAgent monitors, with OS, CPU cores, memory, monitoring mode, IP addresses, host group, OneAgent version, tags and management zones. Metrics and Logs tabs.
- **Process groups** and **services**: what runs where. Services link to the process groups they run in, and process groups to their hosts, so the dependency graph shows the whole chain. Services have Metrics and Logs tabs.
- **Web applications** (Real User Monitoring) with user action metrics, and **Kubernetes clusters** monitored by the Dynatrace Operator.
- **Problems**: everything Davis raised in the last seven days, with severity, impact, root cause, affected entities and comments. **Add comment** and **Close problem** from the problem page.
- **Service-level objectives**: current value, target, warning threshold and error budget. Create, edit, turn off and on, and delete SLOs.
- **Synthetic monitors**: HTTP and browser monitors with their locations and frequency. Create HTTP monitors (pick locations from a list), turn monitors off and on, delete them, and chart availability.
- **Alerting profiles**: set how long a problem of each severity stays open before your notification integrations hear about it. Create, edit and delete profiles.
- **Maintenance windows**: once, daily, weekly or monthly windows that pause alerting or problem detection, optionally for tagged entities only. Create, edit, turn off and on, and delete them.
- **Access tokens**: owner, scopes, expiry and last use for every token in the environment. Rename, turn off and on, or revoke them. Expiring tokens show on the Expiry radar.

<insert [Dynatrace environment detail page showing the environment counts, the Cost section by capability and the Query tab] here>

## Connect your environment

1. **Environment URL**: copy it from your browser. `https://<id>.apps.dynatrace.com` and `https://<id>.live.dynatrace.com` both work. For Managed or an Environment ActiveGate, use `https://<host>/e/<environment-id>`.
2. **Access token** (required): in Dynatrace, open **Access Tokens** and select **Generate new token**. Add these scopes: `entities.read`, `problems.read`, `problems.write`, `metrics.read`, `slo.read`, `slo.write`, `ExternalSyntheticIntegration`, `settings.read`, `settings.write`, `apiTokens.read`, `apiTokens.write` and `logs.read`. **Check credentials** shows exactly which features are missing a scope.
3. **Platform token** (optional, SaaS only): at [myaccount.dynatrace.com](https://myaccount.dynatrace.com/platformTokens), select **Platform token**, pick this environment, and add `storage:buckets:read` plus the `storage:*:read` scopes for the data you want to query (`storage:logs:read`, `storage:events:read`, `storage:bizevents:read`, `storage:spans:read`, `storage:metrics:read`, `storage:entities:read`). It turns on DQL and host and service logs from Grail.
4. **Cost** (optional, under Advanced options): in **Account Management > Identity & access management > OAuth clients**, create a client with the **View usage and consumption** (`account-uac-read`) account permission. Enter the account UUID (from the Account Management address bar), the client id and the client secret.

<insert [Dynatrace Add-account form with the Environment URL, Access Token and Platform Token fields filled in and Advanced options expanded] here>

## Metrics

- **Hosts**: CPU usage, memory usage, the fullest disk, network in and out.
- **Services**: response time, requests and failure rate.
- **Web applications**: user actions and speed index.
- **Synthetic monitors**: availability across locations.

If your environment doesn't record a metric (no RUM, or a host in infrastructure-only mode), it's left out.

## Logs

Hosts and services have a Logs tab with the last 24 hours. Add a platform token to read logs from Grail. Without one, logs come from an older Dynatrace API that Dynatrace plans to remove by the end of 2027.

## Run DQL

With a platform token, the environment's **Query** tab runs DQL (`fetch logs`, `fetch dt.entity.host`, `fetch bizevents` and so on). Results stop at 1,000 records per run. On Dynatrace Platform Subscriptions, Grail bills queries by data scanned, so narrow the timeframe where you can.

## Costs

With the OAuth client set, Dynatrace Platform Subscription cost for this environment shows on the Costs page, one row per day and capability (Full-Stack Monitoring, Log Analytics and so on), in your subscription's currency. Only this environment's share is counted, so connecting several environments of the same account never counts anything twice. Classic (non-DPS) licences have no cost data.

## Status

Incidents on [status.dynatrace.com](https://status.dynatrace.com) show on your Dynatrace environments. Dynatrace doesn't say where an environment is hosted, so every connected environment shows as possibly affected.

## Terraform

Alerting profiles and SLOs export to the `dynatrace-oss/dynatrace` provider (`dynatrace_alerting`, `dynatrace_slo_v2`) with import commands. Maintenance windows aren't exported, because the provider has deprecated that resource.

## Limits

- Hosts, services and other entities are those seen in the last 72 hours, up to 100,000 per type. Past that the list fails rather than showing part of it. SLOs are listed up to 10,000.
- SLOs come from the SLO API classic, which Dynatrace still supports. Platform SLOs from the new SLO app aren't listed yet.
- Alerting profile event filters and per-rule tag filters are kept when you edit a profile, but you can't edit them here.
- You can list, toggle and delete synthetic browser monitors, but not create them, since their scripts are recorded in the Dynatrace UI.
