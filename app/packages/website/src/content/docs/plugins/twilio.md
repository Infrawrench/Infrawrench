---
title: Twilio
description: Track Twilio spend by product, usage category and subaccount from billed usage records, watch your balance burn down, chart message and call volume, and manage phone numbers, messaging services, Verify services, TwiML apps, subaccounts, usage triggers and API keys.
sidebar_order: 50
---

This plugin connects **your own Twilio account**. It is unrelated to the Twilio settings under Notifications, which are where Infrawrench sends its own SMS and voice pages from.

## What you can manage

- **Account**: the account you connect opens straight to its overview: type (trial or full), balance, what was billed this month and last month, broken down by product (SMS, Voice, WhatsApp, Verify, Phone Numbers and so on) and by usage category, and a Metrics tab with daily SMS sent and received, MMS, calls, call minutes and spend.
- **Subaccounts**: rename, suspend and reactivate, create new ones, and see each one's spend this month and its own daily volume. Deleting a subaccount **closes** it, which Twilio makes permanent and which releases all of its phone numbers.
- **Phone numbers**: every number you rent, with its capabilities (voice, SMS, MMS, fax), type, country, Twilio's current monthly price for it, the messaging service it sends through, its TwiML app or SIP trunk, and the subaccount that owns it. Edit its friendly name, voice and messaging webhooks, fallbacks and status callback. Deleting a number releases it, which stops the monthly charge.
- **Messaging services**: create, edit and delete, including the inbound webhook, delivery status callback, validity period and sender features (sticky sender, smart encoding, MMS converter, area code geomatch). The sender count shows how many numbers are in each.
- **Verify services**: create, edit and delete, with the last 30 days of verification attempts, conversions and conversion rate on the detail page.
- **TwiML apps**: create, edit and delete their voice and messaging URLs.
- **Usage triggers**: create, edit and delete. See [Budget alerts with usage triggers](#budget-alerts-with-usage-triggers).
- **API keys**: list, rename, create (the secret is shown once, in the key's outputs) and delete. Keys also appear on the [access review](../features/access-review.md) and the [expiry radar](../features/expiry-radar.md) for rotation.

## Credentials

You need your **Account SID** (on the Twilio Console home page, starting with `AC`) and one of:

- **An API key** (recommended): create one under **Account → API keys and tokens**, and enter its SID (starting with `SK`) and secret. A **Standard** key lists numbers, services, apps and triggers and reads the main account's spend. A **Main** key can also manage subaccounts and API keys and read the balance.
- **The auth token**: on the same page. This is the only credential Twilio lets read a subaccount's own resources and usage, so use it if you want spend split per subaccount and subaccount phone numbers listed. API keys belong to one account and cannot see into subaccounts.

Connect the **main** account rather than a subaccount: the main account's usage includes every subaccount.

Regional API keys (Twilio's IE1 and AU1 regions) are not supported; account usage, balance and subaccounts live in US1.

<insert [Twilio Add-account form with the Account SID, API Key SID and API Key Secret fields filled in and the Auth Token field left blank] here>

## Costs

Spend comes from Twilio's Usage Records API, whose prices are **what Twilio billed you**, at your rates and after volume discounts, in your account's currency. Nothing is estimated from a price list, so the totals match your invoice.

Each day is broken down by:

- **Service**: the product family, such as SMS, MMS, Voice, WhatsApp, Verify, Phone Numbers, Lookup, Elastic SIP Trunking or Video.
- **The `category` tag**: Twilio's own usage category, such as `sms-outbound-longcode` or `phonenumbers-local`.
- **The `subaccount` tag and resource** (auth token only): which subaccount spent it, linked to that subaccount's page.

Twilio's usage categories overlap: `calls` contains `calls-inbound`, which contains `calls-inbound-local`. Infrawrench keeps only the most specific category that carries a price, so nothing is counted twice, and then checks every day against Twilio's own billed total. Anything Twilio billed outside a category shows up as **Other**, so the day's total is always what Twilio charged.

With the auth token, up to 100 subaccounts are broken out individually. Spend from any beyond that, or from a subaccount the credential could not read, is shown as **Other subaccounts** rather than dropped.

History goes back two years on the first collection. The last week is re-read every day while Twilio finalises recent usage.

<insert [Costs page filtered to a Twilio account, grouped by service, showing SMS, Voice and Phone Numbers bars over a month] here>

## Balance

Twilio accounts are prepaid, so the account balance appears in [credit burndown](../features/credit-burndown.md) with a measured burn rate and runway, alongside a link to Twilio's billing page to top up. Reading the balance needs the auth token or a Main API key.

## Budget alerts with usage triggers

A usage trigger makes Twilio call a webhook when a usage category crosses a threshold, once per day, month or year. Create one from the account's **Usage Triggers** section:

1. Pick a **usage category**. The common budget categories (total spend, SMS, MMS, voice, phone numbers, WhatsApp marketing, Verify) come first, followed by every category Twilio meters on your account, with this month's spend beside each one.
2. Pick what to measure: **Price** (money), **Count** (messages, calls) or **Usage** (minutes, segments).
3. Enter the threshold and how often it repeats.
4. Enter the **webhook URL**. An Infrawrench [workflow](../features/workflows.md) webhook URL works well here: the workflow can alert through Slack, Microsoft Teams or paging.

**Total spend**, **Price** and **Every month** together is a monthly budget alert that Twilio enforces itself, independent of Infrawrench's own [budgets](../features/cloud-costs.md). The trigger's page shows its current value against the threshold.

Twilio only lets you change a trigger's name and webhook afterwards; to change the category, threshold or period, delete it and create a new one.

<insert [Create Usage Trigger form with the usage category picker open, Total spend selected, Measure set to Price and Repeats set to Every month] here>

## Unused phone numbers

A number with no voice or messaging webhook, no TwiML app, no SIP trunk and no messaging service has nothing answering it, but Twilio still bills it every month. These appear under [Potential savings](../features/orphan-finder.md), with the monthly price shown on the number's page.

## Status

Open incidents on [status.twilio.com](https://status.twilio.com) show on your Twilio accounts. SendGrid and Zipwhip components on the same page are ignored.
