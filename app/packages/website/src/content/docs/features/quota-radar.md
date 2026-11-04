---
title: Quota & limit radar
description: See how much of each provider quota every account is using, whether it's getting closer to the limit, and get an alert before a limit stops your next deploy.
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

By default a quota is flagged once it passes **80%** of its limit. Change this in your organization's quota settings to anything from 50% to 99%.

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

## Permissions and cost

- Viewing the page needs `resources:read`.
- Changing the threshold needs `org:settings:write`, the same as other alert settings.

Quotas are read about every six hours per account, so figures are never more than a few hours old. On AWS, the CloudWatch reads are billed to your own account. It's a handful of requests per region each time, and Infrawrench skips checking the limit on quotas nothing is using.

## Related

- [Synthetic probes](./synthetic-probes.md): is the endpoint reachable from outside?
- [Expiry radar](./expiry-radar.md): the other countdown, for certificates, domains and tokens.
- [Metric threshold alerts](./metric-alerts.md): alerts based on metrics rather than limits.
