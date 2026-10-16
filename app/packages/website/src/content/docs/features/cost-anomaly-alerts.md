---
title: Cost anomaly alerts
description: Automatic detection of unusual spend spikes and brand-new spend sources per provider and per service, with alerts through push, Slack, Microsoft Teams, and optional SMS.
---

Infrawrench watches your collected spend for anomalies. Once a day, after cost
collection runs for your accounts, it compares yesterday's spend for every provider and every
service against that provider's or service's own trailing baseline. A day that lands far above
the baseline raises an anomaly, which shows up on the Costs panel and — if you have
notifications configured — arrives as a push notification, a Slack message, or a Teams card.

Unlike [budgets](./cloud-costs.md), which alert when a monthly total you chose
crosses a threshold you chose, anomaly detection works out of the box: the baseline is
learned from your own history, so a spike stands out whether your org spends fifty dollars a
month or fifty thousand. The thresholds it judges against can be
[tuned per organization](#tuning-detection) when the defaults are too loud or too quiet.
The third member of the family, [change alerts](./cost-change-alerts.md), sits between the
two: you configure a relative threshold — "this scope moved more than X% (or $Y) versus the
prior period" — on a scope and cadence you choose, which catches the deliberate 15% creep
that is never a statistical outlier and never crosses a budget.

## Two kinds of finding

The anomalies list mixes two detections, marked distinctly:

- A **spike** — a provider or service spending far more today than its own recent history says
  it should.
- A **new spend source** — a provider or service that spent nothing at all across the trailing
  window and suddenly bills a material amount. This is the case no statistical test can catch:
  with a baseline of zero there is no average or deviation to exceed, so a jump from $0 to
  $5,000 clears no bar at all. It is also often the most important thing to see, because that
  is what a leaked key, a mistakenly enabled service, or a fat-fingered instance type looks
  like on a bill.

The two are mutually exclusive for a given day and key: anything with a baseline worth
measuring against is judged as a spike, and only a key with no baseline can be a new source.

## How detection works

- Detection runs against **yesterday and the two days before it** (UTC), never today — today is
  still accruing and would read as a dip, never a spike. Each pass re-judges that short window
  rather than only the newest day, because a day's spend is not final when the day ends:
  providers restate late, and your accounts collect at staggered times, so a day looked at once
  and early can be missing most of its data. Re-judging it as it fills in is what stops a real
  spike from being missed.
- Each provider's and each service's spend is compared against its **trailing 28-day
  baseline**: the mean daily spend plus a number of standard deviations (three, by default). A
  day above that bar is a spike.
- A **minimum absolute rise** over the baseline ($10 by default, converted for other
  currencies) filters out penny-scale noise — a $0.02 day against a $0.001 baseline is many
  deviations out and still not worth an alert.
- Keys with fewer than **7 days of spend history** are never judged as spikes: a brand-new
  service has no baseline worth trusting yet.
- A key that spent **effectively nothing across the whole 28-day window** and then bills more
  than the **new-source floor** ($25/day by default) is reported as a new spend source instead.
  "Effectively nothing" means it spent less over the entire window than that floor covers for a
  single day, which tolerates the sub-cent trial usage real bills are full of.
- New spend sources need **7 days of cost collection** behind them before any are reported.
  On the day you connect your first account every provider and every service is technically
  new, and that is a fact about how long we have been looking rather than about your spend.
  This is measured across the organization, so a genuinely new provider or service inside an
  established organization still alerts the day it appears.
- Detection is per currency. Mixed-currency orgs get independent baselines per currency,
  the same way cost graphs never merge currencies, and every floor is converted so it means the
  same real amount whether a provider bills in dollars or yen.

## Tuning detection

The **Tune detection** button on the Costs panel's Anomalies section opens five controls,
stored per organization:

| Control                   | What it does                                                                                       | Default | Range                                |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ------- | ------------------------------------ |
| **Sensitivity (σ)**       | Standard deviations above a key's own average before a day is a spike. Lower catches more.         | 3       | 1 – 10                               |
| **Spike floor**           | The minimum rise over the baseline a spike must also clear, in USD.                                | $10     | $1 – $100,000                        |
| **New-source floor**      | The minimum first-day spend before a provider or service with no history alerts, in USD.           | $25     | $1 – $100,000                        |
| **Text the on-call list** | Whether anomalies also send an SMS — see [Paging by SMS](#paging-by-sms).                          | Never   | Never / New sources only / Every one |
| **Email recipients**      | Members and approved addresses emailed about every anomaly; see [email alerts](./email-alerts.md). | Nobody  | Up to 50 members and 20 addresses    |

The bounds are enforced by the server, not just the form. A sensitivity of 0 would flag every
day a cent above average, and anything under 1σ flags roughly a third of ordinary days; a floor
of zero or less removes the noise filter entirely. The upper bounds exist so a typo — entering
a floor in cents when the field asks for dollars — cannot silently switch detection off.

Everything else about the model is fixed: the 28-day baseline, the 7-day alert cooldown, and
the minimum history a baseline needs are properties of the data rather than preferences.

Changes take effect on the next detection pass, which runs after the next cost collection.
Anomalies already found are not re-judged, so lowering the sensitivity does not retroactively
surface older days.

Reading the settings needs the `costs:read` permission; changing them needs `costs:write` — the
same scope as [pushing your own cost rows](./server-push.md), because retuning changes what your
whole cost feed alerts on. A member without it sees what detection is tuned to, without the
controls.

Tuning is a web and desktop feature. The mobile app lists anomalies but does not edit the
thresholds or the SMS setting: they are organization-wide settings that change what everyone's
alerts look like, and the control you actually want on a phone — turning the notifications off
for yourself — is the "Cost anomalies" toggle in the app's notification settings.

![Costs panel Anomalies section with the tuning panel expanded, showing the Sensitivity, Spike floor, and New-source floor inputs with their default values, and the "Text the on-call list" dropdown set to Never](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/tuning-defaults.png)

## Deduplication and cooldown

The same anomaly never re-alerts. Both kinds share these rules — a new spend source that keeps
spending becomes an ordinary key with a baseline within days, and telling you about it every
morning in between would be noise:

- Each (day, provider-or-service, currency) combination alerts **at most once**, no matter how
  many collection passes re-examine that day. If a day's figures are revised upward by later
  data, the anomalies list updates to show the corrected amount, but no second alert is sent.
- After you are **notified** about a provider or service, further anomalies for the same one
  are **suppressed for 7 days**. A sustained price jump is anomalous against the trailing
  window for several days running; you get told once, not every morning. The suppressed days
  still appear in the anomalies list so the record is complete.
- The cooldown counts only anomalies that actually reached you. An anomaly detected while no
  channel was connected — or one whose delivery failed — does not start a quiet period, and
  stays eligible to be sent for as long as its day is still in the evaluation window. Connect
  Slack, Teams, or mobile push and the next collection pass delivers what is still pending.

## Root-cause hints

An anomaly tells you spend went up; the hints try to tell you why. When an anomaly fires,
Infrawrench looks at what else it already knows about the same window — the
[change timeline](./change-timeline.md) and the [audit log](../team-and-billing/audit-log.md)
for the anomalous day and the day before — and attaches up to three short facts, ranked by how
likely they are to explain a bill:

- **Resources that appeared, changed, or disappeared**, aggregated by type — "12 gce-instance
  resources appeared". For a provider anomaly only that provider's resources are considered; a
  service anomaly can't be pinned to one provider generically, so it reads org-wide.
- **Audited actions that plausibly cost money**, with the actor's name where one is recorded —
  a workflow run ("Astrid ran workflow \"Nightly rebuild\""), a change freeze lifted or
  overridden, a deployment, resources created from Infrawrench, a sleep/wake schedule change.
  Actions performed with an API key are attributed to "an API key".

The hints appear in the Slack message and Teams card body, as a single "likely related" line on
the push notification, and under each row in the Anomalies list on web, desktop, and mobile.
SMS texts never carry them — the text's length budget is already spent naming the anomalies
themselves. Hints are computed once, when the anomaly is first detected, so an anomaly found
before a related change landed in the timeline is not re-annotated later.

They are hints, not verdicts: the queries find correlation in time, scoped to your org (and
provider where possible), and an empty list just means nothing notable was recorded in that
window.

![Costs panel Anomalies list showing a spike row with two root-cause hints beneath it — a "12 gce-instance resources appeared" line and a workflow-run line with the actor's name](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/spike-root-cause-hints.png)

<insert [Slack anomaly alert message whose body ends with an "Around then:" line listing the same root-cause hints] here>

## What drove it: the driving resource

Detection works per provider and per service, which is the right level to decide that a day is
unusual and the wrong one to act on: "Amazon EC2 tripled" sends somebody off to read a bill.
So every anomaly is also broken down by what moved underneath it. Infrawrench takes the
anomalous day's spend in that provider or service and compares each part of it with its own
average over the same 28 days detection used, along six breakdowns:

- **Resource**, by the provider's own resource id (an instance, a bucket, a database), for
  providers that report resource ids on their bill.
- **Account**, **region**, **usage unit** (the unit the provider bills the line in, such as
  hours or GB-months) and **charge type** (usage, a commitment purchase, a credit, tax).
- **Tag values**, one value per tag key, for the tag keys the day's spend carries.

Each breakdown adds up to the whole rise, so every row says how much of it that one thing
carried: "i-0abc123 (web-1) rose $420 over its $12/day average, 64% of the rise". Only things
that went up are listed, a few per breakdown, and anything under 5% of the rise is left out as
noise.

The **driving resource** is the resource that carried the most of the rise, provided it
carried at least a fifth of it. It is the first thing every surface shows:

- On the **Anomalies** list (web, desktop and mobile) it sits under the provider or service as
  "Driven by web-1 i-0abc123 · +$420, 64% of the rise". When the resource is in your synced
  inventory, its name opens the resource's page.
- **Breakdown** on the row opens the full table (every breakdown, with each row's average, its
  spend on the day, its rise and its share) above a daily cost chart of the selected row from
  four weeks before the anomaly to a week after, with the anomalous day shaded. The driving
  resource is selected to begin with; pick any other row to chart it instead. **Save as cost
  report** turns the chart into a [cost report](./cost-reports.md), filtered to that resource and
  that provider or service, with a note pinned to the anomalous day so the report keeps marking
  it, and opens it.
- **Slack, Teams and email** alerts gain a "What moved" line naming the driving resource and the
  largest riser in up to two other breakdowns (an account, a region, a tag value), plus a link to
  the resource's page when it is synced. The **push notification** leads with the same thing:
  the driving resource, or, for a provider that reports no resource ids, the account or region
  that carried most of the rise.
- The first [root-cause hint](#root-cause-hints) becomes the driving resource, with what the
  change timeline recorded for it ("…and appeared in the window" when it was created that day
  or the day before), ahead of the timeline and audit-log hints.
- **Issues** filed in Jira, Linear or GitHub from an anomaly include the driving resource and
  the "What moved" lines.
- The [chat agent and MCP tools](./mcp.md) receive the whole breakdown and are told to cite it
  when explaining an anomaly.

When one account carried at least 80% of the rise, the alert is treated as being about that
account: an [alert routing](./alert-routing.md) rule on that account matches it, and the
[event](./event-subscriptions.md) names it as its `accountId`.

The breakdown is computed when the anomaly is detected and stored with it, so every surface
shows the same answer. Anomalies found before this existed are broken down the first time you
open the list, a few at a time. A provider that bills per service only (no resource ids) has no
driving resource; the other breakdowns still appear.

The breakdown is computed over the whole organization's spend, like the anomaly itself, which
is why members with a [cost visibility scope](../team-and-billing/cost-visibility.md) do not
see anomalies at all. The API applies the scope to the breakdown as well, as a second line of
defence: any row whose spend sits outside the caller's accounts is added into a single "Other"
row per breakdown, with its amount but without its name.

<insert [Costs panel Anomalies list with a spike row showing the "Driven by" line under the service name (resource name as a link, provider id, rise and share) and the Breakdown action next to File an issue] here>

<insert [The anomaly breakdown dialog: the daily chart of the driving resource with the anomalous day shaded, the Open resource and Save as cost report buttons, and the table grouped into Resource, Account, Region and Tag rows with average, on-the-day, rise and share columns] here>

## Where anomalies appear

The Costs panel (web and desktop) has an **Anomalies** section on its **Alerts** tab, listing the last 30 days:
the day, what spiked, the actual spend, the baseline it was measured against, and the
percentage change. New spend sources carry a **New source** badge, and show `none` for the
baseline and `new` for the change — a key with no prior spend has no percentage to be up by.

![Costs panel showing the Anomalies section with a mix of rows — a spike with a red percentage change, and a new spend source with its New source badge, "none" baseline, and "new" change](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/mixed-rows.png)

The **mobile app** shows the same list on its **Costs** tab, under the month-to-date chart and
your budgets, with the same distinction between the two kinds. Tapping a cost anomaly push
notification opens the [moment view](./moment.md) — the anomaly in context with everything else
that happened around it, with Costs one tap away. An anomaly somebody has
[explained](#explaining-an-anomaly) carries an **Explained** badge and the sentence, so the
person who gets the push at 7am is not working out a spike that was settled yesterday.
Rows also show any [feedback](#expected-or-unexpected-feedback) (Expected or Unexpected, by whom
and when, with the reason and note) and a **Suppressed** badge for findings an expected pattern
kept quiet. You can give feedback from the phone: **Expected** and **Unexpected** on each row
open a sheet with a reason, a note and, for expected findings, a "stop this alerting again"
recurrence scoped to the row's own provider or service. Detection thresholds, the suppression
list, the learned sensitivity and the precision report, and writing an explanation, are web and
desktop only.

<insert [Mobile app Costs tab, Alerts tab selected, with the Anomalies section showing a spike row with its baseline and percentage change and a new-spend-source row with its New source badge and "new" change] here>

## From the CLI

The [desktop CLI](./cli.md) prints the same list:

```sh
infrawrench costs --anomalies              # the last 30 days
infrawrench costs --anomalies --days 7     # a shorter window (1-90)
infrawrench costs --anomalies --last 2w    # the same window, said the other way
infrawrench costs --anomalies --json       # stable JSON for scripting
```

It is a flag on `costs` rather than a command of its own: it answers a question about the same data the chart draws. Text mode prints a table of the day, what spiked (the provider or service, and which of the two it is), the actual spend, the trailing baseline per day, the percentage change (`new` where the key had no baseline to be up from), and a `driven by` column naming the [driving resource](#what-drove-it-the-driving-resource) with its share of the rise. New spend sources are marked `[new source]` and print `none` for their baseline. A `notified` column shows the day the alert was delivered, or a dash for anomalies detected while no channel was connected or inside another anomaly's cooldown.

An `explained` column carries the first line of the explanation for any finding somebody has
[explained](#explaining-an-anomaly), or a dash for one nobody has. Explaining itself is a web and
desktop action — it publishes a note onto charts, which is not a thing to do blind from a
terminal — but the [MCP tool](./mcp.md) `acknowledge_cost_anomaly` covers scripted and agent use.

A `feedback` column shows the verdict and who gave it ("expected by Astrid"), or `suppressed` for
a finding a suppression kept quiet, and the first column is a short id you can pass to the
feedback commands:

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

Ids can be a unique prefix. Every one of these takes `--json`.

The `--json` output carries a `kind` field on every row (`spike` or `new_source`), so a script can route the two differently, the full `acknowledgement` object where there is one, and the whole `contributors` breakdown.

<insert [Terminal showing `infrawrench costs --anomalies` output: the table of day, what spiked, actual vs baseline spend, the red percentage-change column, and the notified column] here>

## Alerts

Anomaly alerts ride the same channels as budget alerts and sync-failure incidents. Everything
lives under **Settings → Notifications**, in two places (the Routing and Channels tabs):

- **[Slack](./slack-alerts.md) and [Microsoft Teams](./teams-alerts.md)** — which channels get
  anomalies is decided by the **Alert routing** rules, not by a checkbox on the channel row.
  Add a rule whose **Trigger** condition names **Anomalies** and pick the channels under
  **Send to**. Until you write any rules, the built-in default sends every trigger except
  Drift to every connected channel, so a freshly connected workspace already receives them —
  see [Alert routing](./alert-routing.md).
- **[Mobile push](./mobile-push-notifications.md)** — a per-user, per-org toggle labelled
  **Anomalies**, in the **Mobile app** pane of the Connections box (under "Your mobile
  notifications"), or on the mobile app's own **Settings → Notifications** screen. It defaults
  to on.

<insert [Settings → Notifications with an Alert routing rule whose Trigger condition names Anomalies, and the Mobile app pane's "Anomalies" push toggle] here>

Slack and Teams messages carry a "View in Infrawrench" button that opens the Costs panel, and
**Expected** / **Unexpected** buttons for [feedback](#expected-or-unexpected-feedback):

- In **Slack** the buttons answer in place. Your Slack account must be
  [linked](./slack-alerts.md) to an Infrawrench member with the `costs:write` permission; the
  verdict is recorded as you, and a message in the channel says who marked the anomaly and how,
  so the people who saw the alert see it was answered. A recurring suppression needs choices a
  button cannot ask for, so the reply links to the Costs panel for that.
- **Teams** cards are delivered through one-way incoming webhooks, so the buttons open a short
  signed-in page in Infrawrench with the verdict preselected, where you can add a reason, a note
  and a recurrence before saving. Nothing is recorded by opening the link alone.

<insert [Slack anomaly alert showing the Expected and Unexpected buttons, and the in-channel reply "Astrid marked the Amazon EC2 on 2026-10-01 anomaly as expected"] here>

## Paging by SMS

Anomalies can also text your on-call list through the org's Twilio credentials. It is **off by
default** and turned on with the **Text the on-call list** control in the tuning panel, which
offers three settings:

| Setting                    | What gets texted                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Never** (default)        | Nothing. Push, Slack and Teams are unaffected.                                                                                |
| **New spend sources only** | Only a provider or service that started spending from nothing — the shape a leaked key or a mistakenly enabled service takes. |
| **Every anomaly**          | New sources and spikes on existing lines.                                                                                     |

It defaults to off deliberately: an organization that already configured Twilio for budget
alerts and sync incidents should not start receiving a new category of text message because a
release shipped.

**One text per detection pass, not one per anomaly.** A single pass can flag many anomalies at
once — detection runs per provider _and_ per service, so the day one account's spend jumps you
get a provider anomaly plus one for every service underneath it. The text summarizes what that
pass alerted on: the day, the three largest findings by detection order, and a count of the
rest ("and 9 more"). The Costs panel has the full list.

**At most one text every six hours** per organization, on top of the [7-day per-key
cooldown](#deduplication-and-cooldown). The evaluation pass itself can run hourly, and the
per-key cooldown only stops the _same_ provider or service alerting again — without a second
bound, a trickle of different services crossing the threshold as late-restated data lands could
text somebody all day. A suppressed text loses nothing: the anomalies are still stored, still
listed, and still delivered to push, Slack and Teams.

**Never a voice call.** Twilio voice is reserved for [workflow pages](./workflows.md) that ask
for it. An anomaly is worth a text, not a ringing phone at 3am.

Texts need paging enabled for the organization with Twilio credentials and a from-number under
**Settings → Notifications**, and at least one recipient opted into SMS. If none of that is set
up, the tuning panel says so rather than accepting the setting and silently delivering nothing.

![Tuning panel with "Text the on-call list" set to "Every anomaly" on an org with no Twilio credentials, showing the amber warning that the organization can't receive SMS yet](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/sms-warning.png)

## API

Recent anomalies are available over the HTTP API:

```
GET /api/org/{orgId}/costs/anomalies?days=30
```

The endpoint requires the `costs:read` permission and returns up to 200 anomalies from the
requested window (1–90 days), newest first. Each row carries a `kind` of `spike` or
`new_source`; rows detected before new-source detection existed read as `spike`. For a
`new_source`, `baselineCents` is zero or near it — do not compute a percentage change from it.
Each row also carries `hints` — the [root-cause hints](#root-cause-hints) computed when the
anomaly fired, as an array of up to three strings, empty when nothing notable happened in the
window or the row predates hint collection. The CLI's `costs --anomalies --json` output
includes the same field.

Each row also carries `contributors`: the [breakdown](#what-drove-it-the-driving-resource) of
the day's rise, a few rows per breakdown. Every row has a `facet` (`resource`, `account`,
`region`, `usage_unit`, `charge_type` or `tag`), the `key` as the cost rows carry it (for a
resource, the provider's own id), `tagKey` for a tag, a display `label`, the `accountId` its
spend sits in (null when it spans several), `resource` (the synced inventory resource it
matched, with the ids a link needs, or null), `actualCents`, `baselineCents`, `deltaCents` and
`share` of the whole rise. A row with `other: true` stands for spend outside your cost
visibility scope. The driving resource is the `resource` row with the largest `deltaCents` whose
`share` is at least 0.2.

Each row also carries `acknowledgement` — `null` while the finding is still an open question,
and otherwise the explanation, when it was recorded, who recorded it, and `annotationId`: the
[cost annotation](./cost-reports.md#annotations) it created. `annotationId` is `null` once that
note has been deleted, which removes the marker and never the acknowledgement. The annotation
carries the reverse of the link as `costAnomalyId`, so a marker on a chart is traceable back to
the finding it closed.

Explaining a finding is a `costs:write` POST:

```
POST /api/org/{orgId}/costs/anomalies/{anomalyId}/acknowledge
{ "explanation": "Migrated the API fleet to Graviton" }
```

The reply is the updated anomaly. The annotation's date (the anomalous day) and its org-wide
scope are derived server-side and are not part of the body — a client that could date the note
would be a client that could put the marker on the wrong bar. Posting again replaces the
sentence and rewords the note rather than filing a second one, and will not recreate a note that
has been deleted. It does not suppress anything: a later spike on the same key is a new
anomaly.

Feedback, suppressions and the two reports that come from them:

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

The reply is `{ anomaly, suppression }`. `suppress` is only accepted with `"verdict":
"expected"`; its `scope` and `scopeKey` default to the anomaly's own provider or service and
its `expiresOn` to the recurrence's default lifetime. Anomaly rows carry `feedback` (the
verdict, reason, note, who and when, and the suppression it created) and `suppressionId` (the
suppression that kept the finding from alerting), both `null` when absent. Writes need
`costs:write`. Suppressions are also a [Terraform resource](./terraform-provider.md),
`infrawrench_anomaly_suppression`, and the MCP tools `give_cost_anomaly_feedback`,
`list_cost_anomaly_suppressions` and `get_cost_anomaly_precision` cover agents.

The thresholds are readable and writable too:

```
GET /api/org/{orgId}/costs/anomaly-settings
PUT /api/org/{orgId}/costs/anomaly-settings
```

`GET` needs `costs:read` and answers with the defaults for an organization that has never
changed them. Both carry `feedbackTuning` (the [Learn from feedback](#learning-from-feedback)
switch); it is optional on `PUT`, and omitting it keeps the stored value. `PUT` needs `costs:write` and replaces the whole object — `sigmas`,
`minDeltaCents`, `newSourceMinCents`, and `smsAlerts` (`off` | `new_source` | `all`) are all
required, and out-of-range values are rejected with a 400 rather than clamped. `smsAlerts`
deliberately has no server-side default: a client that omits it is rejected rather than
silently switching an organization's SMS paging back off.

Both responses also carry a read-only `smsConfigured` boolean — whether a text raised right now
could actually be delivered (paging enabled, Twilio credentials stored, at least one recipient
opted into SMS). It is derived, and is not accepted on `PUT`. See the
[API reference](../team-and-billing/openapi.md) for the full schema.

## Explaining an anomaly

Detection finds a spike; a person works out that it was a deliberate migration. Without
somewhere to put that, the knowledge dies in their head and the next person to open the chart
asks the same question.

**Explain** on an anomaly row opens a small composer. It is prefilled with what the row already
knows — "Amazon EC2 spend +173% — " — so you finish a sentence rather than compose one, and any
[root-cause hints](#root-cause-hints) detection collected are one click away as a starting
point. Saving does two things:

- **Records the explanation on the finding.** The row is marked **Explained**, shows the
  sentence inline, and stops counting towards the "N unexplained" total next to the section
  heading.
- **Creates a [cost annotation](./cost-reports.md#annotations) at the anomaly's day**, scoped
  org-wide, so the explanation is drawn as a marker on **every** cost chart covering that day —
  the report, the dashboard card, the overview. That is the whole point: "we migrated the fleet"
  is not a fact about whichever chart you happened to have open.

The note's date and scope are derived from the anomaly and are not editable in the composer;
there is nothing there to get wrong. Afterwards the note is an ordinary annotation — you can
reword it, narrow it to one report, or move its date from the annotation editor like any other.

A few consequences worth stating plainly:

- **Explained rows are marked, never hidden.** The detection was correct and the record matters;
  hiding it would lose the history and invite somebody to work the same spike out from scratch.
- **Explaining does not suppress detection.** If the same provider or service spikes again on a
  later day, that is a new finding and it is detected and alerted on exactly as before. An
  explained spike is explained, not exempt. Silencing a pattern is a separate, deliberate act:
  mark the finding [expected with a recurrence](#suppressions), which creates a suppression
  with an expiry you can see and edit.
- **Deleting the annotation does not reopen the anomaly.** The marker disappears from the
  charts, the row keeps its explanation and stays out of the unexplained count, and the list
  says the note was removed. Somebody did work out what that spike was, and deleting their chart
  marker is not a retraction of it.
- **Editing an explanation rewords the existing note** rather than adding a second marker to the
  same bar. If the note was deleted, the correction updates the record without putting the
  marker back.

Explaining needs `costs:write` — the same permission the annotation it creates needs. Reading
the list, and any explanations on it, needs `costs:read`. Each acknowledgement is written to the
[audit log](../team-and-billing/audit-log.md).

Explaining is a web and desktop action. The mobile app shows an explained anomaly — the badge
and the sentence — but does not compose one: the note it creates lands on charts you are not
looking at from a phone, and the answer is what mobile owes you at 7am.

![Costs panel Anomalies section with one row marked Explained showing its inline explanation, the "1 unexplained" count next to the section heading, and the Explain link on an unexplained row](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/explained-row.png)

![The Explain composer open over the Anomalies list, showing the read-only day/service/spend facts, the note box prefilled with "Amazon EC2 spend +173% — ", and a root-cause hint offered as a one-click suggestion](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/explain-composer.png)

![A cost chart with an annotation marker on the anomalous day, its popover open showing the explanation text and the "Explains a detected anomaly" line](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-anomaly-alerts/annotation-chart.png)

## Expected or unexpected: feedback

An explanation says what the spend was. Feedback says whether detection was right to raise it,
and detection learns from it. Each row on the Anomalies table has **Expected** and **Unexpected**
actions:

- **Expected**: planned or known. A launch, a migration, a seasonal peak, a price change.
- **Unexpected**: a real problem somebody needed to hear about.

Both take an optional **reason** (planned launch, migration, seasonal, pricing change, data
issue, other) and an optional **note**. With a note you can also tick "put this note on every
cost chart", which [explains](#explaining-an-anomaly) the anomaly in the same step. The row then
shows the verdict, who gave it and when. Giving feedback again replaces it, and **Clear
feedback** withdraws it.

What each verdict does:

- **Unexpected** keeps detection exactly as sensitive as it is, and offers the
  [Jira or Linear](#filing-an-anomaly-as-an-issue) file action right in the dialog, since a real
  problem usually needs somebody to go and look. If an earlier expected verdict on the same
  anomaly created a suppression, it is removed.
- **Expected** can stop the same pattern alerting again: choose a recurrence and it creates a
  [suppression](#suppressions). It also counts towards [learning from
  feedback](#learning-from-feedback).

<insert [The feedback dialog with Expected selected, reason "Seasonal", a note, recurrence "Recurring weekly", the scope picker on the anomaly's own service, the expiry date, and the "Next covered" preview line] here>

### Suppressions

A suppression says "spend in this scope is expected on these days, until this date". Mark an
anomaly expected and pick how the pattern repeats:

| Recurrence            | Covers                                                | Default lifetime |
| --------------------- | ----------------------------------------------------- | ---------------- |
| **One-off**           | Every day from the anomaly's day until it expires     | 7 days           |
| **Recurring weekly**  | The anomaly's weekday, every week                     | 90 days          |
| **Recurring monthly** | The anomaly's day of the month, give or take a day    | 180 days         |
| **Seasonal (yearly)** | The anomaly's date each year, give or take three days | 2 years          |

Lifetimes count from the anomaly's day or from today, whichever is later, and can be changed in
the dialog; a suppression can last at most three years. Monthly patterns anchored on the 29th to
31st fall on the last day of shorter months.

The **scope** defaults to the anomaly's own provider or service, and can instead be an
**account**, a **tag** value or a **cost centre**, all picked from what your organization has.
On a covered day, detection sets the scope's spend aside before judging the day:

- If the finding only existed because of that spend, it is still recorded, marked
  **Suppressed**, and not alerted on anywhere (push, Slack, Teams or SMS).
- If the rest of the day still clears the bar on its own, it alerts as normal. Declaring a
  migration in one account expected does not hide a spike somewhere else in the same service.

**Suppressions** on the Anomalies section lists every suppression: what it covers, how it
repeats, its window, the reason and note, who added it, the next days it covers, and how many
findings it has suppressed. Edit or delete any of them, or **Add suppression** by hand for a
launch you know is coming. Expired suppressions stay listed, greyed out, as a record. Deleting
one never deletes the findings it suppressed; any whose day is still being re-judged (the last
three days) can alert on the next pass. An organization can hold at most 100 active
suppressions.

<insert [The Suppressions panel listing an active weekly service suppression with its next covered days and "suppressed 3", an account-scoped one-off suppression, and an expired one greyed out] here>

### Learning from feedback

When the same provider or service keeps being marked expected, detection becomes slightly less
sensitive to it. From the second expected verdict on a key within 90 days, its spike threshold
rises by half a standard deviation per verdict, at most two more than the organization's
setting and never past 10. Any unexpected verdict on the key in the same window holds it at the
organization's setting. New spend sources are unaffected: they have no threshold to raise.

**Tune detection** shows each key feedback has moved, its threshold, and why ("raised from 3σ
to 4σ: 3 marked expected in the last 90 days"), and has a **Learn from feedback** switch (on by
default) that turns the adjustment off without losing the verdicts.

### Precision

**Precision** on the Anomalies section shows, month by month, how many anomalies were found and
suppressed, how many were marked expected and unexpected, and the share of reviewed anomalies
that were unexpected: how often an alert was a real problem. It also counts the reasons given.
A month with low precision and many expected verdicts is the cue to add a suppression or retune
detection.

<insert [The Precision panel showing six months of bars with percentages, the per-month counts, the overall line and the reasons breakdown] here>

Feedback needs the `costs:write` permission, the same as explaining; reading it needs
`costs:read`. Every verdict and every suppression change is written to the
[audit log](../team-and-billing/audit-log.md).

## Filing an anomaly as an issue

An anomaly usually needs someone to go and look at something. If your organization has
[Jira](./jira.md) or [Linear](./linear.md) connected, each row on the Anomalies table carries
a file link that opens an issue prefilled with the day, the dimension, the spend, the
baseline, the percentage over, the driving resource and what else moved, and any root-cause
hints already computed for it. Once filed,
the row shows the issue key instead, so the same spike doesn't get raised twice.

The two actions sit next to each other and answer different questions: file it when somebody
needs to go and look, explain it when you already know. A row often gets both — filed on the
morning it fired, explained the afternoon somebody found the cause.
