---
title: Change timeline
description: See every cloud resource that appeared, changed or disappeared across all your providers, org-wide or per resource, revert changes, and get batched drift alerts.
---

The change timeline shows you what changed in your cloud inventory. Each time Infrawrench syncs an account, it records anything that differs from the last sync:

- **Appeared**: a resource Infrawrench hadn't seen before (or one that had disappeared and came back).
- **Changed**: a field, output or display name is different, with a before and after diff for each field.
- **Disappeared**: a resource Infrawrench knew about is no longer returned by the provider.

It works for every provider automatically, including newly added ones.

> **Cloud only.** Changes are recorded as Infrawrench Cloud syncs your accounts, and manual refreshes of a resource record them too. The desktop app in local-only mode doesn't collect them, so the **Changes** tile only appears once you're signed in to an organization.

## See changes across your organization

Click **Changes** in the sidebar (next to Costs) to see the feed for your whole organization, newest first. It's the same on the web app and the signed-in desktop app.

Each row shows when the change was seen, what kind it was, the resource (click it to open its detail page), its type and its account. Changed rows include a one-line summary of the fields that changed. Expand **Show diff** to see the before and after values.

![The org-level Changes feed page with a mix of Appeared/Changed/Disappeared rows, one row expanded to show a field diff](https://agent-assets.infrawrench.com/docs-screenshots/features/change-timeline/org-changes-feed.png)

You can filter by change kind or account. Results are paginated.

Rows also show a **cost impact**: how the change affected that resource's daily spend. See [Cost per change & cost per deploy](./cost-per-change.md) for how it's measured and when it shows "unknown" instead of "$0".

## On your phone

The [mobile app](./mobile-app.md) has the same feed. Open **Changes** at the top of the Resources tab. Filter with chips for change kind, account and time window (**Any time**, **24h**, **7d**, **30d**), and tap **Load more** to see older changes.

Tap an event to see every field's before and after value, the resource's id and a button to open the resource. **Changed** events also have the same [Revert](#revert-a-change) option as the web app, with the plan shown on the page.

Tapping a [drift notification](./mobile-push-notifications.md) opens the [moment view](./moment.md) for the time window that alert covered, with those changes shown alongside everything else that happened around them.

<insert [Mobile Changes screen: the filter chip rows, a list of Appeared/Changed/Disappeared events, and one event expanded showing its before → after field values] here>

## See changes for one resource

Every resource detail page has a **Changes** tab with just that resource's history. It's handy for questions like "when did this instance's IP change?" or "when did this DNS record show up?". On mobile, it's a **Changes** section on the resource's page. Tap a change to see its diff.

![A resource detail page with the Changes tab active, showing an update event with a before → after field diff](https://agent-assets.infrawrench.com/docs-screenshots/features/change-timeline/resource-changes-tab.png)

## From the CLI

The [desktop CLI](./cli.md) prints the same feed:

```sh
infrawrench changes                        # the last 50 events, newest first
infrawrench changes --last 7d              # only the past week
infrawrench changes --kind deleted         # only disappearances
infrawrench changes -a "Production GCP"    # one account (id, name, or unique prefix)
infrawrench changes --resource <id>        # one resource, with full before → after diffs
infrawrench changes --limit 200 --json     # stable JSON for scripting
```

Each line shows when the event was seen, a `+`, `~` or `-` for appeared, changed or disappeared, the resource, its type, its account and a summary of the changed fields. Add `--resource` to also see each field's before and after values for one resource. `--json` includes every diff, plus the `total` matching your filter.

<insert [Terminal showing `infrawrench changes` output: the event table with colored +/~/- glyphs, resource names, plugin/type column, account column, and a changed-fields summary] here>

The command needs you to be signed in to the cloud. In local-only mode it tells you so and exits.

## What counts as a change

Infrawrench compares the resource's display name, its non-secret fields and its outputs (shown with an `outputs.` prefix). Reordered JSON keys don't count as a change.

Two things don't create events:

- **Fields the provider stops returning.** A value you set that the provider never echoes back (for example a root password set at create time) is kept, and isn't reported as removed.
- **Missing resources during provider errors.** If listing a resource type fails, nothing is reported as disappeared. Only a successful list that leaves out a known resource counts.

## Revert a change

Every row in the feed, and every event in a resource's **Changes** tab, has a **Revert** button. It puts the changed fields back to their previous values, the same edit you'd make by hand.

A revert is applied to the resource **as it is now**, so you see a dry run first. The dialog tells you what will happen to each field:

| Verdict              | What it means                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Will revert**      | The field still holds the value this change set, and the previous value can be written back                         |
| **No change needed** | The field is already back at its old value. Nothing is written                                                      |
| **Changed since**    | The field changed **again** after this event. It's left alone so you don't lose the newer value, and both are shown |
| **Not writable**     | The provider doesn't let Infrawrench edit this field, or its previous value can't be submitted through an edit form |
| **Provider-derived** | An `outputs.` entry. The provider computes it, so there's nothing to write                                          |

A revert can only set fields the resource's **Edit** form offers. Read-only fields, identity fields the provider won't let you rename, and secrets can't be reverted, and the dialog tells you so.

![The revert confirmation dialog for a changed resource, showing a mix of Will revert / Changed since / Not writable field verdicts above the Revert button](https://agent-assets.infrawrench.com/docs-screenshots/features/change-timeline/revert-dialog.png)

### Reverting while others are editing

Infrawrench checks the resource again right before writing, so pressing **Revert** on a dialog you opened a while ago is safe. Anything that changed in the meantime shows as **Changed since** and is left alone.

There is still a very short window (one API call) between that check and the write. If someone edits the same field in the provider's console, or a Terraform run does, in that moment, their value is overwritten without warning. Normally this isn't a concern, but keep it in mind if several people are changing things during an incident.

### What can't be reverted

- **Appearances and disappearances.** Undoing these means deleting or recreating a resource, not editing a field. The button is disabled and tells you what to do instead.
- **Events with no field diff.** There's nothing to undo.
- **Events already reverted.** Each event can be reverted once. After that it's labelled **reverted** and the button is disabled. If two people press Revert at the same time, only one write happens and the other person is told.

An event only counts as reverted once the provider accepts the write. If a revert is interrupted, the event becomes revertible again after five minutes.

If a provider is very slow and someone else's retry picks up the event first, the slow request tells you so and lists the fields it wrote. Both put back the same values, so the resource ends up correct, but read the message before retrying again.

If the revert reached the provider but the timeline didn't record it, you get an error saying the resource **has** been put back. Retry it: the retry sees the fields are already back, marks the event **reverted** and doesn't call the provider again.

### Permissions and safeguards

- Reverting needs the **Resources: write** permission, the same as editing a resource.
- An active [change freeze](../team-and-billing/change-freeze.md) blocks reverts like any other change, and an admin can override it the same way.
- Every revert that reaches the provider is recorded in the [audit log](../team-and-billing/audit-log.md) as `resource.change_revert`, with who did it, the change event and the fields written. The rare case where a slow request was overtaken is recorded with `outcome: superseded`. A revert that wrote nothing has no audit entry. In the rare case the audit entry itself fails, the API tells you.
- The revert shows up in the timeline as an ordinary **Changed** event after the next sync.

## Drift alerts

If you'd rather be told about changes than check the feed, turn on the **Drift** trigger for a [Slack channel](./slack-alerts.md), a [Microsoft Teams channel](./teams-alerts.md) or your [phone](./mobile-push-notifications.md).

Drift is the only alert trigger that starts **off**, and the only one that's batched instead of sent per event. A busy organization can see hundreds of changes in a single sync, so one message per change would quickly become noise.

Drift alerts work like a digest:

- **One message per organization per cooldown window.** The default window is 60 minutes, so you get at most 24 messages a day.
- **Each message covers everything since the last one.** Nothing is lost if a window is skipped.
- **Each message stays short.** It starts with counts, lists the first dozen changes (appearances and disappearances first) and links to the feed for the rest. Very large windows show "500+" instead of an exact count.

### Choosing what counts

Go to **Settings > Notifications > Alerts & digest > Resource drift alerts**. These settings apply to the whole organization and need the **Organization settings** permission. The per-channel toggles decide _who_ hears about drift. These settings decide _what_ and _how often_.

| Setting                    | Default    | What it does                                                                                                           |
| -------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Resources appearing**    | on         | Alert when a resource shows up that Infrawrench hadn't seen                                                            |
| **Resources disappearing** | on         | Alert when a known resource stops being returned                                                                       |
| **Field changes**          | **off**    | Alert on field updates. These make up most of the volume and are often a provider restating a value, so they start off |
| **Cooldown**               | 60 minutes | The minimum time between drift messages. Can't be set below 5 minutes                                                  |
| **Minimum changes**        | 1          | Skip windows with fewer changes than this                                                                              |
| **Accounts to watch**      | all        | Leave every box unchecked to watch everything, or tick only the accounts you care about                                |

![Settings → Notifications page showing the Resource drift alerts card: the three change-kind checkboxes with Field changes unchecked, the cooldown and minimum-changes fields, and the account checkboxes](https://agent-assets.infrawrench.com/docs-screenshots/features/change-timeline/drift-alerts-settings.png)

Only automatic syncs send drift alerts. A manual refresh still records changes in the feed but doesn't notify anyone, since you're already looking at the result.

Drift alerts aren't sent by SMS. SMS is kept for things that need to interrupt someone, such as sync incidents, budget crossings, pages, approval requests and (if you opt in) [cost anomalies](./cost-anomaly-alerts.md#paging-by-sms).

In the [mobile app](./mobile-app.md), **Settings > Notifications** has your personal **Resource drift** push toggle, so you can mute or unmute it from your phone. The organization-wide settings in the table above are changed on the web app.

## How far back it goes

Changes are kept for **90 days**, then deleted. Anything older than that (in the feed or through the API's `from` date) returns nothing, even for a resource that has existed for years. The window is the same for every organization and can't be changed.

The [weekly digest](./weekly-digest.md) counts resource churn from your inventory, not from this feed, so deleted history doesn't affect it.

To keep a permanent record, export changes while they're still in the window. `GET /api/org/{orgId}/changes` takes `from`, `to` and paging parameters and returns the same rows the UI shows.

## Requirements

- Viewing the feed needs the `resources:read` permission. Reverting needs `resources:write`. Drift alert settings need `org:settings:write`.
- Changes are recorded from the first sync after the feature is available to your organization. There's no earlier history.
- History is limited to the 90-day window described above.

The feed is also available through the [HTTP API](../team-and-billing/openapi.md): `GET /api/org/{orgId}/changes` for the paginated organization feed and `GET /api/org/{orgId}/changes/resource` for a single resource. To revert, `GET /api/org/{orgId}/changes/{changeId}/revert` returns the plan without writing anything, and `POST` to the same path applies it.

To compare two accounts with each other instead of one account with its past, use [environment diff](./environment-diff.md).
