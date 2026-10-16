---
title: Savings findings
description: Work every savings finding in one list, from Ready for review to Completed, with detected dates, summary tiles, filters and shareable saved views.
sidebar_order: 14
---

Infrawrench has several savings finders: [orphaned and idle resources](./orphan-finder.md), [oversized resources](./right-sizing.md), versions paying an [extended support](./extended-support.md) surcharge, and [unused SaaS seats](./saas-seats.md). The **Findings** list puts all of them in one place and gives each finding a status, so a team can work the backlog: review it, assign it, fix it, and see what the work has saved.

Findings is a cloud feature. It sits at the top of the **Savings** tab of the **Costs** panel on web and desktop (signed in to a cloud org), with the per-finder sections (and their **Apply**, **Remove seat** and remediation actions) below it. It is also in the CLI, over MCP, and read-only on mobile.

<insert [Costs panel Savings tab showing the Findings section: the four summary tiles, the status tabs with counts, the filter row, and the findings table with a mix of Ready for review and In progress rows] here>

## Statuses

Every finding has one of four statuses:

| Status               | Meaning                                                                     | Counts as potential savings |
| -------------------- | --------------------------------------------------------------------------- | --------------------------- |
| **Ready for review** | New, nobody has looked at it yet. Every finding starts here                 | Yes                         |
| **In progress**      | Someone is working on it                                                    | Yes                         |
| **Completed**        | Fixed, by hand or automatically (see below)                                 | No                          |
| **Archived**         | Set aside on purpose: the resource is needed, or the saving is not worth it | No                          |

Change a status from the dropdown on a row, or select several rows with the checkboxes and use **Change status** to move them together. You can add a note, which is shown under the status beside who changed it and when. Status changes are recorded in the [audit log](../team-and-billing/audit-log.md) (`savings_finding.status_changed`, one entry per finding) and sent to [event subscriptions](./event-subscriptions.md) as `savings.finding.status_changed`.

Changing a status needs the `resources:write` permission, the same as acting on the resource: archiving a finding takes it off everyone's list. Anyone with `resources:read` can see the list.

<insert [The Change status dialog for three selected findings moving to Archived, with a note filled in] here>

### Automatic completion

Findings are recomputed from your synced accounts. Every six hours Infrawrench scans every finder for every organization, and when a finder that computed successfully no longer reports a finding (the volume was deleted, the instance was resized, the seat was removed, the database was upgraded), the finding moves to **Completed** on its own, marked _Resolved automatically_. The rules:

- Only **Ready for review** and **In progress** findings are completed automatically. An **Archived** finding stays archived, and one you completed by hand keeps your note.
- A finder that failed to run (a provider API error, say) never completes anything: "could not tell" is not "it went away". The list says which finders could not run.
- If a finding that was resolved automatically comes back (the resource grew again, a new seat was assigned), it reopens as **Ready for review** with a new detected date, because it is a new occurrence.
- When the fix was recorded as a [realized saving](./realized-savings.md) (an orphan deletion or a resize, made in Infrawrench or detected on sync), the completed finding links to it.

## Detected date

Each finding shows the date it was first detected: the first time the scan, or anyone opening the list, saw it. Sort by **Newest detected** or **Oldest detected**, or filter to a detected date range, to find the findings that have been waiting longest.

## Summary tiles

The four tiles above the list:

- **Potential savings**: the monthly savings of every open (Ready for review or In progress) finding. Findings with no price are counted beside it, never added as zero. When filters are set, this tile covers the filtered findings.
- **Realized savings**: what your actions actually saved over the last 30 days, from [realized savings](./realized-savings.md). Needs `costs:read`.
- **Savings rate**: realized ÷ (realized + potential). Both are monthly figures (30 days of realized savings against the monthly saving still open), so the rate is the share of the identified opportunity you have already captured. It covers all findings, whatever the filters.
- **Open findings**: how many are Ready for review and In progress.

Every figure is per currency and never converted; with spend in several currencies the tiles show the largest.

## Filters

Filter by finding kind, provider, account, region, tag (key, and optionally a value), minimum monthly savings, detected date range, and free text. Every picker lists only what is on the list. The minimum savings is compared in each finding's own currency, and a finding with no price never passes it.

## Saved views

A saved view keeps the current status tab, filters and sort under a name. Pick **Save view**, give it a name, and open it later from the **View** picker. **Update view** saves changes to the open view; **Save as new view** keeps the original.

Views are shared like [cost reports](./cost-reports.md): the creator owns a view, and **Share** opens the same sharing dialog to give the organization, a role or a member view or edit access, or to make the view private. Deleting a view needs owner access.

<insert [The View picker open with three saved views, and the Share dialog for one of them] here>

Saved views are also part of [config as code](./config-as-code.md) (the `savingsViews` section, accounts named by display name) and can be managed with the [Terraform provider](./terraform-provider.md) as `infrawrench_savings_view`.

## Cost visibility

A finding carries money and belongs to one account, so a member with a [cost visibility scope](../team-and-billing/cost-visibility.md) sees only findings on accounts granted to them outright. Without `costs:read`, orphan findings show no figure, the same as the orphan finder itself (that figure comes from billing); right-sizing, extended support and seat figures are list prices and are shown.

## CLI

```
infrawrench savings findings
infrawrench savings findings --status all --kind orphan,oversized --min-savings 50 --json
infrawrench savings findings --view "Production waste"
infrawrench savings findings set orphan:4f6c0a52-... oversized:9a1b... --status in_progress --note "Ticket OPS-412"
infrawrench savings views
```

Each finding's key (`<kind>:<id>`) is in the first column and in `--json`. See the [CLI reference](./cli.md).

## Mobile

The mobile app shows the findings read-only at the top of the **Savings** tab of Costs: the summary tiles, status tabs, your saved views, and each finding's status, note and detected date. Changing a status and editing views happen on web and desktop.

## API

- `GET /api/org/{orgId}/savings/findings` with `status`, `kind`, `provider`, `account`, `region`, `tag`, `minSavings`, `detectedFrom`, `detectedTo`, `q`, `sort` and `view` query parameters.
- `POST /api/org/{orgId}/savings/findings/status` with `{ keys, status, note }`, up to 500 findings at a time.
- `GET|POST /api/org/{orgId}/savings-views`, `GET|PUT|DELETE /api/org/{orgId}/savings-views/{id}`.

MCP and the AI chat can read the list with `list_savings_findings`.
