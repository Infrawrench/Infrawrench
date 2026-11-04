---
title: Scheduled cost exports
description: Send your raw cost rows to a warehouse or object store on a schedule, as CSV or NDJSON files in Infrawrench or FOCUS (1.4 or 1.3) columns, or straight into a Snowflake or Databricks table, with late provider changes handled for you.
sidebar_order: 4
---

Use a cost export when you want the raw cost rows themselves, on a schedule, landing somewhere your warehouse or finance system already reads from. Cost graphs and the API answer questions inside Infrawrench; an export gets the data out.

An export is a saved query, a schedule and a destination. Each time it runs, Infrawrench writes **one file per period** (one per day, week or month) to an S3-compatible bucket or an HTTPS endpoint, or **replaces that period's rows in a table** in a connected Snowflake or Databricks account.

> **Cloud only.** Exports use the cost history Infrawrench Cloud collects for your org. In the desktop app you can create and run them while signed into a cloud org. Local-only mode has no cost history to export.

![Settings > Cost Exports with two exports listed: one succeeded showing object and row counts, one failed showing a red "S3 PUT failed (403): Access Denied" line](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-exports/settings-list.png)

## Read this first: providers change past spend

This section decides whether a warehouse built on these files matches your invoices.

Cloud spend is **not final on the day it happens**. Credits land late. Tax lines are recalculated. Amortization shifts when a commitment is bought mid-month. An export of "last month" run on the 1st shows what the provider reported on the 1st, and it won't match the invoice.

Infrawrench handles this in two ways, and you get both.

**1. A trailing restatement window.** Every run re-exports every period that overlaps the last _N_ days (7 by default). Each of those periods is rebuilt **in full** and written over the file it already has, so you get a better copy of the same file, never a second copy of the same days. For example, a monthly export with a 7-day window that runs on 3 August rewrites all of July, not just its last week.

**2. A collection watermark on every row.** Each row has two extra columns:

| Column                 | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `exported_at`          | When _this copy_ of the file was produced.                                                                |
| `collection_watermark` | The newest day for which **every** cost-collecting account in your org had reported when the run started. |

If your reconciliation needs certainty, hold back any period whose last day is after `collection_watermark`, because those days are still arriving. If you just want the freshest numbers, ignore the column.

Use both together. A provider that changes spend on day nine falls outside a seven-day window, and the watermark tells you which numbers might still be stale.

You can set the window from 0 to 90 days. **0 turns re-exporting off entirely.** Only do that if you're sure your providers never revise past spend, which isn't true for most.

## Create an export

Go to **Settings > Cost Exports** and click **New export**.

<insert [The New cost export dialog, showing the name, format, cadence, hour and timezone fields with the restatement window explanation visible below them] here>

### Name, format and schedule

