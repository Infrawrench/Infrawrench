---
title: Scheduled cost exports
description: Ship your raw cost rows to a warehouse or object store on a schedule, as CSV or NDJSON files in Infrawrench or FOCUS 1.3 columns, or straight into a Snowflake or Databricks table, with the restatement handling a finance system needs.
sidebar_order: 4
---

Cost graphs and the API answer questions inside Infrawrench. A **cost export** is for the other case: you want the rows themselves, on a schedule, landing somewhere your warehouse or your finance system already reads from.

An export is a saved query, a schedule, and a destination. On its cadence, Infrawrench streams your `cost_daily` rows out of storage and writes **one object per period** (one file per day, week, or month) to an S3-compatible bucket or an HTTPS endpoint, or **replaces that period's rows in a table** in a connected Snowflake or Databricks account.

> **Cloud only.** Exports run on Infrawrench Cloud's background pollers, against the cloud cost store. The desktop app can create and run them while signed into a cloud org, but local-only mode has no cost history to export.

![Settings → Cost Exports with two exports listed: one succeeded showing object and row counts, one failed showing a red "S3 PUT failed (403): Access Denied" line](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-exports/settings-list.png)

## Read this first: providers restate spend

This is the part that decides whether a warehouse built on these files reconciles or quietly drifts.

Cloud spend is **not final on the day it happens**. Credits land late. Tax lines are recomputed. Amortization schedules shift when a commitment is bought mid-month. An export of "last month" run on the 1st is a snapshot of what the provider believed on the 1st, and it will not match the invoice.

Infrawrench handles this two ways, and you get both:

**1. A trailing restatement window.** Every run re-exports every period that overlaps the last _N_ days — 7 by default. Each of those periods is rebuilt **in full** and written to the key it already occupies, so the destination ends up with a better copy of the same file, never a second copy of the same days. A monthly export with a 7-day window run on 3 August therefore rewrites all of July, not just its last week.

**2. A collection watermark on every row.** Each row carries two extra columns:

| Column                 | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `exported_at`          | When _this copy_ of the object was produced.                                                              |
| `collection_watermark` | The newest day for which **every** cost-collecting account in your org had reported when the run started. |

If your reconciliation needs certainty, hold back any period whose last day is after `collection_watermark` — those days are still arriving. If you just want the freshest numbers, ignore the column.

The window alone is not enough: a provider that restates on day nine beats a seven-day window, and nothing would tell you. The watermark alone is not enough either: knowing a number is stale does not replace it. Together they are what make the files reconcilable.

You can set the window from 0 to 90 days. **0 disables re-exporting entirely** — correct only if you are certain your providers never revise, which for most is not true.

## Create an export

Go to **Settings → Cost Exports** and click **New export**.

<insert [The New cost export dialog, showing the name, format, cadence, hour and timezone fields with the restatement window explanation visible below them] here>

### Name, format, and schedule

