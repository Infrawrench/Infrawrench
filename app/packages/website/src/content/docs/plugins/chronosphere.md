---
title: Chronosphere
description: Manage Chronosphere (Cortex XCOR) monitors, notification policies, notifiers, collections, buckets, teams, dashboards, SLOs, rollup, drop and recording rules, muting rules and service accounts, and chart or run PromQL against your tenant.
sidebar_order: 50
---

Connect a Chronosphere tenant to manage its alerting and metric shaping alongside the rest of your infrastructure. Chronosphere is now part of Palo Alto Networks and sold as Cortex XCOR; tenants keep their `<org>.chronosphere.io` address and the same APIs.

## What you can manage

- **Tenant**: counts of monitors, collections, dashboards and SLOs, and a **Query** tab that runs PromQL and shows the result as a table.
- **Monitors**: query, warn and critical conditions, interval, collection or bucket, notification policy, labels and signal grouping. Create PromQL monitors (pick the collection and notification policy from lists), edit the name, description, query and interval, delete them, and chart the query on the Metrics tab.
- **Notification policies** and **notifiers**: where each severity routes. Rename them, choose whether a notifier sends resolves, or delete them.
- **Collections**, **buckets** and **teams**: create (pick the team and default notification policy from lists), edit and delete. Team members are edited as a list of email addresses.
- **Dashboards**: rename or delete.
- **SLOs**: objective, window, indicator and burn-rate alerting. Edit the name, description and objective, or delete them.
- **Rollup rules** and **drop rules**: switch between enabled, preview and (for drop rules) disabled, or delete them.
- **Recording rules**: edit the expression or interval, chart the expression, or delete.
- **Muting rules**: create one from label matchers such as `service=checkout, env!=dev` with a start and end, **End now**, edit the comment, or delete.
- **Service accounts**: see which exist and whether they are unrestricted, and delete one to revoke its token. They show on the Expiry radar once they are old enough to rotate.
- **Services**: what Chronosphere discovered, with the owning team.

<insert [Chronosphere monitor detail page showing the conditions, the PromQL query and the Metrics tab chart] here>

## Credentials

1. **Organization**: the `<org>` in `https://<org>.chronosphere.io` (pasting the whole address works).
2. **API token**: select **Go to Admin**, then **Platform → Service Accounts → + Service Account**, choose **Unrestricted**, and copy the token; it is shown once. A personal access token also works and carries your own permissions. A restricted (telemetry-only) service account can only run PromQL. **Check credentials** shows which areas the token can reach.

<insert [Chronosphere Add-account form with the Organization and API Token fields filled in] here>

## Metrics and PromQL

Monitors and recording rules have a Metrics tab that runs their PromQL over the selected window through the tenant's Prometheus API (`/data/metrics/api/v1/query_range`), up to 20 series. The tenant's **Query** tab runs an instant query.

## Costs and status

Chronosphere has no billing API, and its status page requires a customer login, so there are no cost rows or provider status incidents for Chronosphere accounts.

## Terraform

Teams, buckets and collections export to the `chronosphereio/chronosphere` provider, importable by slug. Monitors, SLOs and shaping rules are not exported because their conditions and filters are nested documents.

## Limits

- Lists read up to 15,000 objects per type.
- Graphite and log monitors are listed and charted only as text; their queries are edited in Chronosphere.
- Dashboards' panels, notifier settings and SLO indicators are edited in Chronosphere.
