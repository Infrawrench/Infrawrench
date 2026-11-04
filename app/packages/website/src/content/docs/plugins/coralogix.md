---
title: Coralogix
description: Track Coralogix usage and estimated cost by pillar and TCO priority, watch the daily unit quota, and manage alerts, dashboards, TCO policies, parsing rules, enrichments, outbound webhooks, quota rules and Events2Metrics.
sidebar_order: 51
---

Connect a Coralogix team to see what it costs, watch its daily quota, and manage its alerts, policies and rules from Infrawrench.

## What you can manage

- **Team**: the Coralogix team your API key belongs to. Open the account to see this month's units, GB processed and estimated cost, broken down by pillar (logs, metrics, traces, session recordings, profiles, AI evaluations) and by TCO priority (Frequent Search, Monitoring, Compliance, Blocked). You also see the daily unit quota, how much of it today has used, and the team's limits for Events2Metrics, parsing rules and enrichments. The Metrics tab charts daily units and GB by pillar, units by TCO priority, and the daily quota line. **Turn on data usage metrics** (or off) controls whether Coralogix exports usage metrics into the team, so you can build your own dashboards and alerts on them.
- **Alerts**: every alert definition with its type, priority, status and last trigger. Edit the name, description and priority (P1 to P5), enable or disable it, or delete it. The Metrics tab counts how often it triggered over the selected window. You can't edit alert conditions here; change those in Coralogix.
- **Dashboards**: custom dashboards with their folder. **Pin** or **Unpin** one, **Make default** to open it for everyone in the team, or delete it.
- **TCO policies**: the TCO Optimizer policies for logs, spans and RUM, with the applications, subsystems and severities they match. Change a policy's priority (High for Frequent Search, Medium for Monitoring, Low for Compliance, or Block), its name and description. Enable, disable or delete it. The Metrics tab charts how much data the policy matched over the last week, which is the data whose cost its priority decides.
- **Parsing rule groups**: with their rule types and the applications, subsystems and severities they apply to. Enable, disable or delete a group.
- **Enrichments**: Geo IP, suspicious IP, AWS and custom lookup enrichments. To create one, pick the type (and, for a custom lookup, the table), then name the log field to enrich. Delete an enrichment to stop it.
- **Custom enrichments**: the lookup tables uploaded to Coralogix, with their file, size and version. You can delete them here; upload new versions in Coralogix.
- **Outbound webhooks**: the Slack, PagerDuty, Opsgenie, Microsoft Teams, Jira, email group, EventBridge and generic webhooks your alerts notify through. **Send test** sends a test notification and shows the endpoint's error if it fails.
- **Quota rules**: how the daily unit quota is shared between entity types. Edit an entity type's allocation (a percentage, or units when it is locked), whether it can overflow into unused quota, and whether the rule is on.
- **Events2Metrics rules**: rules that turn logs or spans into metrics, with their query, metrics, labels and permutation limit. Rules over their limit are flagged. You can delete them.

## Connect your account

You need three things:

- **Coralogix region**: the region your team lives in (Coralogix calls it the domain). Find it from the address you sign in at:

  | Sign-in address                   | Region |
  | --------------------------------- | ------ |
  | `<team>.coralogix.com`            | EU1    |
  | `<team>.app.eu2.coralogix.com`    | EU2    |
  | `<team>.app.coralogix.us`         | US1    |
  | `<team>.app.cx498.coralogix.com`  | US2    |
  | `<team>.app.us3.coralogix.com`    | US3    |
  | `<team>.app.coralogix.in`         | AP1    |
  | `<team>.app.coralogixsg.com`      | AP2    |
  | `<team>.app.ap3.coralogix.com`    | AP3    |
  | `<team>.app.gov1.coralogixgov.us` | GOV1   |

  Keys only work in their own region.

- **API key**: a **Team** key from **Settings > API Keys**. A **Personal** key also works, with its owner's permissions. Send-Your-Data keys only ingest data and are rejected.
- **Price per unit (USD)**: what one Coralogix unit costs on your plan. It defaults to Coralogix's published **$1.50**. Enter your contracted rate if it differs. You can change it later by editing the account.

<insert [Coralogix Add-account form with the region picker open on EU2, the API key filled and the price per unit at 1.50] here>

### Permissions

