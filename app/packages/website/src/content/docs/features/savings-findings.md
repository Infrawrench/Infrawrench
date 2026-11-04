---
title: Savings findings
description: Work every savings finding in one list, from Ready for review to Completed, with detected dates, summary tiles, filters and shareable saved views.
sidebar_order: 14
---

Infrawrench finds savings in several places: [orphaned and idle resources](./orphan-finder.md),
[oversized resources](./right-sizing.md), versions paying an
[extended support](./extended-support.md) surcharge, and [unused SaaS seats](./saas-seats.md).
The **Findings** list puts them all in one place and gives each one a status, so your team can
work through them: review, assign, fix, and see what the work has saved.

## Where to find it

Findings is a cloud feature. On web and desktop (signed in to a cloud organization), open the
**Costs** panel and go to the **Savings** tab. Findings is at the top, and each finder's own
section (with its **Apply**, **Remove seat** and fix actions) is below it. Findings is also in the
CLI, over MCP, and read-only on mobile.

<insert [Costs panel Savings tab showing the Findings section: the four summary tiles, the status tabs with counts, the filter row, and the findings table with a mix of Ready for review and In progress rows] here>

## Statuses

Every finding has one of four statuses:

| Status               | Meaning                                                                     | Counts as potential savings |
| -------------------- | --------------------------------------------------------------------------- | --------------------------- |
| **Ready for review** | New, nobody has looked at it yet. Every finding starts here                 | Yes                         |
| **In progress**      | Someone is working on it                                                    | Yes                         |
| **Completed**        | Fixed, by hand or automatically (see below)                                 | No                          |
| **Archived**         | Set aside on purpose: the resource is needed, or the saving is not worth it | No                          |

## Change a status

1. Use the dropdown on a row, or tick several rows and choose **Change status** to move them
   together.
2. Optionally add a note. It shows under the status, with who changed it and when.

Status changes are recorded in the [audit log](../team-and-billing/audit-log.md)
(`savings_finding.status_changed`, one entry per finding) and sent to
[event subscriptions](./event-subscriptions.md) as `savings.finding.status_changed`.

Changing a status needs the `resources:write` permission, the same as acting on the resource,
since archiving a finding takes it off everyone's list. Anyone with `resources:read` can see the
list.

<insert [The Change status dialog for three selected findings moving to Archived, with a note filled in] here>

### Automatic completion

Infrawrench rechecks your synced accounts every six hours. When a finding no longer shows up (the
volume was deleted, the instance was resized, the seat was removed, the database was upgraded),
it moves to **Completed** on its own and is marked _Resolved automatically_.

- Only **Ready for review** and **In progress** findings are completed automatically. An
  **Archived** finding stays archived, and one you completed by hand keeps your note.
- If a finder couldn't run (because of a provider API error, say), it completes nothing, since
  "couldn't tell" isn't the same as "it went away". The list tells you which finders couldn't
  run.
- If an automatically resolved finding comes back (the resource grew again, a new seat was
  assigned), it reopens as **Ready for review** with a new detected date.
- When the fix was recorded as a [realized saving](./realized-savings.md) (an orphan deletion or a
  resize, made in Infrawrench or spotted on sync), the completed finding links to it.

## Detected date

Each finding shows the date it was first detected. Sort by **Newest detected** or **Oldest
detected**, or filter to a date range, to find the findings that have waited longest.

## Summary tiles

The four tiles above the list:

- **Potential savings**: the monthly savings of every open (Ready for review or In progress)
  finding. Findings with no price are counted beside it, never added as zero. When you set
  filters, this tile covers only the filtered findings.
- **Realized savings**: what your actions actually saved over the last 30 days, from
  [realized savings](./realized-savings.md). Needs `costs:read`.
- **Savings rate**: realized ÷ (realized + potential). Both are monthly figures, so the rate is
  the share of the savings you've found that you've already captured. It covers all findings,
  whatever the filters.
- **Open findings**: how many are Ready for review or In progress.

Every figure is per currency and never converted. If you spend in several currencies, the tiles
show the largest.

## Filters

Filter by finding kind, provider, account, region, tag (key, and optionally a value), minimum
monthly savings, detected date range, and free text. Each picker lists only what's on the list.
The minimum savings is compared in each finding's own currency, and a finding with no price never
passes it.

## Saved views

A saved view keeps the current status tab, filters and sort under a name.

1. Choose **Save view** and give it a name.
2. Open it later from the **View** picker.
3. Choose **Update view** to save changes to the open view, or **Save as new view** to keep the
   original.

Views are shared like [cost reports](./cost-reports.md). The creator owns a view, and **Share**
opens the same sharing dialog, where you can give the organization, a role or a member view or
edit access, or make the view private. Deleting a view needs owner access.

<insert [The View picker open with three saved views, and the Share dialog for one of them] here>

You can also manage saved views with [config as code](./config-as-code.md) (the `savingsViews`
section, with accounts named by display name) and with the
[Terraform provider](./terraform-provider.md) as `infrawrench_savings_view`.

## Cost visibility

A member with a [cost visibility scope](../team-and-billing/cost-visibility.md) sees only findings
on accounts granted to them directly. Without `costs:read`, orphan findings show no figure, the
same as in the orphan finder, because that figure comes from billing. Right-sizing, extended
support and seat figures are list prices, so they are shown.

## CLI

```
infrawrench savings findings
infrawrench savings findings --status all --kind orphan,oversized --min-savings 50 --json
infrawrench savings findings --view "Production waste"
infrawrench savings findings set orphan:4f6c0a52-... oversized:9a1b... --status in_progress --note "Ticket OPS-412"
infrawrench savings views
```

Each finding's key (`<kind>:<id>`) is in the first column and in `--json`. See the
[CLI reference](./cli.md).

## Mobile

The mobile app shows findings read-only at the top of the **Savings** tab in Costs: the summary
tiles, status tabs, your saved views, and each finding's status, note and detected date. To change
a status or edit views, use web or desktop.

## API

- `GET /api/org/{orgId}/savings/findings` with `status`, `kind`, `provider`, `account`, `region`,
  `tag`, `minSavings`, `detectedFrom`, `detectedTo`, `q`, `sort` and `view` query parameters.
- `POST /api/org/{orgId}/savings/findings/status` with `{ keys, status, note }`, up to 500
  findings at a time.
- `GET|POST /api/org/{orgId}/savings-views`, `GET|PUT|DELETE /api/org/{orgId}/savings-views/{id}`.

MCP and the AI chat can read the list with `list_savings_findings`.