- **Format**: `CSV` (with a header row) or `NDJSON` (one JSON object per line, which BigQuery, Snowflake and DuckDB all load directly).
- **Column layout**: Infrawrench columns (described below), [FOCUS 1.4](#focus), or FOCUS 1.3.
- **Cadence**: `daily`, `weekly` (ISO weeks starting Monday) or `monthly`. This also sets how many days go into each file.
- **Hour** and **timezone**: when the run happens, in your own time zone. The time zone also decides what "yesterday" means for period boundaries.

Runs export up to **yesterday**, never today, because today's spend isn't available from any provider yet.

### Columns

Pick which columns to include: provider, account, service, region, resource, charge type, commitment. Leaving one out **adds up the rows across it**. A provider + service export is much smaller than a per-resource one, and for most finance systems it's the right level of detail.

Add tag keys separately, as their own `tag_<key>` columns.

Every file also includes `day`, `currency`, `amount`, `usage_amount` and `usage_unit`, plus the two columns above. `usage_unit` is blank when the grouped rows use different units, since adding hours to gigabytes wouldn't mean anything.

Filters use the same [cost filters](./cloud-costs.md) as graphs and budgets, so "filtered to account X" means the same thing everywhere.

### FOCUS

Set **Column layout** to **FOCUS 1.4** and every file follows the [FinOps Open Cost and Usage Specification](https://focus.finops.org/) version 1.4 instead of the columns above, so it loads into any tool that reads FOCUS without any mapping. It works with either format: CSV, or NDJSON with the FOCUS column names as keys.

**FOCUS 1.4 or 1.3?** Pick 1.4 unless the tool you load into only understands 1.3. They differ in two places:

- 1.4 removed the deprecated `ProviderName` and `PublisherName` columns. A 1.3 file still includes them, with the same value as `ServiceProviderName`.
- 1.4 requires a tax row's `EffectiveCost` to equal its `BilledCost`. A 1.3 file writes the provider's amortized figure for tax, as 1.3 asks.

An export saved as FOCUS 1.3 keeps writing 1.3 until you change its **Column layout**, so your warehouse never gets a surprise change of columns.

A FOCUS export has fixed columns and detail. The column toggles, tag columns and cost basis above don't apply to it, but its filters and charge types do. Each row is one account, service, region, resource, tag set, charge type and commitment for one day.

| FOCUS column                                                   | What Infrawrench writes                                                                                                                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BilledCost`                                                   | The cash amount: what the provider charged that day.                                                                                                                                                                              |
| `EffectiveCost`                                                | The amortized amount, the same figure the amortized cost view uses. Usage a commitment covered reads 0 billed and its share of the commitment as effective cost; a commitment purchase reads its price as billed and 0 effective. |
| `ListCost`, `ContractedCost`                                   | Infrawrench doesn't read price lists, so there are no unit prices: usage carries its effective cost, everything else its billed cost. This understates commitment savings rather than inventing a list price.                     |
| `ChargeCategory`                                               | Usage and commitment-covered usage (and commitment discount lines) are `Usage`; commitment and support fees are `Purchase`; `Tax`; credits and refunds are `Credit`; adjustments and anything else are `Adjustment`.              |
| `ChargeFrequency`                                              | `Usage-Based` for usage, `Recurring` for purchases, `One-Time` for the rest.                                                                                                                                                      |
| `ChargePeriodStart` / `End`                                    | The day, as `[day 00:00Z, next day 00:00Z)`.                                                                                                                                                                                      |
| `BillingPeriodStart` / `End`                                   | The calendar month containing the day, in UTC.                                                                                                                                                                                    |
| `BillingAccountId` / `Name`                                    | The connected account and the name you gave it.                                                                                                                                                                                   |
| `ServiceName`, `ServiceCategory`, `ServiceSubcategory`         | The provider's service name, sorted into the FOCUS categories (the same list in 1.3 and 1.4). Anything not recognised is `Other`.                                                                                                 |
| `ServiceProviderName`, `HostProviderName`, `InvoiceIssuerName` | The provider. Rows you [push over the API](./server-push.md#cost-rows) name their `source`.                                                                                                                                       |
| `RegionId` / `RegionName`, `ResourceId` / `ResourceName`       | From the cost row. The resource name comes from your Infrawrench inventory when the resource is in it.                                                                                                                            |
| `CommitmentDiscount*`                                          | Where the provider reports which commitment a row belongs to: id, `Spend` (savings plan) or `Usage` (reservation, committed-use) category, type, name from the commitment inventory, and `Used` on usage it covered.              |
| `Tags`                                                         | Every tag as one JSON object.                                                                                                                                                                                                     |
| `PricingQuantity` / `PricingUnit`, `ChargeClass`               | Always empty. FOCUS requires the quantity columns to be empty without a SKU price id, which providers don't supply, and providers don't report which charges correct an earlier invoice.                                          |

After the FOCUS columns come Infrawrench's own, starting with `x_` as the specification requires: `x_InfrawrenchProviderId`, `x_InfrawrenchChargeType` (the more detailed charge type), `x_UsageQuantity` and `x_UsageUnit` (the consumption the provider reported), `x_ResourceType`, `x_CostEstimated` (`true` for providers whose amounts are estimated rather than billed), and `x_ExportedAt` / `x_CollectionWatermark` (the two columns described above).

Some optional FOCUS columns need data providers don't give us (SKU, pricing category, unit prices, invoice id, sub-account, capacity reservation), so they're left out, which the specification allows. The same goes for two columns 1.4 added: `InvoiceDetailId` and `CommitmentProgramEligibilityDetails`. The separate datasets 1.4 introduced (billing periods, contract commitments, invoice details) aren't written.

FOCUS 1.4 also says `BilledCost` should be the invoiced amount, not an estimate. A few providers have no billing API, so their spend is estimated from inventory. Those rows have `x_CostEstimated = true`, and you can filter on that column if your tool must only see invoiced figures.

You can also get the same file once, without a schedule:

- A cost report's **Download FOCUS CSV** link (always 1.4).
- `POST /costs/focus-export`. Pass `"version": "1.4"`. A request without it gets 1.3, and the `X-Focus-Version` response header tells you which version you got.
- `infrawrench export --format focus` (1.4, or `--focus-version 1.3`).

### If you limit an export to certain charge types

You can narrow an export to specific [charge types](./cloud-costs.md). When you do, keep in mind that **consumption is two charge types, not one.** `Usage` is what a provider billed on demand, and `Commitment-covered usage` is consumption a reservation or savings plan paid for. Selecting only `Usage` leaves out everything your commitments covered, which on a heavily committed setup is most of the compute bill.

Exports created before commitment-covered usage existed were updated to select both, so nothing already arriving in your warehouse stopped. From now on, the two are separate choices.

### Destination: S3-compatible object storage

One setting covers **AWS S3, Cloudflare R2, DigitalOcean Spaces, Scaleway Object Storage, Backblaze B2 and MinIO**. They differ only in endpoint and region.

| Field                  | What to put in it                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bucket                 | The bucket name.                                                                                                                                      |
| Key prefix             | Everything the export writes goes under it. Leave blank for the bucket root.                                                                          |
| Region                 | `eu-central-1`, `nyc3`, `fr-par`… Cloudflare R2 wants `auto`. Lowercase letters, digits and hyphens, up to 32 characters.                             |
| Endpoint               | Blank for AWS S3. Otherwise the provider's S3 API origin, e.g. `https://<account>.r2.cloudflarestorage.com` or `https://fra1.digitaloceanspaces.com`. |
| Path-style addressing  | Needed by MinIO and most self-hosted gateways. AWS, R2 and Spaces don't want it.                                                                      |
| Access key id / secret | A key pair with permission to write under the prefix, and nothing else.                                                                               |

### Destination: HTTPS endpoint

Infrawrench sends each file as the body of a `POST` (or `PUT`) to a URL you supply, with these headers:

- `Content-Type: text/csv; charset=utf-8` or `application/x-ndjson`
- `X-Infrawrench-Object-Key`: the file name it would have had in a bucket
- `X-Infrawrench-Period-Start`, `-Period-From`, `-Period-To`, `-Exported-At`, `-Collection-Watermark`

The URL is used exactly as you entered it. Nothing is added to its query string, so a pre-signed URL keeps its signature.

The URL must be `https`. Because a pre-signed URL works like a password, the URL is encrypted at rest and never shown again.

### Destination: Snowflake or Databricks table

If you've connected a [Snowflake](../plugins/snowflake.md) or [Databricks](../plugins/databricks.md) account, an export can load straight into a table there. There's no file, bucket or extra credential: the connected account's own credentials do the loading, so rotating them under **Accounts** is all you ever need to rotate.

<insert [The New cost export dialog with "Snowflake table" selected as the destination: account, warehouse, database, schema and table pickers filled in, and the least-privilege GRANT statements shown below them] here>

Tables use Infrawrench columns only. [FOCUS](#focus) is available for S3 and HTTPS destinations, so the **Column layout** setting is hidden when you pick a table. The **Format** setting doesn't apply either, since table columns are typed.

1. Pick the destination type: **Snowflake table** or **Databricks table**.
2. Pick the account.
3. Pick each field from a list of what that account can see:

| Snowflake                                                                      | Databricks                              |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| **Warehouse** runs the load (optional; the account's configured one otherwise) | **SQL warehouse** runs the load         |
| **Database**                                                                   | **Catalog** (Unity Catalog)             |
| **Schema**                                                                     | **Schema**                              |
| **Table**: pick one, or type a new name                                        | **Table**: pick one, or type a new name |

If the table doesn't exist, it's **created on the first run** with typed columns (`DATE`, `NUMBER(38, 10)` / `DECIMAL(38, 10)`, `TIMESTAMP_TZ` / `TIMESTAMP`, strings). On Snowflake, a plain name you type is upper-cased, and so are the columns, so you can query them without quotes. If you later add a column or tag to the export, the table gets the new column on the next run. Columns the export doesn't write are left alone (and loaded as `NULL`).

Every row has two extra columns before the usual ones:

| Column         | Meaning                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `export_id`    | Which export wrote the row. Several exports can share one table without touching each other's rows. |
| `period_start` | The first day of the period the row was exported in.                                                |

**Updates replace rows, they never add duplicates.** For each period a run exports, that export's rows for those days are replaced in a single transaction. The table always holds exactly one copy of each day, and a run that fails partway leaves the previous copy in place. The restatement window and `collection_watermark` work exactly as they do for files.

**Least-privilege setup.** Click **Show least-privilege setup** in the dialog (or run `infrawrench exports setup <name>`) to get the exact statements, filled in with your names and the account's role or principal. They come down to:

```sql
-- Snowflake (as the schema owner or SECURITYADMIN)
GRANT USAGE ON WAREHOUSE "LOAD_WH" TO ROLE "INFRAWRENCH_ROLE";
GRANT USAGE ON DATABASE "ANALYTICS" TO ROLE "INFRAWRENCH_ROLE";
GRANT USAGE ON SCHEMA "ANALYTICS"."FINOPS" TO ROLE "INFRAWRENCH_ROLE";
GRANT CREATE TABLE ON SCHEMA "ANALYTICS"."FINOPS" TO ROLE "INFRAWRENCH_ROLE";
-- only if the table already exists and another role owns it
GRANT SELECT, INSERT, DELETE ON TABLE "ANALYTICS"."FINOPS"."COSTS" TO ROLE "INFRAWRENCH_ROLE";
```

```sql
-- Databricks (as the schema owner or a metastore admin)
GRANT USE CATALOG ON CATALOG `main` TO `infrawrench-sp`;
GRANT USE SCHEMA, CREATE TABLE ON SCHEMA `main`.`finops` TO `infrawrench-sp`;
-- only if the table already exists and someone else owns it
GRANT SELECT, MODIFY ON TABLE `main`.`finops`.`costs` TO `infrawrench-sp`;
```

Databricks also needs **CAN USE** on the SQL warehouse (SQL Warehouses, the warehouse, **Permissions**). `CREATE TABLE` is needed even for an existing table, because each run uses a temporary table in the same schema.

### Destination address rules

S3 and HTTPS destinations are reached from Infrawrench's servers, so both follow these rules. (A table destination talks to the connected Snowflake or Databricks account, like everything else that account does.)

- **`https` only.** A plain `http://` endpoint or URL is refused, and so is one with a username or password in it.
- **Public addresses only.** A host that is, or resolves to, a private, loopback, link-local or otherwise reserved address (`10.x`, `192.168.x`, `127.0.0.1`, `169.254.169.254` and their IPv6 equivalents) is refused when you save the export and on every run. A MinIO or other gateway on a private network needs a public `https` address to receive exports.
- **No redirects.** A `3xx` response fails the run, so point the export at the final URL.

## Where the files land

Files are always named the same way:

```
{prefix}/cost-export/{exportId}/{cadence}/{periodStart}.{csv|ndjson}
```

For example:

```
warehouse/cost-export/6f1c…/daily/2026-08-07.csv
warehouse/cost-export/6f1c…/monthly/2026-07-01.ndjson
```

`periodStart` is the period's first day as `YYYY-MM-DD` for **every** cadence, so files sort by date and you don't need to know ISO week numbers to find last week's file.

Re-exporting a period writes to the _same_ name, replacing the previous copy. You'll never end up with two files that both claim to be July.

Periods still in progress are written too, up to yesterday. Tomorrow's run replaces that file with a longer version under the same name.

## Credentials

Destination credentials are encrypted at rest, like every other secret in Infrawrench, and tied to that one export.

**Nothing ever shows them again.** The API and the UI show a redacted marker (`AKIA…7F2Q`) and nothing else. When you edit an export, the credential fields start blank. Leave them blank to keep the stored credential.

## When an export fails

Failures are recorded and shown, not retried quietly in the background, the same way [cost collection failures](./cloud-costs.md#when-collection-fails) show on the Costs panel.

Each export shows the result of its last run: how many files and rows it wrote, or the HTTP status the destination returned. For S3-compatible destinations you also see the standard S3 error code when there is one. Common errors:

- `S3 PUT failed (403): AccessDenied`: the key pair can't write under that prefix.
- `S3 CreateMultipartUpload failed (404): NoSuchBucket`: the bucket doesn't exist in that region, or the endpoint is wrong.
- `HTTP POST failed (302): redirects are not followed`: the URL redirects somewhere else. Use the final URL.
- `S3 PUT refused: destination resolves to a private or reserved address`: see [destination address rules](#destination-address-rules).
- `No destination credentials are stored`: the stored credential can't be read. Re-enter it.
- `Snowflake: … Insufficient privileges …` or `Databricks: PERMISSION_DENIED …`: the connected role or principal is missing a grant. The message names what the load needs, and **Show least-privilege setup** prints the statements.
- `The connected account this export loads through no longer exists`: the account was removed. Edit the export and pick another one.

Warehouse loads retry throttled requests on their own before the run gives up.

A failed run tries again at its next scheduled time. Once you've fixed the problem, click **Run now** to run it straight away and see what it wrote. That's also a good way to test a new destination before trusting it overnight.

## From the CLI

```
infrawrench exports                    # every export, with the last run's status and error
infrawrench exports run "Finance warehouse"
infrawrench exports --json
infrawrench exports warehouses         # Snowflake/Databricks destinations, your accounts, the --target keys
infrawrench exports create --name "Finance warehouse" --plugin snowflake -a "Prod Snowflake" \
  --target database=ANALYTICS --target schema=FINOPS --target table=COSTS
infrawrench exports setup "Finance warehouse"   # the GRANT statements it needs
```

`exports create` only makes table exports. S3 and HTTPS exports need a secret, which belongs in the settings form rather than your shell history. It also takes `--cadence`, `--hour`, `--timezone`, `--restatement-days` and `--dimensions provider,account,service,region`.

`exports run` exits non-zero when the run fails, so a CI step can depend on it.

<insert [Terminal showing `infrawrench exports` with a table of three exports, one row red with "failed" and its full error printed below the table] here>

## Permissions

- **Seeing** exports needs `costs:read`, like every other cost page.
- **Creating, editing, deleting and running** one needs `org:settings:write`, not `costs:write`.

That's because an export sends the organization's entire billing history, on a schedule, to a destination the creator chose. It's a decision about where your data goes, so it sits with the people who already make those decisions.

Every change is recorded in the [audit log](../team-and-billing/audit-log.md) as `cost_export.create`, `.update`, `.delete` or `.run`, including the destination and schedule but never the credential.

## Limits

- 25 exports per organization.
- Restatement window: 0 to 90 days.
- A run writes every period that overlaps its window, so a daily export with a 90-day window writes 91 files per run (or replaces 91 days of rows in a table).

## One-off exports in the background

A scheduled export is a standing feed into your bucket or warehouse. For a single large file you download yourself, use **Export…** on a [cost report](./cost-reports.md#large-exports-in-the-background) instead. It has the same native and FOCUS layouts, runs in the background with progress, and keeps the file for 24 hours.

Over the API:

1. `POST /api/org/{orgId}/costs/exports/jobs` with a `reportId` (or an ad-hoc `query` with `from` and `to`) and a `format` of `csv`, `ndjson` or `focus`.
2. Poll `GET /api/org/{orgId}/costs/exports/jobs/{jobId}` until `status` is `succeeded`.
3. Fetch `downloadUrl`.

It only needs `costs:read`, because the file goes to the person who asked for it. From the CLI: `infrawrench export --async --format focus --last 365d --wait --out focus.csv`.

## See also

- [Cost graphs & budgets](./cloud-costs.md): where the exported data comes from.
- [Cost reports](./cost-reports.md): the same cost data as a named, reusable _graph_ rather than raw rows.
- [Pushing your own cost rows](./server-push.md#cost-rows): getting spend _into_ Infrawrench from somewhere it has no plugin for.
