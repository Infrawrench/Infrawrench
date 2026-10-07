---
title: Axiom
description: Manage Axiom datasets, fields, virtual fields, monitors, notifiers, dashboards, views, saved queries, annotations, API tokens and users, query datasets with APL, tail their events, and chart ingest, query compute and plan limits.
sidebar_order: 50
---

Connect an Axiom organization to manage its datasets and alerting, query your data with APL, and keep an eye on how much you ingest and query.

## What you can manage

- **Organization**: the account opens to your organization, with its plan, billing period, default edge deployment and the limits its license sets. Rename it here. The Metrics tab charts hourly ingest (GB) and query compute (GB·ms), read from Axiom's audit log.
- **Datasets**: create datasets (events, OpenTelemetry logs, traces or metrics, in any edge deployment your plan includes), and edit the description and retention. **Trim to 30 days** or **Trim to 7 days** deletes older events; **Vacuum fields** removes fields that no longer hold data. Each dataset has:
  - a **query editor** that runs APL against it (it lives in the SQL editor tab, but takes APL),
  - a **Logs** tab with its newest events, which also makes datasets available in [Log workspaces](../features/log-workspace.md),
  - a **Metrics** tab charting events over time and the bytes the dataset ingested.
- **Fields**: every field of a dataset. Set its unit, description and visibility, or delete it.
- **Virtual fields**: create them on a dataset and edit the APL expression, type, unit and description.
- **Monitors**: threshold, match-event and anomaly monitors. Create one from a dataset or your own APL, edit the query, threshold, schedule and notification options, enable, disable or snooze it, and see its recent alerts. The Metrics tab re-runs its query over the selected range with the threshold drawn across it.
- **Notifiers**: email, Slack, PagerDuty, Opsgenie, Microsoft Teams, Discord and webhook notifiers. Create, rename or retarget them, snooze them, or delete them. Webhook URLs are shown with their path hidden, since they usually contain a secret.
- **Dashboards**: create an empty dashboard, rename it or change its description, open it in Axiom, or delete it.
- **Views**, **saved (starred) queries** and **annotations**: create, edit and delete them. A saved query's Metrics tab charts what it returns over the selected range.
- **API tokens**: create a token with ingest or query access to the datasets you pick and read access to the parts of the organization you pick, **Regenerate** it, or delete it. Axiom shows a token only once; for tokens created or regenerated here it is kept as the token's **Token** output, ready to export to a Kubernetes secret or a server.
- **Users**: list members with their role, and remove them.

<insert [Axiom dataset detail page with the query editor running an APL query and the Metrics tab showing Events and Ingested (GB) charts] here>

## Credentials

Use an **advanced API token**. In Axiom open **Settings → API tokens → New API token**, choose **Advanced**, and give it:

- **read** on Datasets, Monitors, Notifiers, Dashboards, Views, Annotations, API tokens and Users, plus **create, update and delete** on the ones you want to manage from Infrawrench;
- **Query** on the datasets you want to query, tail or chart, and on `axiom-audit` for the organization usage charts and plan-limit usage.

A **personal access token** (Settings → Profile → Personal tokens) also works and can do everything your user can. It needs the **Organization** field, which Infrawrench fills from the organizations the token can see. Axiom only lets API tokens query an edge deployment directly, so with a personal token queries go through `api.axiom.co`, which reaches your organization's default edge deployment only.

<insert [Axiom Add-account form with the API Token field filled in and the Organization field left on The token's organization] here>

## Metrics and usage

Organization and dataset usage charts query the `axiom-audit` dataset, the source Axiom's own documentation points to for usage monitoring. Only Owners can read it by default; for other tokens or users, grant query access to it (or to a view of it). Without access the charts stay empty and everything else works.

Running queries costs query compute on your Axiom bill, like any query you run in Axiom. Charts query only when you open the Metrics tab.

## Plan limits

The quota radar compares your license's dataset, monitor and user limits with what you have, and the billing period's ingest and query compute (from the audit log) with your plan's monthly allowances.

## Costs

Axiom has no billing API, so Axiom spend does not appear on the Costs page. The usage charts and plan limits show the volumes your bill is based on.

## Status

Open incidents on [status.axiom.co](https://status.axiom.co) show on your Axiom accounts. Axiom's status page does not say which edge deployment an incident affects, so incidents apply to the whole account; API and App outages are treated as affecting everything.

## Export to Terraform

Datasets, virtual fields, monitors and notifiers export as `axiomhq/axiom` resources with their import ids. Slack, webhook, Discord, PagerDuty and Opsgenie notifiers export their URLs and keys as variables, because Infrawrench never stores them in full. Dashboards, tokens and users are not exported.

## Limits

- Annotations from the last 90 days are listed.
- Edge deployments are fixed when a dataset is created and cannot be changed.
- Changing a token's capabilities is not possible in Axiom; create a new token instead.
