---
title: Quota & limit radar
description: See how much of each provider quota every account is using, when your resources' disks, storage caps and monthly allowances run out, and get an alert before a limit stops your next deploy.
sidebar_order: 12
---

Provider quotas usually get discovered mid-incident. The autoscaler stops scaling, a deploy fails with `VcpuLimitExceeded`, a `terraform apply` halts on the fifth VPC, and only then does anyone go looking for the number.

The **Quotas** page keeps an eye on them for you. Infrawrench reads each account's quotas from its provider a few times a day and shows how close you are, which way it's moving, and roughly when you'll run out.

![The Quotas page grouped by account, showing several utilisation bars (one red at 100%, two orange past the threshold marker, the rest muted) with the used/limit figures and a "full in 6 days" trend column](https://agent-assets.infrawrench.com/docs-screenshots/features/quota-radar/quotas-grouped-by-account.png)

Find it under **Quotas** in the sidebar on the web app, and on the desktop app in cloud mode.

## Both numbers come from your provider

Every row shows what you're using and the limit that will be enforced. **Neither is guessed.** Infrawrench never fills in a limit from a published default, so if you've had an increase approved, you see your real limit.

That also means you'll see _nothing_ rather than a reassuring zero. A provider with no quota API has no rows, and the page names it below the table so you don't mistake silence for headroom. If an account's quotas can't be read, it gets its own line saying so, with a link to the fix when the cause is a missing permission.

## "Full in N days"

Infrawrench looks at the trend over the last **14 days**. If it reaches the limit within 30 days, the row says so (_full in 6 days_) and the quota is flagged, even if it's nowhere near your threshold yet.

What to know about this number:

- It needs **at least three readings**. With too little history, the column says _no trend yet_, which isn't the same as "safe".
- It uses every reading, not just the first and last, so a quota that sat flat for two weeks and jumped once this morning won't look like it'll run out tomorrow.
- It **never looks further ahead than 30 days**.

An approved increase doesn't rewrite history. A quota that was at 95% before the increase still shows 95% for that time.

## Set the threshold and get alerts

By default a quota is flagged once it passes **80%** of its limit. Change this under **Settings → Notifications → Alerts & digest**, in the **Quotas & capacity runway** card, to anything from 50% to 99%. The same card turns quota and runway alerts off and holds the [runway thresholds](#capacity-runway).

Alerts go through your existing [alert routing](./alert-routing.md) under the **Quotas** trigger, so they reach the Slack channels, Microsoft Teams webhooks and phones your rules already name. There's no separate setting to configure. You get **one digest per organization per day**, never one notification per quota, and it leads with anything already at its limit:

> **Quota radar: 1 quota at the limit, 3 approaching**
> 1 at the limit · 3 over threshold
> • prod-aws · ec2 Running On-Demand Standard instances (eu-west-1): 912 vCPUs of 1,024 vCPUs, 89%, full in 6 days

The weekly digest includes a **Quotas** line with the same count.

<insert [A Slack message showing the quota radar digest: the bold headline, the counts line, and three bulleted quota rows with their used/limit figures] here>

## Supported providers

| Provider             | What's read                                                                                                                                                                                                   | Complete?                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **AWS**              | Service Quotas for the limit; CloudWatch `AWS/Usage` and two describe calls for usage. On-demand standard and GPU vCPUs, Elastic IPs, VPCs per region, for each region.                                       | Subset                     |
| **GCP**              | Compute Engine project and per-region quotas: CPUs, disks, addresses, networks, firewalls and the rest, each with usage and limit.                                                                            | Every Compute Engine quota |
| **DigitalOcean**     | The droplet and reserved-IP limits on your account, counted against your current droplets and reserved IPs.                                                                                                   | Subset                     |
| **Kubernetes**       | Every `ResourceQuota` object in the cluster, across all namespaces: CPU, memory, storage, pod and object counts per namespace.                                                                                | Every ResourceQuota        |
| **ClickHouse Cloud** | The organization's quotas (services, Postgres services, replicas, API keys) with Cloud's own usage figure. Quotas with no reported usage are skipped.                                                         | Every quota with usage     |
| **Cloudinary**       | The `/usage` response: monthly credits, transformations, storage, bandwidth, every add-on allowance the environment has, and the Admin API's hourly request budget.                                           | Every reported allowance   |
| **Snowflake**        | Each resource monitor with a credit quota: credits used this interval against the quota, both from `SHOW RESOURCE MONITORS`. A role only sees the monitors it owns or can monitor, unless it's ACCOUNTADMIN.  | Visible monitors           |
| **UploadThing**      | The app's storage used against its plan's storage limit.                                                                                                                                                      | Storage only               |
| **Coralogix**        | The team's daily unit quota against today's units, and the Events2Metrics, parsing-rule and enrichment limits with their usage.                                                                               | Subset                     |
| **Crusoe Cloud**     | Every organization quota Crusoe reports with a maximum (GPUs per instance type, CPUs, disks and the rest), against its own usage figure.                                                                      | Every quota with a limit   |
| **Turso**            | The organization's plan allowances against current usage: rows read and written and replica sync this billing cycle, storage, databases, groups and locations. Anything the plan doesn't cap is skipped.      | Every capped allowance     |
| **Modal**            | Each environment's running containers and GPUs against its concurrency caps, and its spend this cycle against its spend limit. Caps that aren't set are skipped. Workspace-wide plan limits aren't available. | Subset                     |
| **Baseten**          | Training GPU capacity: concurrent GPUs of each type in use by training jobs, against the organization and per-team limits.                                                                                    | Training GPUs only         |

"Subset" providers are marked on the page too. AWS publishes thousands of quotas, and Infrawrench checks the handful that actually stop deploys. DigitalOcean's API only exposes two of the limits it enforces. A missing row for these providers means _not measured_, not _fine_.

**Hetzner Cloud isn't supported.** Hetzner enforces per-project limits on servers, primary IPs, volumes and networks, but doesn't publish them in its API, so Hetzner accounts have no rows and are listed as unsupported. The same goes for Cloudflare, Vercel, Fly.io and Scaleway.

## Capacity runway

Provider quotas aren't the only limits that cause outages. A volume fills, a database reaches its storage cap, a monthly allowance of sends runs out a week before it resets. The **Capacity runway** section below the quotas lists every resource usage Infrawrench tracks against the limit that will stop it, **soonest to run out first**.

<insert [The Capacity runway section of the Quotas page: status counts (1 at the limit, 2 running out, 1 noisy trend), then rows sorted by runway with resource name and account, usage label, a utilisation bar, "9.2 GiB / 10.0 GiB", and a Runway column showing "6 days" and "71% by 12/1/2026"] here>

### Where the numbers come from

Both numbers come from the resource as Infrawrench last synced it, so tracking costs no extra provider calls. Each sync records the usage once an hour, and the projection is fitted over those readings.

The limit's source is shown on the row:

- **No label**: the provider reports the limit on the resource itself (a volume's size, a branch's size limit, an account's monthly cap), so it follows resizes and plan changes.
- **_documented_**: a fixed ceiling, such as 100% for a storage-percentage metric.
- **_plan_**: the provider's published allowance for the plan the resource is on. A negotiated contract may differ.

A few usages come from a metric series rather than a field: Azure database storage percentages, Cloud SQL disk utilisation and similar. Infrawrench only stores metrics for resources [pinned to a dashboard](./dashboard.md), so those rows appear for pinned resources only.

### How the projection works

- The trend is fitted over the last **14 days** with a robust method (the median of every pairwise slope), so one cleanup or one migration day is one vote rather than the whole answer.
- It needs **at least three readings over at least a day**. Before that, the row says _no trend yet_, which isn't the same as "safe".
- When the readings scatter as much as they trend, the row is marked as a **noisy trend** and drawn in amber. It's shown, but it never sends an alert on its own.
- Crossings more than a year out read _over a year_.

**Monthly allowances** (sends, transfer, credits) reset every billing cycle, so a crossing date months away would be meaningless. Instead the row shows what the allowance will reach **by the end of the cycle** at the current rate, and when it runs out if that happens first. Only this cycle's readings count. Early in a cycle, with too few readings for a trend, the rate is the average since the cycle started. The cycle comes from the provider when it reports one, otherwise it starts on the 1st of the month (UTC).

### On the resource page

A resource with a tracked usage gets runway charts at the top of its **Metrics** tab: the recorded readings, the limit as a red line and the projection dashed from today to where it meets the limit (or to the end of the cycle).

<insert [A resource's Metrics tab with a runway chart: a rising "Used" line over two weeks, a dashed red "Limit" line near the top, a dashed projection meeting it, and the caption "Runway: 6 days at the current rate."] here>

### Runway alerts

Runway alerts ride the same daily **Quotas** digest as quota alerts, under the same trigger. A row alerts when:

- it's **at its limit**,
- it reaches its limit within **14 days** on a clean trend (1 to 90 days), or
- a monthly allowance is past **80%** (50% to 99%), or is projected past its whole allowance before it resets.

Both thresholds are in the **Quotas & capacity runway** card next to the quota threshold. The digest lists the rows, soonest first:

> **Capacity runway: 1 resource limit reached, 2 running out**
> • prod · pg-data · Storage: 9.2 GiB of 10.0 GiB, full in 6 days
> • prod · mail · Emails sent: 41,000 emails of 50,000 emails, 71,000 emails projected by 2026-12-01

The [CLI](./cli.md) prints the same list with `infrawrench runway` (`--json` for scripts, `--at-risk` for only the rows that need attention).

### What's tracked

| Provider            | Usage against its limit                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS**             | Redshift cluster disk used (metric).                                                                                                                                            |
| **Azure**           | DNS zone record sets; private DNS zone record sets and virtual network links; Postgres and MySQL flexible server storage, SQL database data space and AKS etcd usage (metrics). |
| **Confluent Cloud** | Flink compute pool CFUs; Kafka eCKUs and ksqlDB storage (metrics).                                                                                                              |
| **DigitalOcean**    | Container registry storage against the included storage; managed database disk (metric).                                                                                        |
| **Elastic Cloud**   | Deployment disk, fullest instance.                                                                                                                                              |
| **Fly.io**          | Volume filesystem used against its size.                                                                                                                                        |
| **GCP**             | Cloud SQL disk, Bigtable storage and Filestore used space (metrics).                                                                                                            |
| **Koyeb**           | Volume used against its size.                                                                                                                                                   |
| **Linode**          | Database disk; the account's network transfer this month (monthly).                                                                                                             |
| **Mailgun**         | Emails sent this month against the monthly limit (monthly).                                                                                                                     |
| **Neon**            | Branch logical size against the project's per-branch limit.                                                                                                                     |
| **Pinecone**        | Index fullness (metric).                                                                                                                                                        |
| **Railway**         | Volume used against its size.                                                                                                                                                   |
| **Redis Cloud**     | Database memory used against the memory limit.                                                                                                                                  |
| **Resend**          | Emails this period (monthly); contacts, domains and segments against their limits.                                                                                              |
| **SendGrid**        | Email credits used, over the credit reset cycle (monthly).                                                                                                                      |
| **Vultr**           | Outbound bandwidth this month against the account's bandwidth credits (monthly).                                                                                                |

A provider missing here doesn't report a usage and its limit together in its API, so there's nothing to project. Its resources show nothing rather than a guess.

## Permissions and cost

- Viewing the page, the runway list and a resource's runway charts needs `resources:read`.
- Changing the threshold needs `org:settings:write`, the same as other alert settings.

Quotas are read about every six hours per account, so figures are never more than a few hours old. On AWS, the CloudWatch reads are billed to your own account. It's a handful of requests per region each time, and Infrawrench skips checking the limit on quotas nothing is using.

## Related

- [Synthetic probes](./synthetic-probes.md): is the endpoint reachable from outside?
- [Expiry radar](./expiry-radar.md): the other countdown, for certificates, domains and tokens.
- [Metric threshold alerts](./metric-alerts.md): alerts based on metrics rather than limits.
