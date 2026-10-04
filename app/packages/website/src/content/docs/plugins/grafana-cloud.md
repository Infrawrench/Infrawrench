---
title: Grafana Cloud
description: Track Grafana Cloud spend by product and stack from billed usage, chart each stack's active series and ingest, and manage stacks, installed plugins, access policies and tokens, members, and each connected stack's dashboards, alert rules, contact points, data sources and synthetic checks.
sidebar_order: 50
---

## What you can manage

- **Organization**: your Grafana Cloud organization, its plan, and this month's bill so far. The page breaks the bill down by product (usage, included allowance, billable usage and amount) and by stack. The Metrics tab charts the monthly bill by product over the last year.
- **Stacks**: every stack with its region, status, plan, Grafana version, dashboards, alerts, active users, active series and logs, traces and profiles usage, plus the Prometheus, Loki, Tempo, Pyroscope and Alertmanager endpoints and user ids (copyable, and available as outputs). Create a stack by picking a name, a slug and a region from the list; rename it, change its description, labels and delete protection, restart its Grafana, or delete it. The Metrics tab charts active series, samples ingested and discarded, logs ingested, active log streams and traces ingested.
- **Installed plugins**: the catalog plugins installed on each stack, with the installed and latest version. **Update to latest** when an update is available, or uninstall by deleting.
- **Access policies** and **access policy tokens**: every policy with its scopes, the stacks or organization it applies to and its allowed subnets, and every token with its policy, expiry and first and last use. Rename either, turn a policy off and on, or delete. Grafana only shows a token's secret when it is created, so tokens are metadata; deleting one revokes it at once. Token expiry dates feed the [expiry radar](../features/expiry-radar.md).
- **Members**: the organization's members with their org role and MFA status. Change a member's role or remove them.

Once a stack is **connected** (see below), its own objects list too:

- **Dashboards**: with folder and tags, opened in Grafana with one click, and deletable.
- **Alert rules**: Grafana-managed rules with their folder, evaluation group, pending period and no-data and error behaviour. **Pause** and **Resume** them, or delete them.
- **Contact points**: one row per integration (email, Slack, PagerDuty, webhook and so on). Integration settings stay in Grafana.
- **Data sources**: with type and URL. **Test connection** runs Grafana's own health check.
- **Synthetic checks** (with a Synthetic Monitoring access token): job, target, type, frequency, timeout and probes. **Enable** and **Disable** them, or delete them.

## Credentials

- **Access policy token**: a Grafana Cloud access policy token (`glc_…`). In the Grafana Cloud portal open **Security → Access policies**, create a policy whose realm is your organization, give it the scopes below, then **Add token**. The organization is read from the token, so there is nothing else to fill in.
- **Organization slug** (optional): leave it blank. It is only needed if Infrawrench says it cannot tell which organization the token belongs to; it is the part after `grafana.com/orgs/` in your portal address.

<insert [Grafana Cloud Add-account form with the access policy token field filled and the Check credentials panel showing the capability checklist] here>

### Scopes

Run **Check credentials** on the add-account form or the account page: it probes one read per capability, and its [least-privilege generator](../core-concepts/credential-preflight.md) lists exactly the scopes to give the access policy. The scopes behind each capability:

| Capability                   | Scopes                                                                |
| ---------------------------- | --------------------------------------------------------------------- |
| Organization                 | `orgs:read`                                                           |
| Cost data                    | `orgs:read`                                                           |
| Stacks                       | `stacks:read`, plus `stacks:write` and `stacks:delete` to change them |
| Installed plugins            | `stack-plugins:read`, plus `stack-plugins:write` and `:delete`        |
| Access policies and tokens   | `accesspolicies:read`, plus `accesspolicies:write` and `:delete`      |
| Members                      | `org-members:read`, plus `org-members:write` and `:delete`            |
| Connect stacks automatically | `stack-service-accounts:write`                                        |
| Usage metrics (unconnected)  | `billing-metrics:read`                                                |

A type the token cannot read simply lists empty rather than failing the whole account.

## Connecting a stack

A stack's dashboards, alert rules, contact points and data sources live in the stack's own Grafana, which an access policy token cannot read. Connect each stack you want them for, from its page:

- **Connect stack** creates a service account called `infrawrench` (Admin role) on the stack and a token for it, and stores the token encrypted against the stack. It needs the `stack-service-accounts:write` scope. **Reconnect stack** mints a fresh token and replaces the stored one.
- Or **Edit** the stack and paste a **service account token** (`glsa_…`) you created under **Administration → Users and access → Service accounts** in the stack. Admin covers everything here; a Viewer token lists dashboards and data sources but not alert rules or contact points, and cannot pause rules.

For synthetic checks, **Edit** the stack and paste a **Synthetic Monitoring access token** from **Testing & synthetics → Synthetics → Config** in the stack.

Tokens are write-only: they are never shown again, and leaving the field blank on a later edit keeps the stored one.

<insert [Grafana Cloud stack page showing the usage and endpoints sections, the Connect stack button, and the Stack access note] here>

## Cost graphs

Grafana Cloud accounts feed [cost graphs & budgets](../features/cloud-costs.md) from Grafana's own **billed usage**, at your organization's rates:

- **Monthly.** Grafana reports usage charges per calendar month, so each month's charges are recorded on the 1st of the month. The current month is month to date and is re-read on every collection, as is the previous month until well after it closes. Up to 12 months are backfilled on the first sync, which is all the history Grafana keeps.
- **Breakdowns.** Spend is broken down by **product** (Metrics, Logs, Traces, Profiles, k6, IRM, Frontend Observability, Synthetic Monitoring and the rest) as the service, by **stack** as the resource and the `stack` tag, and by the stack's region. A product's amount is split across stacks by Grafana's own per-stack attribution where it provides one, and in proportion to each stack's usage otherwise; the split always adds up to exactly what Grafana bills.
- **Usage** rides with each row (GB, active series, VUh, users), so usage and cost can be charted together.

The figures are usage charges only: the platform fee, taxes and any credits are invoiced separately and are not included. Amounts are recorded in US dollars.

<insert [Cost graph grouped by service for a Grafana Cloud account, showing Metrics, Logs and Traces stacked by month] here>

## Export to Terraform

Stacks export to the official `grafana/grafana` provider as `grafana_cloud_stack` blocks with their name, slug, region, description, labels and delete protection, each with its `terraform import` id. Changing `region_slug` recreates a stack, so import and review the plan before applying. See [Export to Terraform](../features/terraform-export.md).

## Tips & limits

- **One access policy token per organization.** Add a second account for a second organization.
- **Unconnected stacks still chart usage** when the token has `billing-metrics:read`; connected stacks read the same metrics through their own `grafanacloud-usage` data source.
- **Provisioned alert rules** (from files or Terraform) can be paused here, but provisioning may overwrite the change the next time it runs.
- **Provider status** follows status.grafana.com; regional incidents are matched to the stacks in that region.