- **Format** — `CSV` (with a header row) or `NDJSON` (one JSON object per line, the shape BigQuery, Snowflake and DuckDB all load directly).
- **Column layout** — Infrawrench columns (described below) or [FOCUS 1.3](#focus-13).
- **Cadence** — `daily`, `weekly` (Monday-start ISO weeks), or `monthly`. This is _also_ the period definition: it decides how many days go into each object.
- **Hour** and **timezone** — when the run fires, in your own zone. The timezone also decides what "yesterday" means, which is what a period boundary is measured against.

Runs export through **yesterday**, never today. The current day's spend does not exist at any provider yet, and an object that is empty in the morning and full in the evening is worse than no object at all.

### Columns

Pick which identity columns survive into the output: provider, account, service, region, resource, charge type, commitment. Leaving one out **aggregates over it** — a provider + service export is a small fraction of the size of a per-resource one, and for most finance systems it is the right grain.

Tag keys are added separately, as their own `tag_<key>` columns.

Every object also carries `day`, `currency`, `amount`, `usage_amount` and `usage_unit`, plus the two provenance columns above. `usage_unit` is blank whenever the grouped rows disagree on a unit — summing hours and gigabytes and labelling the result "hours" would be a lie the file could not warn you about.

Filters use the same [cost filters](./cloud-costs.md) the graphs and budgets do, so "filtered to account X" means one thing everywhere.

### FOCUS 1.3

Set **Column layout** to **FOCUS 1.3** and every object follows the [FinOps Open Cost and Usage Specification](https://focus.finops.org/) version 1.3 instead of the columns above, so it loads into any tool that reads FOCUS without a mapping step. It works with either format: CSV, or NDJSON with the FOCUS column names as keys.

A FOCUS export fixes its own columns and grain. The column toggles, tag columns and cost basis above do not apply to it; its filters and charge types still do. Each row is one account, service, region, resource, tag set, charge type and commitment for one day.

| FOCUS column                                                   | What Infrawrench writes                                                                                                                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BilledCost`                                                   | The cash amount: what the provider charged that day.                                                                                                                                                                              |
| `EffectiveCost`                                                | The amortized amount, the same figure the amortized cost view uses. Usage a commitment covered reads 0 billed and its share of the commitment as effective cost; a commitment purchase reads its price as billed and 0 effective. |
| `ListCost`, `ContractedCost`                                   | No collector reads a price list, so there are no unit prices: usage carries its effective cost, everything else its billed cost. This understates commitment savings rather than inventing a list price.                          |
| `ChargeCategory`                                               | Usage and commitment-covered usage (and commitment discount lines) are `Usage`; commitment and support fees are `Purchase`; `Tax`; credits and refunds are `Credit`; adjustments and anything else are `Adjustment`.              |
| `ChargeFrequency`                                              | `Usage-Based` for usage, `Recurring` for purchases, `One-Time` for the rest.                                                                                                                                                      |
| `ChargePeriodStart` / `End`                                    | The day, as `[day 00:00Z, next day 00:00Z)`.                                                                                                                                                                                      |
| `BillingPeriodStart` / `End`                                   | The calendar month containing the day, in UTC.                                                                                                                                                                                    |
| `BillingAccountId` / `Name`                                    | The connected account and the name you gave it.                                                                                                                                                                                   |
| `ServiceName`, `ServiceCategory`, `ServiceSubcategory`         | The provider's service name, classified into the FOCUS 1.3 categories. Each provider maps its own services; anything unrecognised is `Other`.                                                                                     |
| `ServiceProviderName`, `HostProviderName`, `InvoiceIssuerName` | The provider. Rows you [push over the API](./server-push.md#cost-rows) name their `source`.                                                                                                                                       |
| `RegionId` / `RegionName`, `ResourceId` / `ResourceName`       | From the cost row. The resource name comes from your Infrawrench inventory when the resource is in it.                                                                                                                            |
| `CommitmentDiscount*`                                          | Where the provider reports which commitment a row belongs to: id, `Spend` (savings plan) or `Usage` (reservation, committed-use) category, type, name from the commitment inventory, and `Used` on usage it covered.              |
| `Tags`                                                         | Every tag as one JSON object.                                                                                                                                                                                                     |
| `PricingQuantity` / `PricingUnit`, `ChargeClass`               | Always empty: FOCUS requires the quantity columns to be empty without a SKU price id, which no provider API we collect from supplies, and no collector reports which charges correct an earlier invoice.                          |

After the FOCUS columns come Infrawrench's own, prefixed `x_` as the specification requires: `x_InfrawrenchProviderId`, `x_InfrawrenchChargeType` (the finer-grained charge type), `x_UsageQuantity` and `x_UsageUnit` (the consumption the provider reported), `x_ResourceType`, `x_CostEstimated` (`true` for providers whose amounts are estimated rather than billed), and `x_ExportedAt` / `x_CollectionWatermark` (the provenance columns described above).

Conditional FOCUS columns that need data no provider gives us (SKU, pricing category, unit prices, invoice id, sub-account, capacity reservation) are left out, which the specification allows.

The same file is available once, without a schedule, from a cost report's **Download FOCUS CSV** link, `POST /costs/focus-export`, and `infrawrench export --format focus`.

### If you restrict an export to particular charge types

An export can be narrowed to specific [charge types](./cloud-costs.md). One thing to know when you do: **consumption is two charge types, not one.** `Usage` is what a provider billed on demand, and `Commitment-covered usage` is consumption a reservation or savings plan paid for. Selecting only `Usage` excludes everything your commitments covered, which on a heavily committed estate is most of the compute bill.

Exports created before commitment-covered usage existed had `Usage` meaning "all consumption", so they were updated in place to select both — nothing that was already in your warehouse stopped arriving. From here on the two are separate choices and are taken literally.

### Destination: S3-compatible object storage

One setting covers **AWS S3, Cloudflare R2, DigitalOcean Spaces, Scaleway Object Storage, Backblaze B2 and MinIO** — they differ only in endpoint and region, and all of them speak SigV4.

| Field                  | What to put in it                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bucket                 | The bucket name.                                                                                                                                      |
| Key prefix             | Everything the export writes lives under it. Leave blank for the bucket root.                                                                         |
| Region                 | `eu-central-1`, `nyc3`, `fr-par`… Cloudflare R2 wants `auto`. Lowercase letters, digits and hyphens, up to 32 characters.                             |
| Endpoint               | Blank for AWS S3. Otherwise the provider's S3 API origin, e.g. `https://<account>.r2.cloudflarestorage.com` or `https://fra1.digitaloceanspaces.com`. |
| Path-style addressing  | Needed by MinIO and most self-hosted gateways. AWS, R2 and Spaces do not want it.                                                                     |
| Access key id / secret | A key pair with permission to write under the prefix, and nothing else.                                                                               |

### Destination: HTTPS endpoint

The object is sent as the request body of a `POST` (or `PUT`) to a URL you supply, with:

- `Content-Type: text/csv; charset=utf-8` or `application/x-ndjson`
- `X-Infrawrench-Object-Key` — the key the object would have had
- `X-Infrawrench-Period-Start`, `-Period-From`, `-Period-To`, `-Exported-At`, `-Collection-Watermark`
  The URL is sent exactly as you entered it; nothing is appended to its query string, so a pre-signed URL keeps its signature.

The URL must be `https`. It is treated as a credential in its own right — a pre-signed URL carries its own signature — so it is encrypted at rest and never shown again.

### Destination: Snowflake or Databricks table

If you have a [Snowflake](../plugins/snowflake.md) or [Databricks](../plugins/databricks.md) account connected, an export can load straight into a table there. There is no file, bucket or second credential: the connected account's own credentials do the loading, so rotating them under **Accounts** is the only rotation there is.

<insert [The New cost export dialog with "Snowflake table" selected as the destination: account, warehouse, database, schema and table pickers filled in, and the least-privilege GRANT statements shown below them] here>

A table takes Infrawrench columns only. [FOCUS 1.3](#focus-13) is available for S3 and HTTPS destinations, so the **Column layout** setting is hidden while a table is selected.

Pick the destination type (**Snowflake table** or **Databricks table**), then the account, then each field from a picker that lists what that account can see:

| Snowflake                                                                      | Databricks                              |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| **Warehouse** runs the load (optional; the account's configured one otherwise) | **SQL warehouse** runs the load         |
| **Database**                                                                   | **Catalog** (Unity Catalog)             |
| **Schema**                                                                     | **Schema**                              |
| **Table**: pick one, or type a new name                                        | **Table**: pick one, or type a new name |

A table that does not exist is **created on the first run**, with typed columns (`DATE`, `NUMBER(38, 10)` / `DECIMAL(38, 10)`, `TIMESTAMP_TZ` / `TIMESTAMP`, strings). On Snowflake a plain name you type is upper-cased, and so are the columns, so you can query them unquoted. If you later add a dimension or tag column to the export, the missing column is added to the table on the next run; columns the export does not write are left alone (and loaded as `NULL`).

Every row carries two extra columns in front of the usual ones:

| Column         | Meaning                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `export_id`    | Which export wrote the row. Several exports can share one table without touching each other's rows. |
| `period_start` | The first day of the period the row was exported in, the same value an object key would carry.      |

**Restatements replace, they never append.** For each period a run exports, the rows matching `export_id` and the period's days are deleted and the fresh rows inserted **in one transaction**, so the table always holds exactly one copy of each day, and a run that fails part-way leaves the previous copy in place. The trailing restatement window and `collection_watermark` work exactly as they do for files.

How the load works, and why:

- **Snowflake** loads through the [SQL API](https://docs.snowflake.com/en/developer-guide/sql-api/intro), which cannot upload files (`PUT` is not supported there), so the usual stage-and-`COPY INTO` path is not available without an external stage and a storage integration. Instead, rows go into a short-lived transient staging table with bound multi-row `INSERT`s (1,000 rows per request, values never in the SQL text), then one `BEGIN; DELETE …; INSERT … SELECT …; COMMIT` swaps the period in. The staging table is dropped afterwards.
- **Databricks** loads through the [SQL Statement Execution API](https://docs.databricks.com/api/workspace/statementexecution) on the SQL warehouse you picked. Rows go into a per-run staging Delta table in batches of up to 2 MiB of SQL, then one `INSERT INTO … REPLACE WHERE export_id = … AND day BETWEEN …` replaces the period in a single Delta commit. Writing to a Unity Catalog volume and running `COPY INTO` was the alternative; it needs a volume and extra grants, and `COPY INTO` deduplicates by file name, which fights a restated period rather than helping it.

**Least-privilege setup.** Click **Show least-privilege setup** in the dialog (or run `infrawrench exports setup <name>`) for the exact statements, filled in with your names and the account's role or principal. They amount to:

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

Databricks also needs **CAN USE** on the SQL warehouse (SQL Warehouses, the warehouse, **Permissions**). `CREATE TABLE` is needed even for an existing table, because each run stages through a temporary table in the same schema.

The **Format** setting does not apply to a table destination; columns are typed instead.

### Destination address rules

The S3 and HTTPS destinations are reached from Infrawrench's servers, so both follow the same rules (a table destination talks to the connected account's own Snowflake or Databricks host, like every other call that account makes):

- **`https` only.** A plain `http://` endpoint or URL is refused, and so is one with a username or password in it.
- **Public addresses only.** A host that is, or resolves to, a private, loopback, link-local or otherwise reserved address (`10.x`, `192.168.x`, `127.0.0.1`, `169.254.169.254` and their IPv6 counterparts) is refused when you save the export and again on every run. A MinIO or other gateway on a private network has to be reachable at a public `https` address to receive exports.
- **No redirects.** A `3xx` response fails the run instead of being followed, so point the export at the final URL.

## Where the objects land

The key is deterministic:

```
{prefix}/cost-export/{exportId}/{cadence}/{periodStart}.{csv|ndjson}
```

For example:

```
warehouse/cost-export/6f1c…/daily/2026-08-07.csv
warehouse/cost-export/6f1c…/monthly/2026-07-01.ndjson
```

`periodStart` is the period's first day as `YYYY-MM-DD` for **every** cadence, so keys sort lexicographically and nobody has to know ISO week numbering to find last week's file.

Determinism is the whole mechanism: re-exporting a restated period writes the _same_ key, so it replaces the previous copy. You will never end up with two files that both claim to be July.

Periods still in progress are written too, ending at yesterday. Their key does not change, so tomorrow's run replaces yesterday's object with a longer version of the same file.

## Credentials

Destination credentials are encrypted at rest with the same mechanism as every other secret in Infrawrench, bound to the export row so a ciphertext cannot be moved to another org's export.

**No endpoint ever returns them.** The API and the UI show a redacted marker (`AKIA…7F2Q`) and nothing else. When you edit an export, the credential fields start blank, and leaving them blank keeps the stored credential.

## When an export fails

A nightly export that stopped working three weeks ago is worse than never having had one, so failures are recorded and shown rather than retried in silence — the same way [cost collection failures](./cloud-costs.md#when-collection-fails) surface on the Costs panel.

Each export shows the outcome of its last run: how many objects and rows it wrote, or the HTTP status the destination answered with. For S3-compatible destinations the S3 error code is included when it is a standard one; the rest of the destination's response is not shown. Common ones:

- `S3 PUT failed (403): AccessDenied`: the key pair cannot write under that prefix.
- `S3 CreateMultipartUpload failed (404): NoSuchBucket`: the bucket does not exist in that region, or the endpoint is wrong.
- `HTTP POST failed (302): redirects are not followed`: the URL redirects somewhere else; use the final URL.
- `S3 PUT refused: destination resolves to a private or reserved address`: see [destination address rules](#destination-address-rules).
- `No destination credentials are stored` — the credential could not be decrypted; re-enter it.
- `Snowflake: … Insufficient privileges …` or `Databricks: PERMISSION_DENIED …`: the connected role or principal is missing a grant; the message names what the load needs, and **Show least-privilege setup** prints the statements.
- `The connected account this export loads through no longer exists`: the account was removed; edit the export and pick another one.

Warehouse loads also retry a throttled request on their own (Snowflake's SQL API with the same request id, so it is never applied twice; Databricks on HTTP 429) before the run gives up.

A failed run reschedules on the normal cadence rather than backing off. The cadence is already at least a day, the failure is already visible, and an extra backoff only delays recovery once somebody has fixed the credential.

**Run now** forces a run immediately, against exactly the code path the scheduler uses, and shows what it wrote — which is how you check a destination before trusting it overnight.

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

`exports create` makes table exports only (S3 and HTTPS exports take a secret, which belongs in the settings form rather than in shell history). It also takes `--cadence`, `--hour`, `--timezone`, `--restatement-days` and `--dimensions provider,account,service,region`.

`exports run` exits non-zero when the run fails, so a CI step can depend on it. Running is behind an explicit verb rather than a bare positional, because unlike `infrawrench reports <name>` this one writes to somebody's bucket.

<insert [Terminal showing `infrawrench exports` with a table of three exports, one row red with "failed" and its full error printed below the table] here>

## Permissions

- **Seeing** exports needs `costs:read`, like every other cost surface.
- **Creating, editing, deleting and running** one needs `org:settings:write` — not `costs:write`.

That step up is deliberate. `costs:write` lets someone name a report or define a cost centre: it moves numbers around _inside_ Infrawrench. Creating an export is standing authorisation to ship the organization's entire billing history, on a schedule, to a destination the creator chose, with a credential only they supplied. That is a data-egress decision, and it belongs with the people who already decide how the org handles its data.

Every mutation is written to the [audit log](../team-and-billing/audit-log.md) as `cost_export.create`, `.update`, `.delete` or `.run`, recording the destination and schedule — never the credential.

## Limits

- 25 exports per organization.
- Restatement window: 0–90 days.
- A run writes every period overlapping its window, so a daily export with a 90-day window writes 91 objects per run (or replaces 91 days of rows in a table).

## See also

- [Cost graphs & budgets](./cloud-costs.md) — where the data being exported comes from.
- [Cost reports](./cost-reports.md) — the same cost data as a named, reusable _graph_ rather than raw rows.
- [Pushing your own cost rows](./server-push.md#cost-rows) — getting spend _into_ Infrawrench from somewhere it has no plugin for.
