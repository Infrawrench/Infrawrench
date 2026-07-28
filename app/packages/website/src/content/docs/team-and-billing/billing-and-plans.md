---
title: Billing and plans
description: What is free, what is paid, and how to upgrade.
sidebar_order: 3
---

> **Web only.** The desktop app is free and has no account.

## Plans

| Feature            | Free                   | Paid                   |
| ------------------ | ---------------------- | ---------------------- |
| Users              | 1                      | Unlimited              |
| Connected accounts | 3                      | Unlimited              |
| Plugins            | All 26                 | All 26                 |
| Dashboards         | Yes                    | Yes                    |
| SSH terminal / SQL | Yes                    | Yes                    |
| Audit log          | No                     | Yes                    |
| API keys           | No                     | Yes                    |
| AI chat            | $5 usage / mo included | Metered, pay-as-you-go |
| Price              | $0                     | $20 / seat / mo        |

Free orgs (no payment method on file) can use the [AI chat](../features/ai-chat.md) up to **$5 of metered usage per month**; after that the agent refuses new turns until the next month or until you upgrade. Paid orgs are billed for chat usage through Stripe with no built-in limit (set your own cap in **Settings → Billing → Chat cap**).

## Upgrade

**Settings → Billing → Upgrade**. We use Stripe. Add a card, pick a seat count, and you are on the paid plan immediately.

<insert [Billing page with plan cards and a seat count selector] here>

## Seats

A seat is one user in your organization. If you invite a fourth teammate while on 3 seats, you will be prompted to add a seat before the invite is sent. Downgrading removes the last-invited seat first.

## Invoices

**Settings → Billing → Invoices**. Download any invoice as PDF. Tax info can be set in **Settings → Billing → Tax**.

## Cancel

**Settings → Billing → Cancel plan**. You drop back to the free tier at the end of the current period. If you are over the free limits (more than 1 user or 3 accounts), you keep access in read-only until you prune.

## Trial

New orgs get a 14-day trial of the paid plan automatically. No card required. You will get a reminder 3 days before it ends.

## Hosted build time

Deploys from the web app (and deploy-on-push) build on Infrawrench-hosted
workers. When your deployment has build metering configured, that worker time is
billed per second through a Stripe meter alongside the seat price — each deploy
run records exactly how many seconds it used, and the run history shows it.

Plan-only previews build nothing and are never metered. Builds on your own
machine (`infrawrench deploy` locally) or on a `buildOn` host you provide are
yours already and never billed. Complimentary organizations are never billed.
