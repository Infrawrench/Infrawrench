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
| Plugins            | All 48                 | All 48                 |
| Dashboards         | Yes                    | Yes                    |
| SSH terminal / SQL | Yes                    | Yes                    |
| Audit log          | No                     | Yes                    |
| Custom graphs      | No                     | Yes                    |
| Deploy from GitHub | No (CLI deploys free)  | Yes                    |
| API keys           | No                     | Yes                    |
| AI chat            | $5 usage / mo included | Metered, pay-as-you-go |
| Price              | $0                     | $20 / seat / mo        |

The user and account limits are enforced: on the free plan, inviting a teammate or connecting a fourth account is refused with a prompt to upgrade.

Free orgs (no payment method on file) can use the [AI chat](../features/ai-chat.md) up to **$5 of metered usage per month**; after that the agent refuses new turns until the next month or until you upgrade. Paid orgs are billed for chat usage through Stripe with no built-in limit (set your own cap in **Settings → Billing → Chat cap**).

## Upgrade

**Settings → Billing → Upgrade**. We use Stripe. Add a card, pick a seat count, and you are on the paid plan immediately.

You are also offered the choice right after creating an organization — the onboarding flow shows the Free and Pro plans side by side. Picking **Continue with Free** costs nothing and you can upgrade later from Settings; picking **Upgrade to Pro** takes you straight to checkout.

<insert [Onboarding plan-choice step showing the Free and Pro cards side by side after creating an organization] here>

<insert [Billing page with plan cards and a seat count selector] here>

## Seats

A seat is one user in your organization, and a pending invitation reserves one. If you invite a fourth teammate while on 3 seats, you will be prompted to confirm adding a seat before the invite is sent; the new seat is billed pro-rata from that day. Adding a seat this way needs billing permission as well as invite permission.

Removing a member (or a member deleting their own account) frees their seat automatically: your seat count drops by one, and the next invoice bills the lower count — no mid-cycle credit, since the seat was already paid through the period. Seats you bought beyond your current member count are kept, and the count never drops below one; you can always adjust it manually from the Stripe portal under **Settings → Billing**.

## Invoices

**Settings → Billing → Invoices**. Download any invoice as PDF. Tax info can be set in **Settings → Billing → Tax**.

## Cancel

**Settings → Billing → Cancel plan**. You drop back to the free tier at the end of the current period. If you are over the free limits (more than 1 user or 3 accounts), you keep access in read-only until you prune.

## Trial

There is no separate time-limited trial: the free plan does not expire, so you can evaluate for as long as you like and upgrade when you are ready. Starting checkout without completing payment does not change your plan — you stay on the free tier until Stripe confirms the subscription. If a trial period is applied to your Stripe subscription itself (for example a promotional offer), the plan shows as a trial and works like the paid plan until the trial ends.

## Hosted build time

Deploys from the web app (and deploy-on-push) build on Infrawrench-hosted
workers. When your deployment has build metering configured, that worker time is
billed per second through a Stripe meter alongside the seat price — each deploy
run records exactly how many seconds it used, and the run history shows it.

Plan-only previews build nothing and are never metered. Builds on your own
machine (`infrawrench deploy` locally) or on a `buildOn` host you provide are
yours already and never billed. Complimentary organizations are never billed.
