---
title: Stripe
description: Manage Stripe webhook endpoints and event destinations, products, prices, billing meters, Connect accounts and payouts, watch failing webhook deliveries and subscriptions, and track Stripe's own fees as cost.
sidebar_order: 51
---

Infrawrench treats Stripe as part of your infrastructure rather than as a payments dashboard: the webhooks your services depend on, the catalog and meters your billing code references, the accounts and payouts that have to keep working, and what Stripe itself charges you.

## What you can manage

- **Account**: the account the key belongs to opens straight to its overview: country, default currency, whether charges and payouts are enabled, verification requirements that are due or past due (with the deadline on the [Expiry radar](../features/expiry-radar.md)), available, pending, instant-payout and Connect-reserved balance per currency, the payout schedule, and a **subscriptions overview** (counts by status, subscriptions ending at period end, and monthly recurring revenue per currency).
- **Failing webhook deliveries**: events from the last 30 days that at least one endpoint did not acknowledge, with how many endpoints are still retrying.
- **Webhook endpoints**: create one with a searchable picker of every event type, choose whether it receives this account's events or connected accounts' events, and pin the API version its payloads use. **Edit** the URL, description and events, **Enable** or **Disable** it, or delete it. The signing secret is kept as a sensitive **Signing Secret** output, so you can export it as `STRIPE_WEBHOOK_SECRET` to a Kubernetes secret or a server.
- **Event destinations**: Stripe's newer destinations, for webhooks, Amazon EventBridge or Azure Event Grid, with thin or snapshot payloads and events from this account, the accounts it manages, or both. Create, rename, change events, enable, disable, **Send ping** and delete. EventBridge and Event Grid destinations show the partner event source or topic Stripe created, and say when it still needs activating in your cloud console.
- **Products**: create (optionally with a default price), edit the name, description, unit label, statement descriptor, tax code (picked from Stripe's list) and URL, **Archive**, **Unarchive** and delete.
- **Prices**: listed under their product. Create one-time, recurring per-seat or metered prices with product, currency and meter pickers; sub-cent amounts for metered prices work. Edit the nickname, lookup key (moved from another price if it already has it), tax behavior and active state.
- **Billing meters**: create with the event name, aggregation (sum, count or last), customer and value payload keys and pre-aggregation window, rename, **Deactivate** and **Reactivate**. The Metrics tab charts daily usage for the customers subscribed to prices on the meter.
- **Connected accounts** (Connect platforms): type, who controls the dashboard, requirement collection, losses and fees, charges and payouts state, and requirements due with their deadline. **Reject**, **Unreject** and delete.
- **Payouts**: the 100 most recent, with arrival date, method, reconciliation state and failure reason. A pending manual payout can be cancelled.
- **Report runs**: start a Reporting API report (balance summary, itemized balance changes, payout reconciliation and the rest) from a report type picker and a date range clipped to the data Stripe has. The 100 most recent runs are listed.
- **Sigma query runs**: runs of your scheduled Sigma queries, with their SQL, data freshness and result file.

<insert [Stripe account overview showing the Balance, Subscriptions and Failing Webhook Deliveries sections] here>

## Credentials

Use a **restricted key**. In the Stripe Dashboard open **Developers → API keys → Create restricted key** and set:

- **Write**: Webhook Endpoints, Event Destinations, Products, Prices, Billing Meters, Payouts, and Connect accounts if you run a platform.
- **Read**: Account, Balance, Balance Transaction Sources, Events, Subscriptions, Report Runs and Report Types, Files, and Sigma.

A secret key (`sk_…`) works too but can do anything in your account. Publishable keys (`pk_…`) are refused. A test-mode key manages your sandbox; a live key manages live mode, and Dashboard links follow whichever you used.

After adding the account, the credential check probes each area with one read and lists any permission the key is missing. It can also generate the list of permissions to tick for just the features you want.

<insert [Stripe Add-account form with a restricted key entered and the credential check listing one missing permission] here>

## Webhook signing secrets

Stripe returns an endpoint's signing secret only in the response that creates it. Endpoints and event destinations created from Infrawrench keep that secret (encrypted) as the **Signing Secret** output. For endpoints created elsewhere, reveal or roll the secret in the Dashboard; Stripe has no API for either.

## Logs

The account's **Logs** tab shows the event stream with three views: all events, events whose webhook deliveries failed, and thin (v2) events. Each line has the time, event type, the object it concerns and the event id.

## Metrics

- **Account**: per day and per currency, gross payment volume, Stripe fees, refunds, payment count and the effective fee rate (fees as a share of volume), for up to 90 days.
- **Billing meter**: daily usage (hourly for ranges under two days) for up to 10 customers with active subscriptions on the meter's prices, plus their combined total. Stripe only reports meter usage per customer, so there is no meter-wide total to read.

## Costs

Stripe has no invoice or billing API for what it charges you: its fees are taken out of your balance. Infrawrench reads them from balance transactions and reports them on the Costs page in the currency they were charged in:

- Processing fees on payments, instant payout fees, dispute fees and other fees attached to a transaction, filed under Payments, Payouts, Disputes and so on.
- VAT or GST on Stripe's fees as a **tax** charge, and fees Stripe returns on refunds as a **refund**.
- Product fees Stripe debits on their own (Billing, Radar, Connect, Tax, Identity), named from the fee's description, plus currency conversion and Stripe Tax fees.

Application fees paid to a Connect platform and withheld tax are not Stripe's fees and are left out. Up to a year of history is collected, one day at a time.

## Terraform

Products, prices, billing meters, webhook endpoints and event destinations export to Stripe's official `stripe/stripe` provider with import blocks. Tiered prices and prices where the customer chooses the amount are not exported, because the inventory does not keep their tiers.

## Status

Incidents from [stripestatus.com](https://www.stripestatus.com) show on your Stripe accounts. An incident on the Stripe API affects every Stripe resource; Billing and reporting incidents affect products, prices, meters and report runs; Dashboard and webhook incidents affect endpoints, destinations and accounts. Incidents limited to a third-party payment method are not matched to your resources.

## Limits

- Stripe has no public API for managing API keys. Creating keys programmatically is a preview limited to approved Stripe Apps, so keys stay in the Dashboard.
- Stripe does not say which endpoint failed a delivery, only that one did. Use each endpoint's **Delivery log** link for per-attempt detail.
- Product deletion only works for products without prices; archive the others.
- Price amounts, currencies and intervals cannot change after creation. Create a new price and archive the old one.
- The subscriptions overview reads the 1,000 most recent subscriptions; on larger accounts it says so. Its recurring revenue is at list price, before discounts and tax, and excludes metered items.
- Very busy accounts are read up to 10,000 balance transactions per day for cost (2,000 per day for metrics).
- Report and Sigma result files need your API key to download, so download them from the Dashboard.
