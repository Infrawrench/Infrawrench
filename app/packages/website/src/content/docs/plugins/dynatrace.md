---
title: Dynatrace
description: Browse Dynatrace hosts, services, process groups, web applications and Kubernetes clusters with their metrics and logs, triage problems, manage SLOs, synthetic monitors, alerting profiles, maintenance windows and access tokens, run DQL against Grail, and track platform subscription cost.
sidebar_order: 50
---

Connect a Dynatrace environment to see what it monitors, act on what it finds, and keep its configuration in one place with the rest of your infrastructure.

## What you can manage

- **Environment**: the environment itself, with its version, how many hosts, services and web applications it monitors, how many problems are open, and this month's platform subscription cost by capability. With a platform token, a **Query** tab runs DQL against Grail.
- **Hosts**: every host OneAgent monitors, with OS, CPU cores, memory, monitoring mode, IP addresses, host group, OneAgent version, tags and management zones. Metrics and Logs tabs.
- **Process groups** and **services**: what runs where. Services link to the process groups they run in, and process groups to their hosts, so the dependency graph shows the whole chain. Services have Metrics and Logs tabs.
- **Web applications** (Real User Monitoring) with user action metrics, and **Kubernetes clusters** monitored by the Dynatrace Operator.
- **Problems**: everything Davis raised in the last seven days, with severity, impact, root cause, affected entities and comments. **Add comment** and **Close problem** from the problem page.
- **Service-level objectives**: current value, target, warning threshold and error budget. Create, edit, turn off and on, and delete SLOs.
- **Synthetic monitors**: HTTP and browser monitors with their locations and frequency. Create HTTP monitors (pick the locations from a list), turn monitors off and on, delete them, and chart availability.
- **Alerting profiles**: set how long a problem of each severity stays open before your notification integrations hear about it. Create, edit and delete profiles.
- **Maintenance windows**: once, daily, weekly or monthly windows that pause alerting or problem detection, optionally for tagged entities only. Create, edit, turn off and on, and delete them.
- **Access tokens**: owner, scopes, expiry and last use for every token in the environment. Rename, turn off and on, or revoke them. Expiring tokens show on the Expiry radar.

<insert [Dynatrace environment detail page showing the environment counts, the Cost section by capability and the Query tab] here>

## Credentials

1. **Environment URL**: copy it from your browser. `https://<id>.apps.dynatrace.com` and `https://<id>.live.dynatrace.com` both work; for Managed or an Environment ActiveGate use `https://<host>/e/<environment-id>`.
2. **Access token** (required): in Dynatrace, open **Access Tokens** and select **Generate new token**. Add these scopes: `entities.read`, `problems.read`, `problems.write`, `metrics.read`, `slo.read`, `slo.write`, `ExternalSyntheticIntegration`, `settings.read`, `settings.write`, `apiTokens.read`, `apiTokens.write` and `logs.read`. **Check credentials** reads the token's scopes and shows exactly which features are missing one.
3. **Platform token** (optional, SaaS only): at [myaccount.dynatrace.com](https://myaccount.dynatrace.com/platformTokens) select **Platform token**, pick this environment, and add `storage:buckets:read` plus the `storage:*:read` scopes for the data you want to query (`storage:logs:read`, `storage:events:read`, `storage:bizevents:read`, `storage:spans:read`, `storage:metrics:read`, `storage:entities:read`). It enables DQL and reads host and service logs from Grail.
4. **Cost** (optional, under Advanced options): in **Account Management → Identity & access management → OAuth clients**, create a client with the **View usage and consumption** (`account-uac-read`) account permission. Enter the account UUID (from the Account Management address bar), the client id and the client secret.

<insert [Dynatrace Add-account form with the Environment URL, Access Token and Platform Token fields filled in and Advanced options expanded] here>

## Metrics

- **Hosts**: CPU usage, memory usage, the fullest disk, network in and out.
- **Services**: response time, requests and failure rate.
- **Web applications**: user actions and speed index.
- **Synthetic monitors**: availability across locations.

Metrics come from the Metrics API v2 at a resolution that keeps each chart around 120 points. A metric your environment does not record (no RUM, a host in infrastructure-only mode) is simply left out.

## Logs

Hosts and services have a Logs tab with the last 24 hours. With a platform token it queries Grail with DQL; without one it uses the Log Monitoring API v2, which Dynatrace plans to remove by the end of 2027.

## DQL

With a platform token, the environment's **Query** tab runs DQL (`fetch logs`, `fetch dt.entity.host`, `fetch bizevents`, and so on). Results are capped at 1,000 records per run. Grail bills queries by data scanned on Dynatrace Platform Subscriptions, so narrow the timeframe where you can.

## Costs

With the OAuth client set, Dynatrace Platform Subscription cost for this environment appears on the Costs page, one row per day and capability (Full-Stack Monitoring, Log Analytics, and so on), in your subscription's currency. Only this environment's share is read, so connecting several environments of the same account never counts anything twice. Classic (non-DPS) licences have no cost API.

## Status

Incidents on [status.dynatrace.com](https://status.dynatrace.com) show on your Dynatrace environments. Dynatrace reports incidents per stage, cloud and geography (for example Analyze on GCP in EMEA), and the API does not say where an environment is hosted, so every connected environment is shown as possibly affected.

## Terraform

Alerting profiles and SLOs export to the `dynatrace-oss/dynatrace` provider (`dynatrace_alerting`, `dynatrace_slo_v2`) with import commands. Maintenance windows are not exported because the provider has deprecated the matching resource.

## Limits

- Hosts, services and other entities are those seen in the last 72 hours, up to 5,000 per type.
- SLOs use the SLO API classic, which Dynatrace still supports. Platform SLOs from the new SLO app are not listed yet.
- Alerting profile event filters and per-rule tag filters are kept when you edit a profile but are not editable here.
- Synthetic browser monitors can be listed, toggled and deleted, but not created: their scripts are recorded in the Dynatrace UI.
