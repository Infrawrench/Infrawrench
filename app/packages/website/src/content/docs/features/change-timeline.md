---
title: Change timeline
description: A cross-provider drift feed — see every resource that appeared, changed, or disappeared between polls, org-wide or per resource.
---

The change timeline is a drift feed for your whole inventory. Every time the cloud poller re-fetches an account, it compares what the provider returned against the last stored snapshot and records anything that differs:

- **Appeared** — a resource exists upstream that Infrawrench hadn't seen (or that had previously disappeared).
- **Changed** — a stored field, resolved output, or the display name differs from the previous sync, with a per-field before → after diff.
- **Disappeared** — a resource Infrawrench knew about is no longer returned by the provider.

It works for every provider automatically: the diff runs on the generic resource record Infrawrench already stores, not on provider-specific shapes, so a new plugin gets a change feed the moment its resources sync.

> **Cloud only.** Change events are recorded by Infrawrench Cloud's background poller as it syncs your accounts. Manual per-resource refreshes record events too. The desktop app in local-only mode does not collect them.

## The org-wide feed

Click **Changes** in the sidebar (next to Costs) to open the feed for the whole organization, newest first. Each row shows when the change was seen, what kind it was, the resource (click through to its detail page), its type, and the account it came from. Updates carry a one-line summary of the changed fields — expand **Show diff** to see the before → after values.

<insert [The org-level Changes feed page with a mix of Appeared/Changed/Disappeared rows, one row expanded to show a field diff] here>

Filter the feed by change kind or by account; results are paginated.

## Per-resource changes

Every resource detail page has a **Changes** tab showing that resource's own slice of the timeline — handy for answering "when did this instance's IP change?" or "when did this DNS record show up?".

<insert [A resource detail page with the Changes tab active, showing an update event with a before → after field diff] here>

## What counts as a change

The differ compares the top-level fields of the stored record: the display name, the non-secret fields the plugin's lister returns, and cached resolved outputs (shown with an `outputs.` prefix). Values are compared structurally, so reordered JSON keys are not a change.

Two things deliberately do **not** produce events:

- **Fields the lister stopped returning.** Synced state merges over stored state, so a user-supplied value the provider never echoes back (for example a root password set at create time) survives — and is not reported as removed on every cycle.
- **Absences during provider errors.** If a resource type's list call fails, its resources are left untouched and nothing is reported as disappeared. Only a successful list that omits a known resource counts.

## Requirements

- The feed needs the `resources:read` permission.
- Events accumulate from the first poll after your org picks up this feature; there is no retroactive history.

The feed is also available over the [HTTP API](../team-and-billing/openapi.md): `GET /api/org/{orgId}/changes` for the paginated org feed and `GET /api/org/{orgId}/changes/resource` for a single resource.
