---
title: SendGrid
description: Manage Twilio SendGrid API keys, authenticated domains and link branding with their DNS records, dedicated IPs and pools, subusers, webhooks, inbound parse, templates, unsubscribe groups, verified senders, alerts and suppressions, and chart daily delivery.
sidebar_order: 50
---

Connect a Twilio SendGrid account to manage what it sends mail with and keep an eye on deliverability and credits.

## What you can manage

- **Account**: plan, sender reputation, email credits used and remaining this period, the last 30 days of requests, deliveries, bounces, blocks, spam reports, opens and clicks, and a Metrics tab with the same per day. A **Suppressions** tab shows the latest bounces, blocks, spam reports, invalid emails and global unsubscribes, and lets you remove addresses from a list or add global unsubscribes.
- **API keys**: their scopes, rename them, change scopes, create keys (Mail Send only, everything the connection can do, or picked scopes; the secret is shown once) and delete them. Keys that can create other keys are flagged on the [access review](../features/access-review.md).
- **Authenticated domains** and **link branding**: their DNS records and whether SendGrid found them. **Validate**, **Make default**, create and delete.
- **Required DNS records**: every CNAME, TXT, MX and A record SendGrid needs at your DNS provider, for domain authentication, link branding, reverse DNS and inbound parse. These also appear on the [Domains](../features/domains.md) page.
- **Dedicated IPs** with their pools and warmup state (**Start warmup** and **Stop warmup**), **reverse DNS** (create, validate, delete) and **IP pools** (create, rename, add and remove IPs, delete).
- **Subusers**: enable or disable them, change their credit allocation, see their reputation and daily sending metrics, create and delete them.
- **Event webhooks**, **Inbound Parse** hosts, **templates**, **unsubscribe groups**, **verified senders** and **alerts**: create, edit and delete, plus **Send test event**, **Resend verification**, and adding or removing addresses on an unsubscribe group.

<insert [SendGrid account overview showing email credits, the last 30 days stats and the Suppressions tab] here>

## Credentials

Create an API key in SendGrid under **Settings → API Keys → Create API Key**. **Full Access** manages everything. With **Restricted Access**, give read access to anything you want listed (Stats and Billing are needed for metrics and credits) and full access to what you want to edit.

Pick the **EU** region only for an EU regional subuser. With a parent account's key, **Act as Subuser** (under advanced options) manages one subuser instead of the parent.

<insert [SendGrid Add-account form with the API Key filled in and the Region set to Global] here>

## Quotas

The account's email credits for the current period appear on the [Quotas](../features/quota-radar.md) page, with a trend and an alert before you run out. Accounts without a credit limit report nothing there.

## Costs

SendGrid has no billing API, so SendGrid spend does not appear on the Costs page.

## Status

SendGrid incidents on [status.twilio.com](https://status.twilio.com) show on your SendGrid accounts. Incidents for other Twilio products on the same page are ignored.

## Limits

- Inbound Parse needs an MX record pointing at `mx.sendgrid.net`; SendGrid does not report whether it exists, so that record is listed without a verified state.
- The key this connection signs in with cannot be deleted from here.