Coralogix API keys carry permissions, usually attached as **presets** that Coralogix keeps up to date. Run **Check credentials** on the add-account form or the account page to test what your key can read. Its [least-privilege generator](../core-concepts/credential-preflight.md) lists the presets and permissions to tick when you create the key.

| Capability          | Preset             | Permissions                                                                                                                                                |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data usage and cost | `DataUsage`        | `data-usage:Read`, plus `data-usage:Manage` to toggle usage metrics                                                                                        |
| Alerts              | `Alerts`           | `alerts:ReadConfig`, plus `alerts:UpdateConfig` to edit, enable, disable or delete                                                                         |
| Dashboards          | `Dashboards`       | `team-dashboards:Read`, plus `team-dashboards:Update` to make default or delete                                                                            |
| TCO policies        | `TCOPolicies`      | `logs.tco:ReadPolicies`, `spans.tco:ReadPolicies`, plus the `UpdatePolicies` pair to change them                                                           |
| Parsing rules       | `ParsingRules`     | `parsing-rules:ReadConfig`, plus `parsing-rules:UpdateConfig` to enable, disable or delete                                                                 |
| Enrichments         | `Enrichments`      | the `geo-enrichment`, `security-enrichment`, `team-custom-enrichment` and AWS enrichment `ReadConfig` permissions, plus `UpdateConfig` to create or delete |
| Outbound webhooks   | `OutboundWebhooks` | `outbound-webhooks:ReadConfig`, plus `outbound-webhooks:UpdateConfig` to delete                                                                            |
| Quota rules         | (none)             | `team-quota-rules:Read`, plus `team-quota-rules:Manage` to edit                                                                                            |
| Events2Metrics      | `Events2Metrics`   | `logs.events2metrics:ReadConfig`, `spans.events2metrics:ReadConfig`, plus `UpdateConfig` to delete                                                         |

For a read-only account, leave out the update and manage permissions. If the key can't read a type, that list just shows empty and the rest of the account still works.

## Cost graphs

Coralogix accounts feed [cost graphs & budgets](../features/cloud-costs.md) from the team's daily data usage.

- **Costs are estimates.** Coralogix bills in units, and each GB converts to units at a rate set by its pillar and TCO priority. Logs cost 0.75 units per GB at High priority, 0.32 at Medium and 0.12 at Low. Traces cost 0.5, 0.25 and 0.1. Metrics cost 1 unit per 30 GB. Coralogix reports units, not money, so Infrawrench multiplies units by the account's price per unit. With your contracted rate entered, the figures track your bill, apart from anything billed outside units.
- **Breakdowns.** Spend is broken down by **pillar** as the service (Logs, Metrics, Traces, Session Recordings, Profiles, AI Evaluations), by Coralogix region, and by two tags: `pillar` and `priority` (Frequent Search, Monitoring, Compliance, Blocked). Group by `priority` to see how much you'd save by routing data to a cheaper TCO priority. You change that in the TCO policies.
- **History.** Up to a year of history appears after you connect, as far back as Coralogix keeps usage. Late usage and a price you changed recently show up within a few days.
- Each day's total matches Coralogix's own daily total, the number your quota is counted against.

<insert [Cost graph for a Coralogix account grouped by the priority tag, showing Frequent Search, Monitoring and Compliance stacked by day] here>

<insert [Coralogix team page showing this month's units, GB and estimated cost, the per-pillar and per-priority tables, and the daily quota section] here>

## Quota radar

The team's daily unit quota and its Events2Metrics, parsing rule and enrichment limits appear on the [quota radar](../features/quota-radar.md), each with its current usage. The daily quota needs a key that can read the team list. Without it, the other limits still appear.

## Tips & limits

- **Pick the right region.** A key from one region is rejected everywhere else. **Check credentials** tells you which region it tried.
- **TCO priority is your cost lever.** The same GB costs about six times more at High priority than at Low. Check a TCO policy's Metrics tab to see how much data it matches before you move it.
- **Edits keep changes made in Coralogix.** When you edit an alert, TCO policy, parsing rule group or quota rule, Infrawrench applies your change to the latest version, so edits made in Coralogix in the meantime are kept.
- **Provider status** follows status.coralogix.com. Incidents that name a region in their title are attributed to that region.
