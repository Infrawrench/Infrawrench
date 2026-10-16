---
title: Resource reports
description: Save a filtered table of your synced resources across every account, pick its columns from their metadata, tags and virtual tags, and see what each resource costs.
sidebar_order: 4
---

A [cost report](./cost-reports.md) answers "where did the money go". A **resource report** answers "what do we have, and what does each thing cost": one row per synced resource, across every connected account and provider, with the columns you choose in the order you choose them.

Use one for an inventory of production databases with their owners, every instance type a team runs with last month's spend beside this month's, or everything created this quarter that nobody tagged.

> **Cloud only.** A report's rows join the resources Infrawrench Cloud has synced with the spend its pollers collected. On the desktop app the Resource reports tab appears when you are signed into a cloud org.

## Open Resource reports

**Resource reports** in the sidebar, next to **Reports**. The page lists the org's saved resource reports, grouped by folder.

<insert [The Resource reports list with three saved reports, two at the top level and one inside a "Platform" folder, each showing its column and filter counts, and the New report button at the top right] here>

## Build a report

1. Click **New report**. A draft opens with name, type, account, region, status and accrued cost columns, already showing your resources.
2. Click **Columns** to choose what the table shows, and **Filters** to choose which resources it includes. The table reruns as you change either, before anything is saved.
3. Click **Save report**, give it a name, an optional description and a folder, and save.

Change the columns, filters or sort of a saved report the same way and click **Save**. Until you do, the changes are only on your screen.

### Columns

<insert [The Columns dialog: the Available list on the left with Resource, Cost, Metadata, Tags and Virtual tags groups and a search box, the Shown list on the right with up, down and remove buttons on each column, and the Accrued cost over and Cost basis pickers underneath] here>

Columns come from four places, and every list is built from your own data:

- **Resource**: name, type, provider, account, region, status, created and the provider's own id. Every resource has these.
- **Metadata**: the fields the selected resource types expose, such as an instance's type, a database's engine version or a bucket's storage class. They are read from the resource type definitions and from the keys your synced resources actually carry, so narrowing the report to one type narrows this list to that type's fields.
- **Tags**: any provider tag key your resources carry (type another key if it is not listed). Each row shows that resource's value. Hidden and preferred [tag keys](./tag-keys.md) apply to this list.
- **Virtual tags**: any [virtual tag](./virtual-tags.md). Virtual tags are rules over cost rows, so a resource's value is the one its own spend carries over the report's cost range, the value holding the most spend when a split divides it. A resource with no cost rows has no value.
- **Cost**: accrued cost over the report's cost range, month to date, and the previous calendar month.

The first column links to the resource's detail page. Up to 40 columns.

### Cost columns

Spend is joined to a resource by the provider's resource id, the same join the [orphan finder](./orphan-finder.md) and change cost impacts use. Providers that bill per resource (AWS, Azure and Google Cloud with resource-level billing data, and many others) fill these columns; a provider that only bills per service or per account leaves them empty, and the note above the table says so.

Pick the window **Accrued cost** covers under **Columns**: a rolling range such as the last 30 days, or the month to date. **Month to date** and **Previous month** are always calendar months in UTC. The cost basis (cash, amortized or blended) is the same choice cost graphs offer.

A resource billed in two currencies shows both amounts. Sorting by a cost column sorts by the currency with the most spend in the report.

Cost and virtual tag columns respect [cost visibility](../team-and-billing/cost-visibility.md): a member whose cost visibility is scoped sees only the spend their scope allows, and a member without permission to read costs sees the inventory with those columns empty.

### Filters

<insert [The Filters dialog with Providers set to AWS, two accounts picked, the Resource types picker open listing EC2 Instance (42) and RDS Instance (7), a Name contains field, the created date range, and one tag condition "env is any of prod"] here>

Every filter is a picker filled from what you have synced, with how many resources carry each value:

- **Providers**, **Accounts** and **Resource types**. Picking providers narrows the account and type lists to them.
- **Regions** and **Statuses**. The status is the resource's own state as the provider reports it (`running`, `stopped`, `ACTIVE`), matched ignoring case.
- **Name contains**, ignoring case.
- **Created on or after / on or before**. Created is the provider's creation time when the resource reports one, otherwise when Infrawrench first synced it.
- **Tag conditions**: a provider tag or a virtual tag, then **is any of**, **is none of**, **is set** or **is not set**. The value picker lists the values seen for that key.

A resource is in the report when it matches every filter you set.

## Sort, page and export

Click a column heading to sort by it, and again to reverse. Cost columns sort most expensive first on the first click. Use **Previous** and **Next** to page through the rows, and **Rows per page** to show up to 500 at once; the page size is saved with the report.

**Export CSV** downloads every matching row (up to 50,000) with all of the report's columns, including tag and cost columns. Each cost column becomes one numeric column per currency, for example `Accrued cost (USD)`, so a spreadsheet can sum it, and the resource and account ids are added at the end of each row so it can be traced back.

<insert [A saved resource report open on its table: name, type, region, the instanceType metadata column, a team tag column and two cost columns, sorted by Month to date with the down arrow on that heading, and the paging controls underneath showing 1 to 50 of 312] here>

## Folders and sharing

Resource reports are filed in the same folders as cost reports, so a "Platform" folder can hold both the spend graphs and the inventory tables for that team. Pick the folder when you save, or under **Details**. You need edit access to a folder to file a report into it.

**Share** works as it does for [cost reports](../team-and-billing/cost-visibility.md#sharing-reports-and-dashboards): the creator owns the report, you can give people or roles view, edit or owner access, and a folder's sharing reaches every report inside it, cost or resource.

Viewing resource reports needs permission to read resources, and saving them needs permission to write resources.

## Large inventories

Filters on provider, account, type, region, status and name run in the database, as do sorts by name, account, region, status and provider id, so those reports page quickly however many resources the org has. Tag conditions, the created date range, and sorting by a type, metadata, tag, virtual tag or cost column evaluate the matching resources in memory, up to 100,000 of them; past that the report says it was cut and the total is a lower bound. Narrow the filters to see everything.

## From the CLI

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

## On the phone

The [mobile app](./mobile-app.md) lists your resource reports under **Costs** and shows each one's rows with its columns, a page at a time, with each row opening the resource. Building and editing reports stays on web and desktop.

## As code

Manage resource reports with the [Terraform provider](./terraform-provider.md) as `infrawrench_resource_report`, and their sharing with `infrawrench_object_sharing` using `object_type = "resource_report"`.

## API

`/api/org/{orgId}/resource-reports` lists, creates, updates and deletes reports. `GET …/{id}/rows` runs a saved report a page at a time (with `offset`, `limit`, `sort` and `direction`), `POST …/query` runs an unsaved configuration, `GET …/{id}/csv` and `POST …/csv` export CSV, and `GET …/options` and `GET …/tag-values` return what the pickers offer. See the [API reference](../team-and-billing/openapi.md).
