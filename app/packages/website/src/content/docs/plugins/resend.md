---
title: Resend
description: Manage Resend sending domains and their DNS records, API keys, webhooks with delivery history and replay, broadcasts, templates, segments, topics, contacts, suppressions and automations, and chart deliverability.
sidebar_order: 52
---

Connect a Resend team to manage what your application sends mail with, see whether it is being delivered, and keep an eye on plan limits.

## What you can manage

- **Account**: the team opens to its usage: emails sent today and this billing period against the plan's limits, contacts, domains, segments, broadcasts, automation runs, AI credits and the API rate limit. Its Metrics tab charts deliverability for every domain together, and its Logs tab shows the API request log and recently sent and received emails.
- **Domains**: each sending or receiving domain with its verification status, region, tracking and TLS settings, and a table of the DNS records it needs. Add a domain with a region picker, edit open and click tracking, the tracking subdomain, TLS and whether it sends or receives, **Verify** it after adding the records, or delete it. A domain that is not fully verified shows up on the [Posture](../features/posture-checks.md) page.
- **Required DNS records**: the DKIM key, the SPF TXT and MX records on the bounce subdomain, the inbound MX when receiving is on, and the tracking records, each with Resend's verification status. They also appear on the [Domains](../features/domains.md) page.
- **API keys**: every key with when it was last used. Create a full access key or a sending-only key limited to one domain; its token is kept as a sensitive **Token** output, so you can export it as `RESEND_API_KEY` to a Kubernetes secret or a server. Rename or delete keys. Key age appears on the [Expiry radar](../features/expiry-radar.md).
- **Webhooks**: create one with a picker of every event type, change its URL and events, **Enable**, **Disable**, **Rotate signing secret**, or delete it. The detail page lists recent deliveries with their status, and a failed one can be **Replayed** from the list. The **Signing Secret** output exports as `RESEND_WEBHOOK_SECRET`.
- **Emails**: the 100 most recently sent emails with their latest event (delivered, bounced, complained and so on). A scheduled email can be cancelled.
- **Broadcasts**: create a draft with segment and topic pickers (the form lists your verified domains for the From address), edit it while it is a draft, send it now or schedule it, cancel a scheduled send, duplicate or delete it. Each broadcast has a Metrics tab.
- **Templates**: create and edit the name, alias, sender, subject and bodies, **Publish** the draft, duplicate or delete.
- **Segments**, **topics** and **contact properties**: create, edit and delete. A segment's detail page lists its first contacts.
- **Contacts**: the 1,000 newest. Add a contact to segments, edit the name and global unsubscribe, or delete it.
- **Suppressions**: addresses Resend will not send to because they bounced, complained or were added by hand. Add one, or delete it to allow sending again.
- **Automations**: see the steps and recent runs, enable or disable, **Stop runs** in progress, rename, duplicate or delete.
- **OAuth grants**: third-party apps the team has authorised, with their scopes. Delete one to revoke it.

<insert [Resend domain detail page showing the DNS Records table with one verified and one failed record, and the Verify header action] here>

## Credentials

In the Resend dashboard open **API Keys → Create API Key**, choose **Full access** and copy the `re_…` key; it is only shown once. A **Sending access** key can only send email, so it cannot list or manage anything and the account will not connect.

<insert [Resend Add-account form with the API Key field filled in] here>

## Metrics

The account, each domain and each broadcast have a Metrics tab with sent, delivered, delivery delayed, hard and soft bounces, spam complaints, failed, suppressed, unique opens and clicks, unsubscribes, and the delivery, bounce, complaint, open and click rates. Ranges of two days or less are hourly, longer ones daily. Opens and clicks need tracking turned on for the domain. Resend caches these figures for up to 15 minutes and only keeps as much history as your plan retains.

## Quotas

The plan's limits on emails per day (free plan) and per billing period, contacts, segments, domains, automation runs and AI credits appear on the Quotas page, so you hear about a limit before Resend starts refusing mail. Limits your plan does not have are left out rather than shown as zero.

## Costs

Resend has no billing API, so Resend spend does not appear on the Costs page.

## Status

Open incidents on [resend-status.com](https://resend-status.com) show on your Resend accounts. Resend's incidents do not name a component, so each one applies to every Resend resource.

## Limits

- Resend allows 10 API requests a second per team, shared by every key. Infrawrench paces itself and waits when Resend asks it to.
- An API key's token, and its permission, are only returned when the key is created. Keys created elsewhere have no Token output.
- Audiences are deprecated in Resend in favour of segments, so Infrawrench manages segments.
- Automations can be managed but not created here, because their step graphs are built in the Resend editor.
- Contacts and suppressions list the newest 1,000; emails list the newest 100.
