---
title: Change timeline
description: A cross-provider drift feed — see every resource that appeared, changed, or disappeared between polls, org-wide or per resource, with optional batched drift alerts.
---

The change timeline is a drift feed for your whole inventory. Every time the cloud poller re-fetches an account, it compares what the provider returned against the last stored snapshot and records anything that differs:

- **Appeared** — a resource exists upstream that Infrawrench hadn't seen (or that had previously disappeared).
- **Changed** — a stored field, resolved output, or the display name differs from the previous sync, with a per-field before → after diff.
- **Disappeared** — a resource Infrawrench knew about is no longer returned by the provider.

It works for every provider automatically: the diff runs on the generic resource record Infrawrench already stores, not on provider-specific shapes, so a new plugin gets a change feed the moment its resources sync.

> **Cloud only.** Change events are recorded by Infrawrench Cloud's background poller as it syncs your accounts. Manual per-resource refreshes record events too. The desktop app in local-only mode does not collect them, so the **Changes** tile only appears there once you're signed in to an organization.

## The org-wide feed

Click **Changes** in the sidebar (next to Costs) to open the feed for the whole organization, newest first. It is the same page on the web app and in the desktop app when signed in. Each row shows when the change was seen, what kind it was, the resource (click through to its detail page), its type, and the account it came from. Updates carry a one-line summary of the changed fields — expand **Show diff** to see the before → after values.

<insert [The org-level Changes feed page with a mix of Appeared/Changed/Disappeared rows, one row expanded to show a field diff] here>

Filter the feed by change kind or by account; results are paginated.

## On your phone

The [mobile app](./mobile-app.md) has the same feed: open **Changes** at the top of the Resources tab. Filters are chips rather than dropdowns — change kind, account, and a time window (**Any time**, **24h**, **7d**, **30d**) — and **Load more** pages through the rest.

Tap any event to open it: the full per-field before → after list, the resource's id, and a button through to the resource itself. Tapping a [drift notification](./mobile-push-notifications.md) opens this screen already filtered to the window that alert covered, with a **Since alert** chip you can clear to widen the view.

<insert [Mobile Changes screen: the filter chip rows with "Since alert" selected, a list of Appeared/Changed/Disappeared events, and one event expanded showing its before → after field values] here>

## Per-resource changes

Every resource detail page has a **Changes** tab showing that resource's own slice of the timeline — handy for answering "when did this instance's IP change?" or "when did this DNS record show up?". On mobile it is a **Changes** section on the resource's page rather than a tab; tapping a change there expands the same diff.

<insert [A resource detail page with the Changes tab active, showing an update event with a before → after field diff] here>

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

Text mode prints one line per event — when it was seen, a `+`/`~`/`-` glyph for appeared / changed / disappeared, the resource, its type, its account, and a summary of the changed fields. Narrowing to a single resource with `--resource` also prints each update's per-field before → after values, which would be thousands of lines for a whole organization's feed. `--json` carries the full entries, including every diff, plus the `total` matching your filter.

<insert [Terminal showing `infrawrench changes` output: the event table with colored +/~/- glyphs, resource names, plugin/type column, account column, and a changed-fields summary] here>

The command is cloud-only for the same reason the page is — local-only mode has no poller, so it says so and exits rather than printing an empty table.

## What counts as a change

The differ compares the top-level fields of the stored record: the display name, the non-secret fields the plugin's lister returns, and cached resolved outputs (shown with an `outputs.` prefix). Values are compared structurally, so reordered JSON keys are not a change.

Two things deliberately do **not** produce events:

- **Fields the lister stopped returning.** Synced state merges over stored state, so a user-supplied value the provider never echoes back (for example a root password set at create time) survives — and is not reported as removed on every cycle.
- **Absences during provider errors.** If a resource type's list call fails, its resources are left untouched and nothing is reported as disappeared. Only a successful list that omits a known resource counts.

## Drift alerts

