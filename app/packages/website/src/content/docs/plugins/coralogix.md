---
title: Coralogix
description: Track Coralogix usage and estimated cost by pillar and TCO priority, watch the daily unit quota, and manage alerts, dashboards, TCO policies, parsing rules, enrichments, outbound webhooks, quota rules and Events2Metrics.
sidebar_order: 51
---

## What you can manage

- **Team**: the Coralogix team your API key belongs to. Opening the account opens the team: this month's units, GB processed and estimated cost, broken down by pillar (logs, metrics, traces, session recordings, profiles, AI evaluations) and by TCO priority (Frequent Search, Monitoring, Compliance, Blocked); the daily unit quota and how much of it today has used; and the team's limits for Events2Metrics, parsing rules and enrichments. The Metrics tab charts daily units and GB by pillar, units by TCO priority, and the daily quota line. **Turn on data usage metrics** (or off) toggles Coralogix's export of usage metrics into the team, so you can build your own dashboards and alerts on them.
- **Alerts**: every alert definition with its type, priority, status and last trigger. Edit the name, description and priority (P1 to P5), enable or disable it, and delete it. The Metrics tab counts how often it triggered over the selected window. Alert conditions are not edited here; change those in Coralogix.
- **Dashboards**: custom dashboards with their folder. **Pin** or **Unpin** one, **Make default** to open it for everyone in the team, or delete it.
- **TCO policies**: the TCO Optimizer policies for logs, spans and RUM, with the applications, subsystems and severities they match. Change a policy's priority (High for Frequent Search, Medium for Monitoring, Low for Compliance, or Block), its name and description; enable or disable it; delete it. The Metrics tab charts the volume the policy's rules matched over the last week, which is the data whose cost its priority decides.
- **Parsing rule groups**: with their rule types and the applications, subsystems and severities they apply to. Enable, disable or delete a group.
- **Enrichments**: Geo IP, suspicious IP, AWS and custom lookup enrichments. Create one by picking the type (and, for a custom lookup, the table), then naming the log field to enrich. Delete an enrichment to stop it.
- **Custom enrichments**: the lookup tables uploaded to Coralogix, with their file, size and version. Deletable; upload new versions in Coralogix.
- **Outbound webhooks**: the Slack, PagerDuty, Opsgenie, Microsoft Teams, Jira, email group, EventBridge and generic webhooks alerts notify through. **Send test** sends a test notification and reports the endpoint's error if it fails.
- **Quota rules**: how the daily unit quota is shared between entity types. Edit an entity type's allocation (a percentage, or units when it is locked), whether it can overflow into unused quota, and whether the rule is on.
- **Events2Metrics rules**: rules that turn logs or spans into metrics, with their query, metrics, labels and permutation limit, flagged when they exceed it. Deletable.

## Credentials

- **Coralogix region**: the region (Coralogix calls it the domain) your team lives in, read from the address you sign in at:

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

- **API key**: a **Team** key from **Settings → API Keys** (a **Personal** key also works, with its owner's permissions). Send-Your-Data keys only ingest data and are rejected.
- **Price per unit (USD)**: what one Coralogix unit costs on your plan. It defaults to Coralogix's published **$1.50**; enter your contracted rate if it differs. Edit the account to change it later.

<insert [Coralogix Add-account form with the region picker open on EU2, the API key filled and the price per unit at 1.50] here>

### Permissions

Coralogix API keys carry permissions, usually attached as **presets** that Coralogix keeps up to date. Run **Check credentials** on the add-account form or the account page: it probes one read per capability, and its [least-privilege generator](../core-concepts/credential-preflight.md) lists the presets and permissions to tick when you create the key.

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

Leave out the update and manage permissions for a read-only account. A type the key cannot read simply lists empty rather than failing the whole account.

## Cost graphs

Coralogix accounts feed [cost graphs & budgets](../features/cloud-costs.md) from the team's daily data usage:

- **Coralogix bills in units.** Every GB is converted to units at a rate set by its pillar and its TCO priority: logs cost 0.75 units per GB at High priority, 0.32 at Medium and 0.12 at Low; traces 0.5, 0.25 and 0.1; metrics 1 unit per 30 GB. Coralogix's API reports the units, never money, so **cost is units multiplied by the account's price per unit**. Costs from a Coralogix account are marked as **estimated** for that reason; with your contracted rate entered they track your bill, apart from anything billed outside units.
- **Breakdowns.** Spend is broken down by **pillar** as the service (Logs, Metrics, Traces, Session Recordings, Profiles, AI Evaluations), by the Coralogix region, and by two tags: `pillar` and `priority` (Frequent Search, Monitoring, Compliance, Blocked). Group by `priority` to see how much routing data to a cheaper TCO priority would save; the TCO policies are where you change it.
- **History.** Up to a year is backfilled on the first sync, as far back as Coralogix keeps usage. The last three days are re-read on every collection, so late usage and a price you changed recently are picked up.
- Each day's rows add up to Coralogix's own daily total, the number the quota is counted against.

<insert [Cost graph for a Coralogix account grouped by the priority tag, showing Frequent Search, Monitoring and Compliance stacked by day] here>

<insert [Coralogix team page showing this month's units, GB and estimated cost, the per-pillar and per-priority tables, and the daily quota section] here>

## Quota radar

The team's daily unit quota and its Events2Metrics, parsing-rule and enrichment limits appear on the [quota radar](../features/quota-radar.md), each read from Coralogix with its current usage. The daily quota needs a key that can read the team list; without it, the other limits still appear.

## Tips & limits

- **Pick the right region.** A key from one region is rejected everywhere else. **Check credentials** says which region it tried.
- **TCO priority is the cost lever.** The same GB costs about six times more at High priority than at Low. The TCO policy Metrics tab shows how much data a policy matches before you move it.
- **Changes replace the whole object.** Editing an alert, a TCO policy, a parsing rule group or a quota rule reads the current definition from Coralogix and writes it back with your change, so edits made in Coralogix in the meantime are kept.
- **Provider status** follows status.coralogix.com. Incidents that name a region in their title are attributed to that region.
