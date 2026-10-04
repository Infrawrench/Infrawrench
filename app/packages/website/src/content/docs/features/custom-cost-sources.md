---
title: Custom cost sources
description: Upload spend Infrawrench has no integration for, as a CSV or a FinOps FOCUS file, into a named source that reports like any other provider.
sidebar_order: 5
---

Some spend never arrives through an API: a colo bill, a SaaS invoice, a support contract, another tool's export. A **custom cost source** is a named home for it. You upload files into the source, and from then on it appears as its own provider in [cost graphs](./cloud-costs.md), [cost reports](./cost-reports.md), filters, budgets, allocation rules and [exports](./cost-exports.md), next to AWS or GCP.

> **Cloud only.** Sources live in the cloud cost store. The desktop app manages them while signed into a cloud org; the mobile app shows their spend in reports but does not upload.

## Create a source

Open **Settings → Custom Cost Sources** and add one. A source has:

| Field            | What it does                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Name             | Shown as the provider name everywhere. Unique in the organization. Renaming relabels the history too. |
| Default currency | Optional. Used for files that have no currency column.                                                |
| Description      | Optional note for whoever uploads next month's file.                                                  |

Every field can be edited later from the same page. Sources can also be managed as code with the [Terraform provider](./terraform-provider.md) (`infrawrench_custom_cost_source`).

<insert [Settings → Custom Cost Sources with two sources listed, one expanded to show its upload history table] here>

## Upload a file

Choose **Upload & history** on a source, then **Upload a file**. The file is read in your browser (or the desktop app): it is parsed, checked and previewed before anything is sent, and only the resulting daily rows leave your machine.

Two kinds of file are accepted:

### Generic CSV

Any export with a header row. Comma, semicolon, tab and pipe delimiters are recognised, as are quoted fields and a UTF-8 byte-order mark.

You map the file's columns to fields with pickers. Infrawrench pre-fills them from the header names (`Date`, `Usage Date`, `Cost`, `Amount`, `Service`, `Region`, `Account`, `Project` and the usual billing-export names), so the common case is checking the guesses and continuing.

| Field                     | Required | Notes                                                                                             |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| Date                      | Yes      | `2026-07-01`, ISO timestamps, `2026-07` (a month, booked on the 1st), `07/01/2026`, `01/07/2026`. |
| Cost                      | Yes      | `1,234.56`, `1.234,56`, `$12`, `(12.50)` for a credit.                                            |
| Currency                  | No       | A 3-letter code per row. Without it, the source's default currency (or the one you type) is used. |
| Service, Region, Resource | No       | Become the service, region and resource dimensions.                                               |
| Account                   | No       | The file's own account label. Splits the account dimension within the source.                     |
| Usage quantity, unit      | No       | Kept alongside the money for unit views.                                                          |
| Tags                      | No       | A JSON object or `key=value; key2=value2` pairs.                                                  |

Any column you don't map can be kept as a tag with a tick, named after its header: handy for a `Team` or `Cost centre` column.

When every date in the file could be read either month-first or day-first (`03/04/2026`), the preview asks you to pick the order rather than guessing.

### FOCUS

A file following the [FinOps Open Cost and Usage Specification](https://focus.finops.org/) (versions 1.0 to 1.4) is recognised by its column names and needs no mapping:

| FOCUS column                              | Becomes                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `ChargePeriodStart`                       | The day (timestamps are converted to UTC; hourly rows are summed per day)             |
| `BilledCost`                              | The cash cost                                                                         |
| `EffectiveCost`                           | The amortized cost, so the amortized view works for this source                       |
| `BillingCurrency`                         | The currency                                                                          |
| `ServiceName`                             | Service                                                                               |
| `RegionId` (or `RegionName`)              | Region                                                                                |
| `ResourceId` (or `ResourceName`)          | Resource                                                                              |
| `SubAccountName` / `SubAccountId`         | Account (falling back to the billing account)                                         |
| `ConsumedQuantity` / `ConsumedUnit`       | Usage (falling back to `PricingQuantity` / `PricingUnit`)                             |
| `ChargeCategory` + `CommitmentDiscountId` | Charge type: usage, commitment-covered usage, commitment fee, tax, credit, adjustment |
| `Tags`                                    | Tags                                                                                  |

Rows carrying no money on either basis and no quantity are skipped.

### Preview and validation

Before uploading you see how many lines were read, how many daily rows they aggregate to, the date range and the total per currency, the first rows exactly as they will be stored, and every line that could not be read with its line number and reason. Unreadable lines are skipped, never guessed at.

<insert [The upload panel with a CSV loaded: column mapping pickers, the preview table, and one skipped line listed with its reason] here>

## Overlapping uploads: append or replace

Each upload covers a date range. If a new file's range overlaps an earlier upload of the same source, you must choose what happens to the spend already there:

- **Replace** removes everything the source holds in the new file's date range (from any earlier upload), then adds the new file. Use it for a corrected re-export of the same period.
- **Append** keeps the earlier spend and adds the new file to it. Use it when the files cover different charges for the same days.

There is no default, because guessing wrong either doubles a month or deletes one. A replace takes effect only once the whole new file is in, so an upload interrupted halfway never removes the spend it was replacing.

## Upload history

Each source keeps its uploads: the file name, who uploaded it and when (and whether from the web, desktop or CLI), the date range, the number of daily rows and the total. An upload that a later replace superseded entirely shows as **Replaced**; one superseded partly shows what it still holds.

**Delete** on an upload removes exactly the rows it wrote, from every report. Deleting a whole source removes all of its spend and its history.

An upload interrupted before it finished shows as **Incomplete**; its rows are already visible, so delete it and upload again.

## From the CLI and API

```bash
infrawrench costs push --source "Colo invoices" --format csv --file bill.csv
infrawrench costs push --source "Partner cloud" --format focus --file focus.csv --replace
infrawrench costs sources "Colo invoices"
```

See the [CLI reference](./cli.md#pushing-back-up) for the mapping flags. The HTTP API is `/api/org/{orgId}/custom-cost-sources` (create, edit, delete sources) and a three-step upload: `POST …/{id}/uploads` declares the range and mode, `POST …/uploads/{uploadId}/rows` sends up to 5,000 daily rows at a time, and `POST …/uploads/{uploadId}/complete` finishes it. Reading needs `costs:read`; everything else needs `costs:write`, the same permission as [pushing cost rows](./server-push.md#cost-rows).

## Limits

- 1,000,000 daily rows and about three years of dates per upload. Split larger files by date.
- 32 tags per row and 256 characters per field. Tag keys beginning `infrawrench:` are reserved.
