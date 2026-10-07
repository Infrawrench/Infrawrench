---
title: Prometheus
description: Connect a self-hosted Prometheus or a compatible endpoint (Thanos, Mimir, Cortex, VictoriaMetrics) to run PromQL, watch scrape targets, rules and alerts, inspect the TSDB, and manage Alertmanager silences.
sidebar_order: 50
---

Connect a Prometheus server, or anything that speaks its HTTP API, to query it, see what it scrapes and alerts on, and silence alerts in its Alertmanager.

## What you can manage

- **Server**: the account opens on the server, with its version, retention, head series and chunks, the oldest sample in the head block, target health, rule and alert counts, the Alertmanagers it sends to, and whether the last configuration reload worked (a failed reload is a posture finding).
  - The **Query** tab runs PromQL and shows the result as a table, with metric names offered as you type.
  - The **Configuration** tab shows the loaded configuration as YAML (read only; Prometheus loads it from a file).
  - The **Describe** tab shows the TSDB cardinality report (series by metric name, label values, series by label pair, memory by label) and the flags the server runs with.
  - **Reload config** reloads the configuration and rule files, **Snapshot TSDB** writes a snapshot under the data directory, **Delete series** deletes the samples matching a selector over an optional time range, and **Clean tombstones** removes deleted data from disk.
  - The Metrics tab charts head series, samples ingested per second, targets up and down, rule evaluation failures, dropped notifications and memory, from the server's own metrics.
- **Scrape pools**: every scrape job with its targets up, down and dropped by relabelling, its interval, and its effective configuration with secrets redacted. The Metrics tab charts up and down targets, samples per scrape and the slowest scrape.
- **Targets**: each active target with its labels, scrape URL, health, last error, last scrape and duration. The Metrics tab charts `up`, scrape duration, samples scraped and series added.
- **Rule groups** and **rules**: recording and alerting rules with their expression, for duration, labels, annotations, health, last error, evaluation time and, for alerting rules, their state and active alerts. The Metrics tab charts a rule's expression, and for an alerting rule its firing alerts. **Graph expression** opens it in the Prometheus UI.
- **Alerts**: every pending or firing alert with its labels, annotations, value and since when.
- **Alertmanager** (when you add its URL): version, cluster state and peers, uptime and its configuration, with:
  - **Silences**: matchers, start and end, author and comment. **Create** one, **Edit** its matchers, end time or comment, or **Expire** it. **Silence** on an alert, a notified alert or an alerting rule opens the same form with the matchers filled in.
  - **Notified alerts**: what the Alertmanager is notifying about, which receivers each goes to, and the silences or inhibitions muting it.
  - **Receivers**: the notification receivers in its configuration, with how many alerts each is routing.

## Credentials

1. Enter the **Prometheus URL** with its port, for example `http://prometheus.internal:9090`. For Thanos, use the Query (or Query Frontend) URL; for Mimir or Cortex, include the `/prometheus` prefix; for VictoriaMetrics, use single-node `:8428` or vmselect's `/select/0/prometheus`.
2. If the server, or a proxy in front of it, asks for credentials, enter a **Username** and **Password**, or a **Bearer Token** under **Advanced options**. For multi-tenant Mimir or Cortex, enter the **Tenant ID** (sent as `X-Scope-OrgID`).
3. Optionally enter the **Alertmanager URL**, for example `http://alertmanager.internal:9093` or Mimir's `/alertmanager`. It uses the same credentials.
4. If the endpoint's certificate is signed by a private CA, paste the CA certificate under **Advanced options**.

<insert [Prometheus Add-account form with the Prometheus URL and Alertmanager URL filled in] here>

**Check credentials** tests queries, targets, rules, server status and the Alertmanager separately, so a Thanos, Mimir or VictoriaMetrics endpoint that lacks some of them shows exactly which.

<insert [Prometheus server page with the Query tab running sum by (job) (up)] here>

<insert [Prometheus Create silence dialog filled in from a firing alert] here>

## Business metrics

A Prometheus series can feed a [unit cost](../features/unit-costs.md#import-on-a-schedule) on a schedule. On a metric's row under **Costs → Unit costs**, choose **Import…**, pick this account and fill in the form:

- **Metric** lists every metric name the server knows. Counters usually end in `_total`.
- **Label filter** narrows it with PromQL matchers such as `job="api", status!~"5.."`.
- **Break down by** is an optional label; each of its values becomes a label on the metric.
- **Each day is** the increase over the day (for counters), or the average, maximum, minimum or last value (for gauges).

Each day's value is computed at the end of that day in the importer's timezone, over a window exactly one day long, so days with a daylight saving change are 23 or 25 hours. Days older than the server's retention come back empty.

## Tips & limits

- **Private servers**: the desktop app connects directly. The cloud app reaches a private server through an [SSH tunnel](../features/ssh-tunnels.md) on the account. A tunnel forwards one address, and every URL on the account is pointed at it, so a separate Alertmanager is unreachable through a tunnel; through a tunnel the connection also goes to `127.0.0.1`, so an HTTPS certificate must cover that address.
- Reload needs Prometheus started with `--web.enable-lifecycle`; snapshots, deleting series and cleaning tombstones need `--web.enable-admin-api`. Without them the action says which flag is missing.
- Rules, scrape jobs and the Alertmanager configuration live in files on the server, so they are read only here; edit the files and use **Reload config**.
- The server charts come from Prometheus's own metrics, so they need Prometheus to scrape itself. Thanos, Mimir and VictoriaMetrics do not offer every status endpoint; fields they do not report stay empty.
- Up to 3,000 targets are listed. Alerts and notified alerts come and go with their state.
- Prometheus has no cost data and no status page to follow, and there is no Terraform provider for its configuration.
