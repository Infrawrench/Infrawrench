---
title: Mailgun
description: Manage Mailgun domains in the US and EU regions with their DNS records, sending and API keys, webhooks, routes, mailing lists, SMTP credentials, dedicated IP pools, tags, subaccounts and suppressions, chart daily delivery and watch the monthly sending limit.
sidebar_order: 50
---

Connect a Mailgun account to manage its sending and receiving setup across both of Mailgun's regions.

## What you can manage

- **Account**: the custom monthly sending limit and how much of it is used this month (edit it, or set it to 0 to remove it), the last 30 days of sending across every domain, and a Metrics tab with accepted, delivered, failed, complained, unsubscribed, opened and clicked mail per day. The webhook signing key is an output you can export as `MAILGUN_WEBHOOK_SIGNING_KEY`.
- **Domains** in the US and EU regions: state, DNS records, open, click and unsubscribe tracking, tracking scheme, TLS, automatic sender security, inbound spam handling, message retention and the dedicated IP pool. Edit any of them, **Verify DNS**, create domains in either region and delete them. Each domain has its own metrics, a note when Mailgun has paused its sending queue, and a **Suppressions** tab for bounces, unsubscribes, complaints and the allowlist, where you can add or remove addresses.
- **Required DNS records**: the SPF and DKIM TXT records, the tracking CNAME and the receiving MX records, with whether Mailgun found each one. These also appear on the [Domains](../features/domains.md) page.
- **API keys**: account keys with their role and domain sending keys. Create either kind (the secret is shown once) and delete them. Keys with an expiry appear on the [expiry radar](../features/expiry-radar.md), and admin keys are flagged on the [access review](../features/access-review.md).
- **Domain webhooks** and **account webhooks**: which events go to which URL. Create, change events and delete.
- **Routes**: filter expressions and actions for inbound mail. Create, edit and delete.
- **Mailing lists**: edit, create and delete lists, see the first 100 members, and add or remove members.
- **SMTP credentials**: create logins, reset passwords and delete them.
- **Dedicated IP pools** and **IPs**: create pools, rename them, add and remove IPs, link a domain, and delete pools. Deleting a pool moves its domains back to shared IPs.
- **Tags**: edit descriptions and delete tags.
- **Subaccounts**: enable or disable them, set their monthly limit, create and delete them.

<insert [Mailgun domain detail page showing the DNS records table with valid and unknown records, and the Last 30 days section] here>

## Credentials

Create an account API key in Mailgun under **Account settings → API keys → Create key**. A domain sending key will not work: it can only send mail. The **Admin** role manages everything; **Developer** manages everything except API keys.

Pick which regions to read. The same key works in both, so leave it on **US and EU** unless you only use one.

<insert [Mailgun Add-account form with the API Key filled in and Regions set to US and EU] here>

## Quotas

When the account has a custom monthly sending limit, it appears on the [Quotas](../features/quota-radar.md) page with a trend, so you are warned before Mailgun disables sending for the rest of the month.

## Costs

Mailgun has no billing API, so Mailgun spend does not appear on the Costs page.

## Status

Open incidents on [status.mailgun.com](https://status.mailgun.com) show on your Mailgun accounts. Incidents on Mailgun's deliverability tools (validation, inbox placement, spam traps, previews), which this plugin does not manage, are ignored.

## Limits

- Mailgun never returns secrets after creation: API key secrets are shown once, and SMTP passwords can only be reset.
- An API key's role cannot be changed; create a new key and delete the old one.
- Make sure you do not delete the API key this connection signs in with.
