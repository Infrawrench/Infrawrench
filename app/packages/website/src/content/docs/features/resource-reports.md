---
title: Resource reports
description: Save a filtered table of your synced resources across every account, pick its columns from their metadata, tags and virtual tags, and see what each resource costs.
sidebar_order: 4
---

A [cost report](./cost-reports.md) shows where the money went. A **resource report** shows what you have and what each thing costs: one row per resource, across every connected account and provider, with the columns you choose in the order you choose.

Use one for an inventory of production databases with their owners, every instance type a team runs with last month's spend next to this month's, or everything created this quarter that nobody tagged.

> **Cloud only.** Resource reports need Infrawrench Cloud. In the desktop app, the Resource reports tab appears when you're signed in to a cloud org.

## Open Resource reports

Click **Resource reports** in the sidebar, next to **Reports**. The page lists your organization's saved resource reports, grouped by folder.

<insert [The Resource reports list with three saved reports, two at the top level and one inside a "Platform" folder, each showing its column and filter counts, and the New report button at the top right] here>

## Build a report

1. Click **New report**. A draft opens with name, type, account, region, status and accrued cost columns, already showing your resources.
2. Click **Columns** to choose what the table shows, and **Filters** to choose which resources it includes. The table updates as you go, before anything is saved.
3. Click **Save report**, give it a name, an optional description and a folder, and save.

To change a saved report's columns, filters or sort, do the same and click **Save**. Until you do, changes are only on your screen.

### Choose columns

<insert [The Columns dialog: the Available list on the left with Resource, Cost, Metadata, Tags and Virtual tags groups and a search box, the Shown list on the right with up, down and remove buttons on each column, and the Accrued cost over and Cost basis pickers underneath] here>

Every column list is built from your own data:

- **Resource:** name, type, provider, account, region, status, created and the provider's own id. Every resource has these.
- **Metadata:** fields the selected resource types have, such as an instance's type, a database's engine version or a bucket's storage class. Narrow the report to one type and this list narrows to that type's fields.
- **Tags:** any provider tag key your resources have (type another key if it isn't listed). Each row shows that resource's value. Hidden and preferred [tag keys](./tag-keys.md) apply to this list.
- **Virtual tags:** any [virtual tag](./virtual-tags.md). A resource's value comes from its own spend over the report's cost range. If a split divides it, you see the value with the most spend. A resource with no cost data has no value.
- **Cost:** accrued cost over the report's cost range, month to date, and the previous calendar month.

The first column links to the resource's detail page. You can have up to 40 columns.

### Cost columns

Costs are matched to resources by the provider's resource id, the same way as in the [orphan finder](./orphan-finder.md) and change cost impacts. Providers that bill per resource (AWS, Azure and Google Cloud with resource-level billing data, and many others) fill these columns. A provider that only bills per service or per account leaves them empty, and a note above the table says so.

Choose the window **Accrued cost** covers under **Columns**: a rolling range such as the last 30 days, or month to date. **Month to date** and **Previous month** are always calendar months in UTC. The cost basis (cash, amortized or blended) is the same choice cost graphs offer.

A resource billed in two currencies shows both amounts. Sorting by a cost column sorts by the currency with the most spend in the report.

Cost and virtual tag columns respect [cost visibility](../team-and-billing/cost-visibility.md). A member with scoped cost visibility only sees the spend their scope allows, and a member who can't read costs sees the inventory with those columns empty.

### Filter resources

<insert [The Filters dialog with Providers set to AWS, two accounts picked, the Resource types picker open listing EC2 Instance (42) and RDS Instance (7), a Name contains field, the created date range, and one tag condition "env is any of prod"] here>

Every filter is a picker filled from your own resources, showing how many resources have each value:

- **Providers**, **Accounts** and **Resource types**. Picking providers narrows the account and type lists.
- **Regions** and **Statuses**. Status is the resource's state as the provider reports it (`running`, `stopped`, `ACTIVE`), matched regardless of case.
- **Name contains**, regardless of case.
- **Created on or after / on or before**. This uses the provider's creation time when available, otherwise when Infrawrench first found the resource.
- **Tag conditions:** a provider tag or a virtual tag, then **is any of**, **is none of**, **is set** or **is not set**. The value picker lists the values seen for that key.

A resource appears in the report when it matches every filter you set.

## Sort, page and export

Click a column heading to sort by it, and click again to reverse. Cost columns sort most expensive first on the first click. Use **Previous** and **Next** to page through rows, and **Rows per page** to show up to 500 at once. The page size is saved with the report.

**Export CSV** downloads every matching row (up to 50,000) with all the report's columns, including tag and cost columns. Each cost column becomes one numeric column per currency, for example `Accrued cost (USD)`, so a spreadsheet can add it up. Resource and account ids are added at the end of each row.

<insert [A saved resource report open on its table: name, type, region, the instanceType metadata column, a team tag column and two cost columns, sorted by Month to date with the down arrow on that heading, and the paging controls underneath showing 1 to 50 of 312] here>

## Folders and sharing

Resource reports go in the same folders as cost reports, so a "Platform" folder can hold both the spend graphs and the inventory tables for that team. Pick the folder when you save, or under **Details**. You need edit access to a folder to put a report in it.

**Share** works the same as for [cost reports](../team-and-billing/cost-visibility.md#sharing-reports-and-dashboards): the creator owns the report, you can give people or roles view, edit or owner access, and a folder's sharing applies to every report inside it.

Viewing resource reports needs permission to read resources. Saving them needs permission to write resources.

## Large inventories

Reports that filter on provider, account, type, region, status and name, and sort by name, account, region, status or provider id, stay fast however many resources you have. Tag conditions, the created date range, and sorting by type, metadata, tag, virtual tag or cost columns work on up to 100,000 matching resources. Beyond that, the report tells you it was cut short and the total is a minimum. Narrow your filters to see everything.

## Use the CLI

```bash
# The org's resource reports
infrawrench resource-reports

# Run one: a page of rows with its tag, metadata and cost columns
infrawrench resource-reports "Production compute" --limit 100 --sort cost:mtd --desc

# Every row as CSV
infrawrench resource-reports "Production compute" --format csv --out prod-compute.csv

# Machine-readable
infrawrench resource-reports "Production compute" --json
```

Use `--offset` to page further. See the [CLI reference](./cli.md).

## On your phone

The [mobile app](./mobile-app.md) lists your resource reports under **Costs** and shows each one's rows and columns a page at a time. Tap a row to open the resource. Building and editing reports happens on web and desktop.

## Manage them as code

Manage resource reports with the [Terraform provider](./terraform-provider.md) as `infrawrench_resource_report`, and their sharing with `infrawrench_object_sharing` using `object_type = "resource_report"`.

## API

- `/api/org/{orgId}/resource-reports` lists, creates, updates and deletes reports.
- `GET …/{id}/rows` runs a saved report a page at a time (with `offset`, `limit`, `sort` and `direction`).
- `POST …/query` runs an unsaved report.
- `GET …/{id}/csv` and `POST …/csv` export CSV.
- `GET …/options` and `GET …/tag-values` return what the pickers offer.

See the [API reference](../team-and-billing/openapi.md).
