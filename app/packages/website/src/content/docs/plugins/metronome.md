---
title: Metronome
description: Import daily billable-metric usage or invoiced revenue from Metronome as a business metric, and browse customers and billable metrics.
sidebar_order: 53
---

Metronome is a usage-based billing platform. What it meters (API calls, GB processed, seats) and the revenue it invoices are usually exactly what you want to divide by in a [unit cost](../features/unit-costs.md). So the main reason to connect it is to import those numbers on a schedule. You can also browse the customers and billable metrics those imports use.

## What you can manage

- **Customers**: every active customer, with its ingest aliases, Salesforce account, billable status and custom fields. A customer's page also shows its ten most recent invoices with the period, type, status and total. Read-only.
- **Billable metrics**: every active billable metric, with its aggregation (SUM, COUNT, MAX, UNIQUE, LATEST or SQL), the aggregation key, event type filters, property filters and group keys, and the SQL for SQL metrics. Read-only. Editing a metric reprices invoices, so do that in Metronome.

## Import usage or revenue as a business metric

On a business metric, add an importer and choose a Metronome account. Each choice is a picker filled from your Metronome account:

- **Measure**: **Billable metric usage** imports one billable metric's daily total. **Invoiced revenue** imports the total of every non-void invoice for each day.
- **Billable metric** (usage): the metric to import.
- **Currency or pricing unit** (revenue): which invoices to total. USD is stored in dollars, even though Metronome reports it in cents. Other currencies and custom pricing units are stored as Metronome reports them.
- **Customer**: one customer, or **All customers**.
- **Break down by customer**: store a value per customer per day, labelled with the customer's name, so you can read unit costs per customer. The day's total stays the same.

<insert [Business metric importer form with the Metronome source selected, showing the Measure, Billable metric, Customer and Break down by customer pickers] here>

## Connect your account

You need one thing: a Metronome API token.

1. In the Metronome app, open **Developer > API tokens > + Add**.
2. Name the token and copy it before you close the dialog. Metronome won't show it again.
3. Paste it into the form.

See [Metronome's authentication guide](https://docs.metronome.com/api-reference/authentication). A token has the permissions of the user who created it. Infrawrench only reads, so a token that Metronome support has limited to read-only access is enough.

## Tips and limits

- **Metronome counts days in UTC.** If your importer uses another timezone, SUM and COUNT metrics are still exact in your local days. MAX, UNIQUE, LATEST and SQL metrics are stored on the UTC day Metronome measured them. Revenue is always stored on the UTC day Metronome bills it to.
- **Revenue for all customers is slower with many customers.** If a run times out, pick one customer or shorten the window.
- **Archived customers still count.** Usage and revenue from customers you've since archived is included, labelled with their name.
- **Draft invoices are included in revenue.** A day's revenue is what Metronome has billed for it so far, so the current period grows until the invoice is finalized and is updated on the next run.
