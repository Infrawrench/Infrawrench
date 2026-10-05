---
title: Metronome
description: Import daily billable-metric usage or invoiced revenue from Metronome as a business metric, and browse customers and billable metrics.
sidebar_order: 53
---

Metronome is a usage-based billing platform. The numbers it meters (API calls, GB processed, seats) and the revenue it invoices are usually exactly the denominators a [unit cost](../features/unit-costs.md) wants, so this plugin's main job is to feed them in on a schedule. It also lists the customers and billable metrics those imports pick from.

## What you can manage

- **Customers**: every active customer, with its ingest aliases, Salesforce account, billable status and custom fields. A customer's page also shows its ten most recent invoices with the period, type, status and total. Read-only.
- **Billable metrics**: every active billable metric, with its aggregation (SUM, COUNT, MAX, UNIQUE, LATEST, or SQL), the aggregation key, event type filters, property filters and group keys, and the SQL for SQL metrics. Read-only; editing a metric reprices invoices, so it stays in Metronome.

## Import usage or revenue as a business metric

On a business metric, add an importer and choose a Metronome account. Every choice is a picker filled from your Metronome account:

- **Measure**: **Billable metric usage** imports one billable metric's daily total. **Invoiced revenue** imports the total of every non-void invoice for each day, from Metronome's daily invoice breakdowns.
- **Billable metric** (usage): the metric to import.
- **Currency or pricing unit** (revenue): which invoices to total. USD is stored in dollars even though Metronome reports it in cents; other currencies and custom pricing units are stored as Metronome reports them.
- **Customer**: one customer, or **All customers**.
- **Break down by customer**: store a value per customer per day, labelled with the customer's name, so unit costs can be read per customer. The day's total stays the same.

<insert [Business metric importer form with the Metronome source selected, showing the Measure, Billable metric, Customer and Break down by customer pickers] here>

## Credentials

One field: a Metronome API token. In the Metronome app, open **Developer**, then **API tokens**, then **+ Add**, name the token and copy it before closing the dialog; Metronome does not show it again. See [Metronome's authentication guide](https://docs.metronome.com/api-reference/authentication).

A token keeps the permissions of the user who created it. Infrawrench only reads, so a token that Metronome support has scoped to read-only access is enough.

## Tips & limits

- **Metronome counts days in UTC.** Its usage and invoice breakdown APIs only accept windows that start at UTC midnight. For SUM and COUNT metrics in an importer with another timezone, Infrawrench reads hourly usage and adds it up into your local days, which is exact. MAX, UNIQUE, LATEST and SQL metrics do not add up across hours, so their values are stored on the UTC day Metronome measured them. Revenue is always stored on the UTC day Metronome bills it to.
- **Revenue for all customers reads each customer in turn.** Metronome's invoice breakdowns are per customer, so a large customer base makes for a slower run. Pick one customer, or shorten the window, if a run times out.
- **Archived customers still count.** Usage and revenue history from customers you have since archived is included, and labelled with their name.
- **Draft invoices are included in revenue.** A day's revenue is what Metronome has billed for it so far, so the current period's numbers grow until the invoice is finalized and are restated on the next run.
