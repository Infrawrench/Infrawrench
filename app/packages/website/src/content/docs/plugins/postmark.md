---
title: Postmark
description: Manage Postmark servers, message streams, sending domains and their DNS records, sender signatures, webhooks, templates, suppressions and inbound rules, and chart daily sends, bounces, spam complaints, opens and clicks.
sidebar_order: 50
---

Connect a Postmark account to see and manage everything it sends mail with, and keep an eye on deliverability.

## What you can manage

- **Servers**: every server on the account, with the last 30 days of sends, bounces, bounce rate, spam complaints, opens and clicks, bounces by type, the most recent bounces and the most recent outbound messages. Edit the name, color, open and link tracking, SMTP, the inbound webhook, inbound domain and spam threshold. Create servers (Live or Sandbox) and delete them. **Reactivate address** brings back a recipient a hard bounce turned off. The server's API token is an output, so you can export it as `POSTMARK_SERVER_TOKEN` to a Kubernetes secret or a server.
- **Message streams**: transactional, broadcast and inbound streams on each server, with their own 30-day stats, daily metrics and suppression list. Create streams, edit the name, description and unsubscribe handling, and suppress or unsuppress addresses in bulk. Deleting a stream here **archives** it. Postmark purges it 45 days later unless you **Restore** it.
- **Sending domains**: each domain with its DKIM and Return-Path status. Add domains, set a custom Return-Path, and use **Verify DKIM**, **Verify Return-Path** and **Rotate DKIM key**.
- **Required DNS records**: the DKIM TXT record, the new DKIM key during a rotation, and the Return-Path CNAME each domain needs, with whether Postmark has verified it. These also appear on the [Domains](../features/domains.md) page.
- **Sender signatures**: confirmed From addresses. Add them, edit the name, Reply-To and Return-Path, resend the confirmation email, and delete them.
- **Webhooks**: per message stream, with the events they receive (delivery, bounce, spam complaint, open, click, subscription change), basic auth, and the last 24 hours of delivery attempts. Create, edit and delete them, and **Send test events** to check the endpoint answers.
- **Templates and layouts**: create, edit (name, alias, subject, HTML and text bodies, layout) and delete.
- **Inbound rules**: addresses and domains whose inbound mail the server blocks.

<insert [Postmark server detail page showing the Last 30 days stats, Bounces by type and Recent outbound messages sections] here>

## Connect your account

Use the **account API token** (recommended). In Postmark, open **Account > API Tokens** and copy the account token. Only the account owner and admins can see it. It covers every server, domain and sender signature, so you don't need anything else.

If you can't get the account token, enter a single **server API token** instead, from the server's **API Tokens** tab. You'll then see just that server and what's inside it. Domains and sender signatures need the account token.

<insert [Postmark Add-account form with the Account API Token field filled in and the Server API Token field left blank] here>

## Metrics

Servers and message streams have a Metrics tab with one point per day: emails sent, hard bounces, soft bounces, SMTP API errors, spam complaints, opens, unique opens, clicks and unique clicks. Postmark only keeps daily stats, so there's nothing finer. Opens and clicks only count once tracking is on for the server or the message.

## Set up DNS records

Postmark doesn't host DNS. The **Required DNS records** on each sending domain are the records to create at your DNS provider.

1. Add the records at your DNS provider.
2. On the domain, click **Verify DKIM** and **Verify Return-Path**. Changes can take a while to propagate.

SPF isn't listed, since Postmark no longer requires it. The Return-Path CNAME covers SPF alignment.

When you rotate the DKIM key, Postmark issues a pending key. Publish the pending record. Postmark keeps signing with the old key until the new one verifies.

## Costs

Postmark has no billing or usage API, so Postmark spend doesn't appear on the Costs page.

## Status

Open notices on [status.postmarkapp.com](https://status.postmarkapp.com), including maintenance in progress, show on your Postmark accounts. Postmark's notices don't name a component, so each one applies to every Postmark resource.

## Limits

- Not every Postmark account allows deleting servers through the API. If deleting a server fails, delete it in Postmark or ask Postmark support to enable it. Deleting a server permanently removes its message history, so archiving the streams you no longer need is usually better.
- You can suppress or unsuppress any number of addresses at once. Spam-complaint suppressions can't be removed.
