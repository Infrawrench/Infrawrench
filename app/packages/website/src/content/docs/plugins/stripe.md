---
title: Stripe
description: Manage Stripe webhook endpoints and event destinations, products, prices, billing meters, Connect accounts and payouts, watch failing webhook deliveries and subscriptions, and track Stripe's own fees as cost.
sidebar_order: 51
---

Infrawrench treats Stripe as part of your infrastructure, not as a payments dashboard. Use it to manage the webhooks your services depend on, the catalog and meters your billing code uses, the accounts and payouts that have to keep working, and to see what Stripe itself charges you.

## What you can manage

- **Account**: opens on its overview: country, default currency, whether charges and payouts are enabled, verification requirements that are due or past due (with the deadline on the [Expiry radar](../features/expiry-radar.md)), available, pending, instant-payout and Connect-reserved balance per currency, the payout schedule, and a **subscriptions overview** (counts by status, subscriptions ending at period end, and monthly recurring revenue per currency).
- **Failing webhook deliveries**: events from the last 30 days that at least one endpoint didn't acknowledge, with how many endpoints are still retrying.
- **Webhook endpoints**: create one with a searchable picker of every event type, choose whether it gets this account's events or connected accounts' events, and pin the API version its payloads use. **Edit** the URL, description and events, **Enable** or **Disable** it, or delete it. The signing secret is kept as a sensitive **Signing Secret** output, so you can export it as `STRIPE_WEBHOOK_SECRET` to a Kubernetes secret or a server.
- **Event destinations**: Stripe's newer destinations, for webhooks, Amazon EventBridge or Azure Event Grid, with thin or snapshot payloads and events from this account, the accounts it manages, or both. Create, rename, change events, enable, disable, **Send ping** and delete. EventBridge and Event Grid destinations show the partner event source or topic Stripe created, and tell you if it still needs activating in your cloud console.
- **Products**: create (optionally with a default price), edit the name, description, unit label, statement descriptor, tax code (picked from Stripe's list) and URL, **Archive**, **Unarchive** and delete.
- **Prices**: listed under their product. Create one-time, recurring per-seat or metered prices with product, currency and meter pickers. Sub-cent amounts work for metered prices. Edit the nickname, lookup key (moved from another price if it already has it), tax behavior and active state.
- **Billing meters**: create with the event name, aggregation (sum, count or last), customer and value payload keys and pre-aggregation window. Rename, **Deactivate** and **Reactivate**. The Metrics tab charts daily usage for the customers subscribed to prices on the meter.
- **Connected accounts** (Connect platforms): type, who controls the dashboard, requirement collection, losses and fees, charges and payouts state, and requirements due with their deadline. **Reject**, **Unreject** and delete.
- **Payouts**: the 100 most recent, with arrival date, method, reconciliation state and failure reason. You can cancel a pending manual payout.
- **Report runs**: start a Reporting API report (balance summary, itemized balance changes, payout reconciliation and the rest) by picking a report type and a date range within the data Stripe has. The 100 most recent runs are listed.
- **Sigma query runs**: runs of your scheduled Sigma queries, with their SQL, data freshness and result file.

<insert [Stripe account overview showing the Balance, Subscriptions and Failing Webhook Deliveries sections] here>

## Connect your account

Use a **restricted key**. In the Stripe Dashboard, open **Developers > API keys > Create restricted key** and set:

- **Write**: Webhook Endpoints, Event Destinations, Products, Prices, Billing Meters, Payouts, and Connect accounts if you run a platform.
- **Read**: Account, Balance, Balance Transaction Sources, Events, Subscriptions, Report Runs and Report Types, Files, and Sigma.

A secret key (`sk_…`) works too, but it can do anything in your account. Publishable keys (`pk_…`) won't work. A test-mode key manages your sandbox and a live key manages live mode. Dashboard links follow whichever you used.

After you add the account, the credential check tests each area and lists any permission the key is missing. It can also generate the list of permissions to tick for just the features you want.

<insert [Stripe Add-account form with a restricted key entered and the credential check listing one missing permission] here>

## Webhook signing secrets

Stripe only shows an endpoint's signing secret when it's created. Endpoints and event destinations you create in Infrawrench keep that secret (encrypted) as the **Signing Secret** output. For endpoints created elsewhere, reveal or roll the secret in the Stripe Dashboard.

## Logs

The account's **Logs** tab shows the event stream in three views: all events, events whose webhook deliveries failed, and thin (v2) events. Each line has the time, event type, the object it's about and the event id.

## Metrics

- **Account**: per day and per currency, gross payment volume, Stripe fees, refunds, payment count and the effective fee rate (fees as a share of volume), for up to 90 days.
- **Billing meter**: daily usage (hourly for ranges under two days) for up to 10 customers with active subscriptions on the meter's prices, plus their combined total. Stripe only reports meter usage per customer, so there's no meter-wide total.

## Costs

Stripe takes its fees out of your balance instead of sending an invoice. Infrawrench finds them in your balance transactions and shows them on the Costs page in the currency they were charged in:

- Processing fees on payments, instant payout fees, dispute fees and other fees on a transaction, filed under Payments, Payouts, Disputes and so on.
- VAT or GST on Stripe's fees as a **tax** charge, and fees Stripe returns on refunds as a **refund**.
- Product fees Stripe charges on their own (Billing, Radar, Connect, Tax, Identity), named from the fee's description, plus currency conversion and Stripe Tax fees.

Application fees paid to a Connect platform and withheld tax aren't Stripe's fees, so they're left out. You get up to a year of history.

## Terraform

Products, prices, billing meters, webhook endpoints and event destinations export to Stripe's official `stripe/stripe` provider with import blocks. Tiered prices and prices where the customer chooses the amount aren't exported.

## Status

Incidents from [stripestatus.com](https://www.stripestatus.com) show on your Stripe accounts. A Stripe API incident affects every Stripe resource. Billing and reporting incidents affect products, prices, meters and report runs. Dashboard and webhook incidents affect endpoints, destinations and accounts. Incidents limited to a third-party payment method aren't linked to your resources.

## Limits

- You can't manage Stripe API keys here. Keys stay in the Stripe Dashboard.
- Stripe doesn't say which endpoint failed a delivery, only that one did. Use each endpoint's **Delivery log** link for per-attempt detail.
- You can only delete products without prices. Archive the others.
- Price amounts, currencies and intervals can't change after creation. Create a new price and archive the old one.
- The subscriptions overview covers the 1,000 most recent subscriptions, and says so on larger accounts. Its recurring revenue is at list price, before discounts and tax, and leaves out metered items.
- On very busy accounts, cost reads up to 10,000 balance transactions per day (2,000 per day for metrics).
- Report and Sigma result files need your API key to download, so download them from the Stripe Dashboard.
