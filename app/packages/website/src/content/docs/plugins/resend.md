---
title: Resend
description: Manage Resend sending domains and their DNS records, API keys, webhooks with delivery history and replay, broadcasts, templates, segments, topics, contacts, suppressions and automations, and chart deliverability.
sidebar_order: 52
---

Connect a Resend team to manage what your application sends mail with, check that it's being delivered, and keep an eye on plan limits.

## What you can manage

- **Account**: the team opens on its usage: emails sent today and this billing period against your plan's limits, contacts, domains, segments, broadcasts, automation runs, AI credits and the API rate limit. Its Metrics tab charts deliverability for all domains together. Its Logs tab shows the API request log and recently sent and received emails.
- **Domains**: each sending or receiving domain with its verification status, region, tracking settings and a table of the DNS records it needs. You can set TLS, but Resend doesn't report the mode back, so the page says so. Add a domain with a region picker, edit open and click tracking, the tracking subdomain, TLS and whether it sends or receives, **Verify** it after adding the records, or delete it. A domain that isn't fully verified shows up on the [Posture](../features/posture-checks.md) page.
- **Required DNS records**: the DKIM key, the SPF TXT and MX records on the bounce subdomain, the inbound MX when receiving is on, and the tracking records, each with its verification status. They also appear on the [Domains](../features/domains.md) page.
- **API keys**: every key with when it was last used. Create a full access key or a sending-only key limited to one domain. Its token is kept as a sensitive **Token** output, so you can export it as `RESEND_API_KEY` to a Kubernetes secret or a server. Rename or delete keys. Key age appears on the [Expiry radar](../features/expiry-radar.md).
- **Webhooks**: create one with a picker of every event type, change its URL and events, **Enable**, **Disable**, **Rotate signing secret**, or delete it. The detail page lists recent deliveries with their status, and you can **Replay** a failed one from the list. The **Signing Secret** output exports as `RESEND_WEBHOOK_SECRET`.
- **Emails**: the 100 most recently sent emails with their latest event (delivered, bounced, complained and so on). You can cancel a scheduled email.
- **Broadcasts**: create a draft with segment and topic pickers (the From address offers your verified domains), edit it while it's a draft, send it now or schedule it, cancel a scheduled send, duplicate or delete it. Each broadcast has a Metrics tab.
- **Templates**: create and edit the name, alias, sender, subject and bodies, **Publish** the draft, duplicate or delete.
- **Segments**, **topics** and **contact properties**: create, edit and delete. A segment's detail page lists its first contacts.
- **Contacts**: every contact, up to 50,000. Add a contact to segments, edit the name and global unsubscribe, or delete it.
- **Suppressions**: addresses Resend won't send to because they bounced, complained or were added by hand. Add one, or delete it to allow sending again.
- **Automations**: see the steps and recent runs, enable or disable, **Stop runs** in progress, rename, duplicate or delete.
- **OAuth grants**: third-party apps your team has authorised, with their scopes. Delete one to revoke it.

<insert [Resend domain detail page showing the DNS Records table with one verified and one failed record, and the Verify header action] here>

## Connect with Resend

1. Pick Resend in the add-account form and click **Connect with Resend**.
2. Sign in to Resend, choose the team and approve.

The account is named after the team's first verified domain.

- **What you're granting:** Resend offers send-only or full access. Managing domains, keys and webhooks needs full access, so that's what Infrawrench asks for. It only reads unless you act.
- **Staying connected:** the connection renews itself. If you don't use it for 60 days it expires and you'll need to reconnect.
- **Revoking:** revoke the Infrawrench grant from the account's **OAuth Grant** list (or the Resend dashboard). The account then shows **Reconnect required**.
- Works in the web app, the desktop app in cloud mode and desktop-local accounts.

## Use an API key instead

In the Resend dashboard, open **API Keys > Create API Key**, choose **Full access** and copy the `re_…` key. It's only shown once. A **Sending access** key can only send email, so it can't list or manage anything and the account won't connect.

<insert [Resend Add-account form with the API Key field filled in] here>

## Metrics

The account, each domain and each broadcast have a Metrics tab with sent, delivered, delivery delayed, hard and soft bounces, spam complaints, failed, suppressed, unique opens and clicks, unsubscribes, and the delivery, bounce, complaint, open and click rates. Ranges of two days or less are hourly, longer ones daily. Opens and clicks need tracking turned on for the domain. Figures can be up to 15 minutes old, and history only goes back as far as your plan keeps it.

## Quotas

Your plan's limits on emails per day (free plan) and per billing period, contacts, segments, domains, automation runs and AI credits appear on the Quotas page, so you hear about a limit before Resend starts refusing mail. Limits your plan doesn't have are left out rather than shown as zero.

## Costs

Resend has no billing API, so Resend spend doesn't appear on the Costs page.

## Status

Open incidents on [resend-status.com](https://resend-status.com) show on your Resend accounts. Resend's incidents don't name a component, so each one applies to every Resend resource.

## Limits

- Resend allows 10 API requests a second per team, shared by every key. Infrawrench paces itself to stay under that.
- An API key's token is only shown when the key is created. Keys created elsewhere have no Token output.
- Resend has replaced audiences with segments, so Infrawrench manages segments.
- You can manage automations here but not create them. Build them in the Resend editor.
- Contacts and suppressions are read whole, up to 50,000 each. Emails list the newest 100.
