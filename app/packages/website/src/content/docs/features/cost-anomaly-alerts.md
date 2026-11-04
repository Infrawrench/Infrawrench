---
title: Cost anomaly alerts
description: Get alerted about unusual spend spikes and brand-new spend sources per provider and per service, through push, Slack, Microsoft Teams, email and optional SMS.
---

Infrawrench watches your spend and tells you when something looks wrong. Once a day, after your costs are collected, it compares yesterday's spend for every provider and every service with that provider's or service's own recent average. A day far above normal raises an anomaly. You see it on the Costs panel, and, if you've set up notifications, as a push notification, a Slack message or a Teams card.

You don't need to set anything up. [Budgets](./cloud-costs.md) alert when a monthly total you picked crosses a threshold you picked. Anomaly detection learns what's normal from your own history instead, so a spike stands out whether you spend fifty dollars a month or fifty thousand. If the defaults are too loud or too quiet, you can [tune them](#tuning-detection). For a slow, steady creep that never looks like an outlier, use [change alerts](./cost-change-alerts.md): you set a threshold like "this scope moved more than X% (or $Y) versus the prior period" on a scope and schedule you choose.

## Two kinds of anomaly

The anomalies list shows two kinds, each marked differently:

- A **spike:** a provider or service spending far more than its recent history says it should.
- A **new spend source:** a provider or service that spent nothing for weeks and suddenly bills a real amount. A jump from $0 to $5,000 has no average to compare against, so it gets its own check. This is often the one that matters most: it's what a leaked key, a service turned on by mistake or a wrong instance type looks like on a bill.

For a given day and provider or service, an anomaly is one or the other, never both.

## How detection works

- Detection looks at **yesterday and the two days before** (UTC), never today, since today is still adding up. It checks those days again on each pass because providers report spend late, so a spike that only shows up once the data fills in still gets caught.
- Each provider's and service's spend is compared with its **28-day average**, plus a number of standard deviations (three by default). A day above that line is a spike.
- A spike also has to be a **minimum dollar amount** above normal ($10 by default, converted for other currencies). This filters out tiny changes, like $0.02 against a $0.001 average.
- A provider or service with less than **7 days of spend history** is never judged as a spike, because there's no reliable average yet.
- A provider or service that spent **almost nothing in the last 28 days** and then bills more than the **new-source floor** ($25 a day by default) is reported as a new spend source. "Almost nothing" means less over the whole 28 days than the floor for a single day, so small trial charges don't count.
- New spend sources are only reported once your organization has **7 days of cost data**. On the day you connect your first account, everything is technically new. After that first week, a new provider or service alerts the day it appears.
- Each currency is judged on its own. If you're billed in more than one currency, each gets its own averages, and every floor is converted so it means the same real amount in dollars or yen.

## Tuning detection

Click **Tune detection** in the Anomalies section of the Costs panel. It has five settings, shared across your organization:

| Setting                   | What it does                                                                                       | Default | Range                                |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ------- | ------------------------------------ |
| **Sensitivity (σ)**       | Standard deviations above a key's own average before a day is a spike. Lower catches more.         | 3       | 1 to 10                              |
| **Spike floor**           | The minimum rise over the baseline a spike must also clear, in USD.                                | $10     | $1 to $100,000                       |
| **New-source floor**      | The minimum first-day spend before a provider or service with no history alerts, in USD.           | $25     | $1 to $100,000                       |
| **Text the on-call list** | Whether anomalies also send an SMS. See [Paging by SMS](#paging-by-sms).                           | Never   | Never / New sources only / Every one |
| **Email recipients**      | Members and approved addresses emailed about every anomaly; see [email alerts](./email-alerts.md). | Nobody  | Up to 50 members and 20 addresses    |

Values outside these ranges are rejected. The upper limits stop a typo (say, a floor typed in cents instead of dollars) from quietly switching detection off.

The rest is fixed: the 28-day average, the 7-day alert cooldown and the minimum history needed.

Changes apply from the next detection pass, which runs after the next cost collection. Anomalies already found aren't judged again, so lowering the sensitivity won't bring up older days.

You need `costs:read` to see these settings and `costs:write` to change them (the same permission as [pushing your own cost rows](./server-push.md)). Without `costs:write` you can see the settings but not edit them.

You tune detection on web and desktop. The mobile app lists anomalies but doesn't change the thresholds or the SMS setting. To turn anomaly notifications off for just yourself on your phone, use the "Cost anomalies" toggle in the app's notification settings.

![Costs panel Anomalies section with the tuning panel expanded, showing the Sensitivity, Spike floor, and New-source floor inputs with their default values, and the "Text the on-call list" dropdown set to Never](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/tuning-defaults.png)

## Repeat alerts and cooldown

You're never alerted twice about the same anomaly. These rules apply to both kinds:

- Each day, provider or service, and currency alerts **at most once**. If later data raises that day's figure, the list shows the new amount, but you don't get a second alert.
- Once you've been **notified** about a provider or service, more anomalies for it are **silenced for 7 days**. A lasting price jump looks unusual for several days in a row, and you only hear about it once. The silenced days still appear in the anomalies list.
- The cooldown only starts when an alert actually reached you. If no channel was connected, or delivery failed, the anomaly can still be sent while its day is being checked. Connect Slack, Teams or mobile push and the next pass sends what's waiting.

## Root-cause hints

Hints try to tell you why spend went up. When an anomaly fires, Infrawrench looks at the [change timeline](./change-timeline.md) and the [audit log](../team-and-billing/audit-log.md) for that day and the day before, and attaches up to three short facts, most likely first:

- **Resources that appeared, changed or disappeared**, grouped by type, such as "12 gce-instance resources appeared". For a provider anomaly, only that provider's resources count. A service anomaly looks across your whole organization.
- **Actions that may have cost money**, with who did them where known: a workflow run ("Astrid ran workflow \"Nightly rebuild\""), a change freeze lifted or overridden, a deployment, resources created from Infrawrench, a sleep/wake schedule change. Actions done with an API key say "an API key".

Hints appear in Slack messages and Teams cards, as one "likely related" line on push notifications, and under each row of the Anomalies list on web, desktop and mobile. SMS texts don't include them, as there isn't room. Hints are worked out once, when the anomaly is first found, so a change recorded later won't be added.

They're hints, not answers. They show what happened around the same time in your organization (and provider where possible). An empty list means nothing notable was recorded then.

![Costs panel Anomalies list showing a spike row with two root-cause hints beneath it: a "12 gce-instance resources appeared" line and a workflow-run line with the actor's name](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/spike-root-cause-hints.png)

<insert [Slack anomaly alert message whose body ends with an "Around then:" line listing the same root-cause hints] here>

## What drove it: the driving resource

"Amazon EC2 tripled" tells you something's wrong but not where to look. So every anomaly is also broken down by what went up underneath it. Each part of that day's spend is compared with its own average over the same 28 days, across six breakdowns:

- **Resource**, by the provider's own resource id (an instance, a bucket, a database), for providers that list resource ids on their bill.
- **Account**, **region**, **usage unit** (what the provider bills in, such as hours or GB-months) and **charge type** (usage, a commitment purchase, a credit, tax).
- **Tag values**, one value per tag key, for the tags on that day's spend.

Each row shows how much of the rise it carried: "i-0abc123 (web-1) rose $420 over its $12/day average, 64% of the rise". Only things that went up are listed, a few per breakdown, and anything under 5% of the rise is left out.

The **driving resource** is the resource that carried the most of the rise, as long as it carried at least a fifth of it. You see it first everywhere:

- On the **Anomalies** list (web, desktop and mobile), it sits under the provider or service as "Driven by web-1 i-0abc123 · +$420, 64% of the rise". If the resource is in your synced inventory, its name opens its page.
- **Breakdown** on a row opens the full table (every breakdown, with each row's average, its spend on the day, its rise and its share). Above it is a daily cost chart of the selected row, from four weeks before the anomaly to a week after, with the anomaly's day shaded. The driving resource is selected first; pick any other row to chart it. **Save as cost report** turns the chart into a [cost report](./cost-reports.md) filtered to that resource and provider or service, with a note pinned to the anomaly's day, and opens it.
- **Slack, Teams and email** alerts include a "What moved" line naming the driving resource and the biggest riser in up to two other breakdowns (an account, a region, a tag value), plus a link to the resource's page when it's synced. The **push notification** leads with the driving resource, or, for providers with no resource ids, the account or region that carried most of the rise.
- The first [root-cause hint](#root-cause-hints) is the driving resource, with what the change timeline recorded for it ("…and appeared in the window" if it was created that day or the day before).
- **Issues** filed in Jira, Linear or GitHub from an anomaly include the driving resource and the "What moved" lines.
- The [chat agent and MCP tools](./mcp.md) get the whole breakdown and cite it when explaining an anomaly.

If one account carried at least 80% of the rise, the alert counts as being about that account: an [alert routing](./alert-routing.md) rule on that account matches it, and the [event](./event-subscriptions.md) names it as its `accountId`.

Every surface shows the same breakdown. A provider that only bills per service (no resource ids) has no driving resource, but the other breakdowns still appear.

The breakdown covers your whole organization's spend, like the anomaly itself. That's why members with a [cost visibility scope](../team-and-billing/cost-visibility.md) don't see anomalies at all. The API also applies the scope to the breakdown: spend outside your accounts is combined into one "Other" row per breakdown, with its amount but not its name.

<insert [Costs panel Anomalies list with a spike row showing the "Driven by" line under the service name (resource name as a link, provider id, rise and share) and the Breakdown action next to File an issue] here>

<insert [The anomaly breakdown dialog: the daily chart of the driving resource with the anomalous day shaded, the Open resource and Save as cost report buttons, and the table grouped into Resource, Account, Region and Tag rows with average, on-the-day, rise and share columns] here>

## Where to see anomalies

On web and desktop, open the Costs panel, go to the **Alerts** tab and find the **Anomalies** section. It lists the last 30 days: the day, what spiked, the actual spend, the average it was compared with, and the percentage change. New spend sources have a **New source** badge and show `none` for the average and `new` for the change.

![Costs panel showing the Anomalies section with a mix of rows: a spike with a red percentage change, and a new spend source with its New source badge, "none" baseline, and "new" change](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/mixed-rows.png)

In the **mobile app**, the same list is on the **Costs** tab, under the month-to-date chart and your budgets. Tapping an anomaly push notification opens the [moment view](./moment.md), which shows the anomaly alongside everything else that happened around it, with Costs one tap away.

On mobile you'll also see:

- An **Explained** badge and the sentence for anomalies someone has [explained](#explaining-an-anomaly), so you don't chase a spike that was settled yesterday.
- Any [feedback](#expected-or-unexpected-feedback) (Expected or Unexpected, by whom and when, with the reason and note).
- A **Suppressed** badge for anomalies an expected pattern kept quiet.

You can give feedback from your phone. **Expected** and **Unexpected** on each row open a sheet with a reason, a note and, for expected ones, a "stop this alerting again" repeat option for the row's own provider or service. Thresholds, the suppression list, learned sensitivity, the precision report and writing an explanation are web and desktop only.

<insert [Mobile app Costs tab, Alerts tab selected, with the Anomalies section showing a spike row with its baseline and percentage change and a new-spend-source row with its New source badge and "new" change] here>

## From the CLI

The [desktop CLI](./cli.md) prints the same list:

```sh
infrawrench costs --anomalies              # the last 30 days
infrawrench costs --anomalies --days 7     # a shorter window (1-90)
infrawrench costs --anomalies --last 2w    # the same window, said the other way
infrawrench costs --anomalies --json       # stable JSON for scripting
```

Text mode prints a table with:

- the day
- what spiked (the provider or service, and which kind it is)
- the actual spend and the 28-day average per day
- the percentage change (`new` where there was no average)
- a `driven by` column with the [driving resource](#what-drove-it-the-driving-resource) and its share of the rise
- a `notified` column with the day the alert went out, or a dash if no channel was connected or another anomaly's cooldown applied

New spend sources are marked `[new source]` and show `none` as their average.

An `explained` column shows the first line of any [explanation](#explaining-an-anomaly), or a dash. You write explanations on web or desktop, since they add a note to your charts. For scripts and agents, use the [MCP tool](./mcp.md) `acknowledge_cost_anomaly`.

A `feedback` column shows the verdict and who gave it ("expected by Astrid"), or `suppressed` for an anomaly a suppression kept quiet. The first column is a short id you can pass to the feedback commands:

```sh
infrawrench costs --anomalies feedback 3f2a91c0 --expected --reason planned_launch --note "Launch week load test"
infrawrench costs --anomalies feedback 3f2a91c0 --expected --reason seasonal --recurrence monthly --expires 2027-06-30
infrawrench costs --anomalies feedback 3f2a91c0 --expected --note "EU migration cutover" --explain
infrawrench costs --anomalies feedback 3f2a91c0 --unexpected --reason data_issue
infrawrench costs --anomalies feedback 3f2a91c0 --clear
infrawrench costs --anomalies suppressions                  # list
infrawrench costs --anomalies suppressions delete 8c1d22ab
infrawrench costs --anomalies precision --months 12
infrawrench costs --anomalies sensitivity
```

Ids can be a unique prefix. All of these accept `--json`.

In `--json` output, every row has a `kind` field (`spike` or `new_source`) so a script can handle the two differently. Rows also include the full `acknowledgement` object where there is one, and the whole `contributors` breakdown.

<insert [Terminal showing `infrawrench costs --anomalies` output: the table of day, what spiked, actual vs baseline spend, the red percentage-change column, and the notified column] here>

## Alerts

Anomaly alerts use the same channels as budget alerts and sync-failure incidents. Set them up under **Settings > Notifications**, on the Routing and Channels tabs:

- **[Slack](./slack-alerts.md) and [Microsoft Teams](./teams-alerts.md):** **Alert routing** rules decide which channels get anomalies. Add a rule whose **Trigger** condition names **Anomalies** and pick channels under **Send to**. Until you add any rules, every trigger except Drift goes to every connected channel, so a newly connected workspace already gets anomalies. See [Alert routing](./alert-routing.md).
- **[Mobile push](./mobile-push-notifications.md):** a per-user, per-org toggle labelled **Anomalies**. Find it in the **Mobile app** pane of the Connections box (under "Your mobile notifications"), or in the mobile app under **Settings > Notifications**. It's on by default.

<insert [Settings > Notifications with an Alert routing rule whose Trigger condition names Anomalies, and the Mobile app pane's "Anomalies" push toggle] here>

Slack and Teams messages have a "View in Infrawrench" button that opens the Costs panel, plus **Expected** and **Unexpected** buttons for [feedback](#expected-or-unexpected-feedback):

- In **Slack**, the buttons work right in the message. Your Slack account must be [linked](./slack-alerts.md) to an Infrawrench member with `costs:write`. The verdict is recorded as you, and a message in the channel says who marked the anomaly and how. A repeating suppression needs more options than a button can offer, so the reply links to the Costs panel for that.
- In **Teams**, the buttons open a short signed-in page in Infrawrench with your verdict already picked. Add a reason, a note and a repeat option, then save. Opening the link alone records nothing.

<insert [Slack anomaly alert showing the Expected and Unexpected buttons, and the in-channel reply "Astrid marked the Amazon EC2 on 2026-10-01 anomaly as expected"] here>

### Alerts for one report's scope

Organization-wide detection looks at providers and services. To watch a narrower slice (one team's accounts, a tag, a cost centre) with its own sensitivity and its own channel, set up an [anomaly alert on a cost report](./cost-reports.md#anomaly-alerts-for-a-report). It runs alongside this detection, after the same cost collection, and alert routing rules don't change where it goes.

## Paging by SMS

Anomalies can also text your on-call list using your organization's Twilio credentials. It's **off by default**. Turn it on with **Text the on-call list** in the tuning panel:

| Setting                    | What gets texted                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Never** (default)        | Nothing. Push, Slack and Teams are unaffected.                                                                             |
| **New spend sources only** | Only a provider or service that started spending from nothing, which is what a leaked key or a service left on looks like. |
| **Every anomaly**          | New sources and spikes on existing lines.                                                                                  |

If you already use Twilio for budget alerts and sync incidents, you won't start getting anomaly texts until you turn this on.

**One text per detection pass, not one per anomaly.** One pass can find many anomalies at once. When one account's spend jumps, you get a provider anomaly plus one for each service under it. The text sums up the pass: the day, the three largest findings and a count of the rest ("and 9 more"). The Costs panel has the full list.

**At most one text every six hours** per organization, on top of the [7-day cooldown](#repeat-alerts-and-cooldown). Nothing is lost when a text is held back: the anomalies are still saved, listed and sent to push, Slack and Teams.

**Never a voice call.** Twilio voice calls are only for [workflow pages](./workflows.md) that ask for them.

To send texts, your organization needs paging turned on with Twilio credentials and a from-number under **Settings > Notifications**, and at least one recipient opted into SMS. If anything's missing, the tuning panel tells you instead of accepting the setting and sending nothing.

![Tuning panel with "Text the on-call list" set to "Every anomaly" on an org with no Twilio credentials, showing the amber warning that the organization can't receive SMS yet](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/sms-warning.png)

## API

Get recent anomalies over the HTTP API:

```
GET /api/org/{orgId}/costs/anomalies?days=30
```

This needs `costs:read` and returns up to 200 anomalies from the window you ask for (1 to 90 days), newest first. Each row includes:

- `kind`: `spike` or `new_source`. Older rows from before new-source detection read as `spike`. For a `new_source`, `baselineCents` is zero or close to it, so don't work out a percentage change from it.
- `hints`: the [root-cause hints](#root-cause-hints), as an array of up to three strings. It's empty when nothing notable happened or the row is older than hints. The CLI's `costs --anomalies --json` output has the same field.
- `contributors`: the [breakdown](#what-drove-it-the-driving-resource) of the rise, a few rows per breakdown. Each has a `facet` (`resource`, `account`, `region`, `usage_unit`, `charge_type` or `tag`), the `key` as it appears on cost rows (for a resource, the provider's own id), `tagKey` for a tag, a display `label`, the `accountId` its spend is in (null when it spans several), `resource` (the matching synced resource, with the ids a link needs, or null), `actualCents`, `baselineCents`, `deltaCents` and `share` of the whole rise. A row with `other: true` stands for spend outside your cost visibility scope. The driving resource is the `resource` row with the largest `deltaCents` whose `share` is at least 0.2.
- `acknowledgement`: `null` while nobody has explained the anomaly. Otherwise it holds the explanation, when and by whom it was recorded, and `annotationId`, the [cost annotation](./cost-reports.md#annotations) it created. `annotationId` becomes `null` if that note is deleted, which removes the chart marker but keeps the explanation. The annotation links back with `costAnomalyId`, so you can trace a chart marker to its anomaly.

To explain an anomaly, POST with `costs:write`:

```
POST /api/org/{orgId}/costs/anomalies/{anomalyId}/acknowledge
{ "explanation": "Migrated the API fleet to Graviton" }
```

You get back the updated anomaly. The note's date (the anomaly's day) and its organization-wide scope are set for you and aren't part of the body. Posting again replaces the sentence and rewords the existing note instead of adding a second one, and won't recreate a deleted note. It doesn't silence anything: a later spike on the same key is a new anomaly.

Feedback, suppressions and their two reports:

```
POST   /api/org/{orgId}/costs/anomalies/{anomalyId}/feedback
DELETE /api/org/{orgId}/costs/anomalies/{anomalyId}/feedback
GET    /api/org/{orgId}/costs/anomaly-suppressions
POST   /api/org/{orgId}/costs/anomaly-suppressions
GET    /api/org/{orgId}/costs/anomaly-suppressions/{suppressionId}
PUT    /api/org/{orgId}/costs/anomaly-suppressions/{suppressionId}
DELETE /api/org/{orgId}/costs/anomaly-suppressions/{suppressionId}
GET    /api/org/{orgId}/costs/anomaly-sensitivity
GET    /api/org/{orgId}/costs/anomaly-precision?months=6
```

```
POST /api/org/{orgId}/costs/anomalies/{anomalyId}/feedback
{ "verdict": "expected", "reason": "seasonal", "note": "Black Friday",
  "suppress": { "recurrence": "seasonal" } }
```

The reply is `{ anomaly, suppression }`. `suppress` is only accepted with `"verdict": "expected"`. Its `scope` and `scopeKey` default to the anomaly's own provider or service, and its `expiresOn` to the repeat option's default lifetime. Anomaly rows include `feedback` (the verdict, reason, note, who and when, and any suppression it created) and `suppressionId` (the suppression that kept it quiet), both `null` when absent. Writes need `costs:write`. Suppressions are also a [Terraform resource](./terraform-provider.md), `infrawrench_anomaly_suppression`, and agents can use the MCP tools `give_cost_anomaly_feedback`, `list_cost_anomaly_suppressions` and `get_cost_anomaly_precision`.

You can read and change the thresholds too:

```
GET /api/org/{orgId}/costs/anomaly-settings
PUT /api/org/{orgId}/costs/anomaly-settings
```

`GET` needs `costs:read` and returns the defaults if your organization never changed them. Both include `feedbackTuning` (the [Learn from feedback](#learning-from-feedback) switch). It's optional on `PUT`, and leaving it out keeps the current value. `PUT` needs `costs:write` and replaces the whole object: `sigmas`, `minDeltaCents`, `newSourceMinCents` and `smsAlerts` (`off` | `new_source` | `all`) are all required. Out-of-range values get a 400 rather than being adjusted. `smsAlerts` has no default, so a request without it is rejected.

Both responses also include a read-only `smsConfigured` boolean: whether a text could be delivered right now (paging on, Twilio credentials saved, at least one recipient opted into SMS). It's not accepted on `PUT`. See the [API reference](../team-and-billing/openapi.md) for the full schema.

## Explaining an anomaly

Detection finds a spike. Someone on your team works out it was a planned migration. Explaining the anomaly saves that answer, so the next person who opens the chart doesn't have to ask.

Click **Explain** on an anomaly row. The box is prefilled with what the row already knows, like "Amazon EC2 spend +173%: ", so you just finish the sentence. Any [root-cause hints](#root-cause-hints) are one click away as a starting point. Saving does two things:

- **Records the explanation on the anomaly.** The row is marked **Explained**, shows your sentence, and no longer counts toward the "N unexplained" total next to the section heading.
- **Adds a [cost annotation](./cost-reports.md#annotations) on the anomaly's day** for your whole organization, so the explanation shows as a marker on **every** cost chart covering that day: reports, dashboard cards, the overview.

The note's date and scope come from the anomaly and can't be changed in the Explain box. Afterwards it's an ordinary annotation: you can reword it, limit it to one report, or move its date in the annotation editor.

Good to know:

- **Explained rows are marked, never hidden.** The record stays, so nobody has to work the same spike out again.
- **Explaining doesn't silence future alerts.** If the same provider or service spikes again later, that's a new anomaly and you're alerted as usual. To silence a pattern, mark the anomaly [expected with a repeat option](#suppressions). That creates a suppression with an expiry you can see and edit.
- **Deleting the annotation doesn't reopen the anomaly.** The marker leaves the charts, but the row keeps its explanation, stays out of the unexplained count, and notes that the marker was removed.
- **Editing an explanation rewords the existing note** instead of adding a second marker. If the note was deleted, your edit updates the record without bringing the marker back.

Explaining needs `costs:write`, the same permission annotations need. Reading the list and its explanations needs `costs:read`. Each explanation is written to the [audit log](../team-and-billing/audit-log.md).

You explain anomalies on web and desktop. The mobile app shows explained anomalies (the badge and the sentence) but can't write one.

![Costs panel Anomalies section with one row marked Explained showing its inline explanation, the "1 unexplained" count next to the section heading, and the Explain link on an unexplained row](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/explained-row.png)

![The Explain composer open over the Anomalies list, showing the read-only day/service/spend facts, the note box prefilled with "Amazon EC2 spend +173%: ", and a root-cause hint offered as a one-click suggestion](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/explain-composer.png)

![A cost chart with an annotation marker on the anomalous day, its popover open showing the explanation text and the "Explains a detected anomaly" line](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/annotation-chart.png)

## Expected or unexpected: feedback

An explanation says what the spend was. Feedback says whether the alert was worth raising, and detection learns from it. Each row in the Anomalies table has **Expected** and **Unexpected**:

- **Expected:** planned or known. A launch, a migration, a seasonal peak, a price change.
- **Unexpected:** a real problem someone needed to know about.

Both take an optional **reason** (planned launch, migration, seasonal, pricing change, data issue, other) and an optional **note**. With a note, you can also tick "put this note on every cost chart" to [explain](#explaining-an-anomaly) the anomaly at the same time. The row then shows the verdict, who gave it and when. Giving feedback again replaces it, and **Clear feedback** removes it.

What each verdict does:

- **Unexpected** keeps detection as sensitive as it is, and offers to [file a Jira or Linear issue](#filing-an-anomaly-as-an-issue) right in the dialog. If an earlier Expected verdict on the same anomaly created a suppression, it's removed.
- **Expected** can stop the same pattern alerting again: pick a repeat option and it creates a [suppression](#suppressions). It also counts toward [learning from feedback](#learning-from-feedback).

<insert [The feedback dialog with Expected selected, reason "Seasonal", a note, recurrence "Recurring weekly", the scope picker on the anomaly's own service, the expiry date, and the "Next covered" preview line] here>

### Suppressions

A suppression says "spend in this scope is expected on these days, until this date". Mark an anomaly expected and pick how it repeats:

| Recurrence            | Covers                                                | Default lifetime |
| --------------------- | ----------------------------------------------------- | ---------------- |
| **One-off**           | Every day from the anomaly's day until it expires     | 7 days           |
| **Recurring weekly**  | The anomaly's weekday, every week                     | 90 days          |
| **Recurring monthly** | The anomaly's day of the month, give or take a day    | 180 days         |
| **Seasonal (yearly)** | The anomaly's date each year, give or take three days | 2 years          |

Lifetimes start from the anomaly's day or today, whichever is later, and you can change them in the dialog. A suppression lasts at most three years. Monthly patterns on the 29th to 31st fall on the last day of shorter months.

The **scope** defaults to the anomaly's own provider or service. You can pick an **account**, a **tag** value or a **cost centre** instead, from what your organization has. On a covered day, detection sets that scope's spend aside before judging the day:

- If the anomaly only happened because of that spend, it's still recorded and marked **Suppressed**, but you aren't alerted anywhere (push, Slack, Teams or SMS).
- If the rest of the day still crosses the line on its own, it alerts as usual. Marking a migration in one account as expected won't hide a spike elsewhere in the same service.

**Suppressions** in the Anomalies section lists every suppression: what it covers, how it repeats, its dates, the reason and note, who added it, the next days it covers and how many anomalies it has silenced. Edit or delete any of them, or click **Add suppression** to add one by hand for a launch you know is coming. Expired suppressions stay listed, greyed out. Deleting a suppression never deletes the anomalies it silenced. Any from the last three days can still alert on the next pass. Your organization can have at most 100 active suppressions.

<insert [The Suppressions panel listing an active weekly service suppression with its next covered days and "suppressed 3", an account-scoped one-off suppression, and an expired one greyed out] here>

### Learning from feedback

When the same provider or service keeps getting marked expected, detection gets a little less sensitive to it. From the second Expected verdict on a key within 90 days, its threshold goes up by half a standard deviation per verdict. It goes at most two above your organization's setting and never past 10. Any Unexpected verdict on that key in the same 90 days keeps it at your organization's setting. New spend sources aren't affected, since they have no threshold to raise.

**Tune detection** shows each key feedback has changed, its threshold and why ("raised from 3σ to 4σ: 3 marked expected in the last 90 days"). Its **Learn from feedback** switch (on by default) turns this off without losing your verdicts.

### Precision

**Precision** in the Anomalies section shows, month by month, how many anomalies were found and suppressed, how many were marked expected and unexpected, and the share of reviewed anomalies that were unexpected. That share is how often an alert was a real problem. It also counts the reasons given. A month with low precision and lots of Expected verdicts is a sign to add a suppression or retune detection.

<insert [The Precision panel showing six months of bars with percentages, the per-month counts, the overall line and the reasons breakdown] here>

Giving feedback needs `costs:write`, the same as explaining. Reading it needs `costs:read`. Every verdict and suppression change is written to the [audit log](../team-and-billing/audit-log.md).

## Filing an anomaly as an issue

If your organization has [Jira](./jira.md) or [Linear](./linear.md) connected, each row in the Anomalies table has a file link. It opens an issue prefilled with the day, the provider or service, the spend, the average, the percentage over, the driving resource and what else moved, and any root-cause hints. Once it's filed, the row shows the issue key instead, so nobody files the same spike twice.

File it when someone needs to go and look. Explain it when you already know the cause. Many rows get both: filed the morning the alert fired, explained that afternoon once someone found the cause.
