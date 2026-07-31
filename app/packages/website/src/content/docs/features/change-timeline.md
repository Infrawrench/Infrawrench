---
title: Change timeline
description: A cross-provider drift feed — see every resource that appeared, changed, or disappeared between polls, org-wide or per resource.
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

## Per-resource changes

Every resource detail page has a **Changes** tab showing that resource's own slice of the timeline — handy for answering "when did this instance's IP change?" or "when did this DNS record show up?".

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

## How far back it goes

Change events are kept for **90 days**, then deleted. The cloud poller trims the feed once an hour, so the oldest rows you can reach are always within about an hour of that window — scrolling (or asking the API for a `from` date) past 90 days returns nothing, even for a resource that has existed for years.

The window is the same for every organization and is not configurable. Nothing else depends on it: the [weekly digest](./weekly-digest.md) counts resource churn from the inventory itself, not from this feed, so a pruned change never changes a digest.

If you need a permanent record of a change, export it while it is still in the window — `GET /api/org/{orgId}/changes` takes `from`, `to`, and paging parameters and returns the same rows the UI shows.

## Requirements

- The feed needs the `resources:read` permission.
- Events accumulate from the first poll after your org picks up this feature; there is no retroactive history.
- History is capped at the 90-day retention window described above.

The feed is also available over the [HTTP API](../team-and-billing/openapi.md): `GET /api/org/{orgId}/changes` for the paginated org feed and `GET /api/org/{orgId}/changes/resource` for a single resource.