The feed is a place you go and look. If you'd rather be told, turn the **Drift** trigger on for a [Slack channel](./slack-alerts.md), a [Microsoft Teams channel](./teams-alerts.md), or your [phone](./mobile-push-notifications.md).

It is the only alert trigger that arrives **off**, and the only one that is batched rather than sent per event — both for the same reason. A budget crossing or a [cost anomaly](./cost-anomaly-alerts.md) is exceptional by construction; drift is continuous, and a single sync pass on a busy organization can record hundreds of changes. One message per change would be unreadable within a day and muted within two.

So drift alerting works like a digest:

- **One message per organization per cooldown window.** Not one per change, not one per account, not one per sync pass. The default window is 60 minutes, so the worst case is 24 messages a day no matter how much moves.
- **Each message covers everything since the last one.** A window with nothing worth saying isn't a window you miss out on — its changes roll into the next message.
- **Each message is bounded.** It leads with the counts, then names the first dozen changes — appearances and disappearances first — and links to the feed for the rest. A window with more changes than it can read reports "500+" rather than pretending to an exact number.

### Choosing what counts

**Settings → Notifications → Resource drift alerts** configures this once for the whole organization. It needs the **Organization settings** permission, and it is separate from the per-channel toggles above: those decide _who_ hears, this decides _what_ and _how often_.

| Setting                    | Default    | What it does                                                                                                                                      |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resources appearing**    | on         | Alert when a resource shows up that Infrawrench hadn't seen                                                                                       |
| **Resources disappearing** | on         | Alert when a known resource stops being returned                                                                                                  |
| **Field changes**          | **off**    | Alert on per-field updates. These are the bulk of the volume and are usually a provider restating a value, so they start silent                   |
| **Cooldown**               | 60 minutes | The least time between drift messages. Floored at 5 minutes — below the poller's own cycle the message rate would just follow the sync rate again |
| **Minimum changes**        | 1          | Skip windows smaller than this                                                                                                                    |
| **Accounts to watch**      | all        | Leave every box unchecked to watch everything, or tick the accounts worth being woken up for                                                      |

<insert [Settings → Notifications page showing the Resource drift alerts card: the three change-kind checkboxes with Field changes unchecked, the cooldown and minimum-changes fields, and the account checkboxes] here>

Only the background poller raises drift alerts. A manual refresh from the UI still records events in the feed but never notifies — the same rule sync-failure incidents follow, and for the same reason: you are already looking at the result.

Drift alerts do **not** send SMS. Twilio is reserved for things that should interrupt a human — sync incidents, budget crossings, pages, approval requests, and (opt-in) [cost anomalies](./cost-anomaly-alerts.md#paging-by-sms) — and a drift digest is a thing to read, not a thing to be woken by.

On the [mobile app](./mobile-app.md), **Settings → Notifications** carries your personal **Resource drift** push toggle, so you can mute or unmute the feed from the phone it arrives on. The organization-wide filters in the table above are set on the web app: they decide what everyone in the org hears, and retuning a shared threshold is not a thing to do one-handed.

## How far back it goes

Change events are kept for **90 days**, then deleted. The cloud poller trims the feed once an hour, so the oldest rows you can reach are always within about an hour of that window — scrolling (or asking the API for a `from` date) past 90 days returns nothing, even for a resource that has existed for years.

The window is the same for every organization and is not configurable. Nothing else depends on it: the [weekly digest](./weekly-digest.md) counts resource churn from the inventory itself, not from this feed, so a pruned change never changes a digest.

If you need a permanent record of a change, export it while it is still in the window — `GET /api/org/{orgId}/changes` takes `from`, `to`, and paging parameters and returns the same rows the UI shows.

## Requirements

- The feed needs the `resources:read` permission; the drift alert settings need `org:settings:write`.
- Events accumulate from the first poll after your org picks up this feature; there is no retroactive history.
- History is capped at the 90-day retention window described above.

The feed is also available over the [HTTP API](../team-and-billing/openapi.md): `GET /api/org/{orgId}/changes` for the paginated org feed and `GET /api/org/{orgId}/changes/resource` for a single resource.
