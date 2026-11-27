---
title: Billing and plans
description: What's free and what's paid in Infrawrench, how seats and prepaid capacity work, and how to upgrade or cancel.
sidebar_order: 3
---

> The desktop app in local-only mode is free and needs no account. You manage billing on the web app or, when signed in to a cloud organization, from the desktop app's Settings tab (checkout opens in your browser).

## Plans

| Feature                            | Free                   | Paid                       |
| ---------------------------------- | ---------------------- | -------------------------- |
| Users                              | 1                      | Unlimited                  |
| Connected accounts                 | 3                      | Unlimited                  |
| Plugins                            | All 153                | All 153                    |
| Dashboards                         | Yes                    | Yes                        |
| SSH terminal / SQL                 | Yes                    | Yes                        |
| Audit log                          | No                     | Yes                        |
| Custom graphs                      | No                     | Yes                        |
| API keys                           | No                     | Yes                        |
| AI chat                            | $5 usage / mo included | Metered, pay-as-you-go     |
| [CI](#ci)                          | No                     | Metered, by usage          |
| [Git](#git) organization namespace | No                     | Yes                        |
| [Git](#git) public repositories    | Unlimited              | Unlimited                  |
| [Git](#git) private repositories   | 3, up to 1 GiB         | Unlimited, 10 GiB included |
| Price                              | $0                     | $20 / seat / mo            |
| Prepaid capacity                   | Not available          | $200 / seat / 2 years      |

On the free plan, inviting a teammate or connecting a fourth account is refused with a prompt to upgrade.

You can hold a paid seat two ways, and mix them: rent seats monthly at $20 each, or buy them outright as [prepaid capacity slots](#prepaid-capacity-slots) at $200 for two years. Either one puts your organization on the paid plan.

### AI usage

Free organizations (no payment method on file) can use [AI chat](../features/ai-chat.md) up to **$5 of usage per month**. After that, the assistant stops taking new requests until next month or until you upgrade. The same allowance covers `infra.ai()` in [workflows](../features/workflows.md) and [review agents](../features/git-branches.md#review-agents) on git.infrawrench.com: it's one AI budget for the whole org, not one per feature.

Paid organizations are billed for AI usage with no built-in limit. There's no self-serve cap, so ask us if you want one set.

## Upgrade

1. Go to **Settings > Billing**.
2. Click **Upgrade to Pro** ($20/seat/month). This opens Stripe Checkout.
3. Enter your card and set the number of seats. It starts at 1, and you change it in checkout, not on the Billing page.

You're on the paid plan as soon as the payment is confirmed.

The Billing page shows your current plan (with a status badge and, on a paid plan, your seats), the upgrade button, a **Manage subscription** button that opens the Stripe portal, and the **Prepaid capacity** card. On the free plan it also lists what Pro includes.

You also get the choice right after creating an organization, where Free and Pro are shown side by side. **Continue with Free** costs nothing and you can upgrade later from Settings. **Upgrade to Pro** takes you straight to checkout.

![Onboarding plan-choice step showing the Free and Pro cards side by side after creating an organization](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/billing-and-plans/onboarding-plan-choice.png)

![Billing page on the free plan: the current-plan card, the Upgrade to Pro button, the prepaid-capacity offer with its slot count selector, and the Pro plan includes card](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/billing-and-plans/billing-page.png)

## Seats

A seat is one user in your organization. A pending invitation also takes a seat.

**Adding seats.** If you invite a fourth teammate while you have 3 seats, you're asked to confirm adding a seat before the invite goes out. The new seat is billed pro-rata from that day. You need billing permission as well as invite permission to do this.

**Removing seats.** When a member is removed (or deletes their own account), their seat is freed and your monthly seat count drops by one. The next invoice bills the lower count. There's no mid-cycle credit, since that seat was already paid for the period. Extra seats you bought beyond your member count are kept, and the count never drops below one. You can always change it yourself in the Stripe portal from **Settings > Billing**.

**Seats and slots together.** Your capacity is your monthly seats plus your active prepaid slots. An organization with 2 monthly seats and 3 slots can hold 5 people. When someone leaves and your slots already cover everyone remaining, your monthly seat count goes down so you aren't paying twice for the same people.

## Prepaid capacity slots

A **capacity slot** is a seat you buy outright instead of renting: **$200 once, and that seat is yours for two years**. Nothing renews, there's nothing to cancel, and there's no monthly invoice for it.

To buy slots:

1. Go to **Settings > Billing > Prepaid capacity**.
2. Choose how many slots you want.
3. Pay once.

The seats appear as soon as the payment is confirmed, and you get an invoice like any other charge.

Good to know:

- **A slot is a paid plan on its own.** An organization with a slot gets every paid feature (audit log, custom graphs, API keys) with no monthly subscription.
- **Slots add to monthly seats.** Mixing is fine: buy slots for people who'll definitely be around for two years, and rent monthly seats for everyone else.
- **Each purchase has its own term.** Three slots bought today expire together in two years. One more bought next month gets its own end date. The Billing page lists every purchase with its expiry.
- **When a term ends, that capacity stops counting.** Nothing is deleted and nobody is removed, but you're over capacity, so invites are refused until you buy more or remove people. If slots were your only paid seats, the organization drops back to the free plan and keeps read-only access to anything over the free limits, just like a cancelled subscription.
- **If you're full on slots alone**, the invite prompt can't offer to add a $20/month seat, because there's no subscription to grow. It sends you to Billing to buy another slot or start a monthly subscription.
- **Refunds take the seats back.** A refunded purchase stops counting immediately and stays in your purchase history.

![Billing page Prepaid capacity card showing the slot quantity selector, the buy button, and a purchase history list with one active slot and its expiry date](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/billing-and-plans/prepaid-capacity-card.png)

**Self-hosting:** the Prepaid capacity card only appears when `STRIPE_CAPACITY_SLOT_PRICE_ID` is set. Without it, only the monthly plan is offered.

## Invoices and tax

Go to **Settings > Billing > Invoices** to download any invoice as a PDF. Set your tax details in **Settings > Billing > Tax**.

## Cancel

Go to **Settings > Billing > Cancel plan**. You move to the free plan at the end of the current billing period. If you're over the free limits (more than 1 user or 3 accounts), you keep read-only access until you trim down.

Cancelling the monthly subscription doesn't affect [prepaid capacity slots](#prepaid-capacity-slots). They're paid through their term, so you stay on the paid plan with that many seats until the last one expires.

## Trial

There's no time-limited trial. The free plan doesn't expire, so you can try Infrawrench for as long as you like and upgrade when you're ready. Starting checkout without finishing payment doesn't change your plan.

If your subscription includes a trial period (for example a promotional offer), the plan shows as a trial and works like the paid plan until the trial ends.

## CI

[CI](../features/ci.md) is part of paid plans and is billed by what your pipelines use, on the same invoice as your seats:

| Unit      | Price                                              | What counts                                                                                                                                            |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| vCPU time | $0.00008 per vCPU-second ($0.0048 per vCPU-minute) | Each job's running time, at a quarter of a vCPU (four jobs share one), or at the whole vCPUs of its [`cpus:`](../features/ci.md#whole-vcpus-for-a-job) |
| Memory    | $0.000008 per GiB-second                           | The memory each job reserves (its `memory:`, 2 GiB unless it says), for as long as it runs                                                             |
| Storage   | $0.0002 per GiB-hour (about $0.14 per GiB-month)   | The space your caches and [downloads](../features/ci.md#downloads) take on the runners, measured every hour                                            |

For example, a job with `memory: 4GiB` that runs for 10 minutes is charged 150 vCPU-seconds (a quarter of a vCPU for 600 seconds, $0.012) and 2,400 GiB-seconds ($0.0192), about $0.03 in all. With `cpus: 2` as well it is charged 1,200 vCPU-seconds ($0.096) instead of 150. A job the task cache stands in for does not run, so it costs nothing, and a [cloud job](../features/ci.md#cloud-jobs) is billed by your provider, not here.

The **CI** page shows this month's runs, compute and storage. Complimentary organizations are never billed for CI.

## Git

Repositories on [git.infrawrench.com](../features/git.md) follow your plan:

|                      | Free      | Paid                                                         |
| -------------------- | --------- | ------------------------------------------------------------ |
| Claim a namespace    | No        | Yes                                                          |
| Public repositories  | Unlimited | Unlimited                                                    |
| Private repositories | 3         | Unlimited                                                    |
| Private storage      | 1 GiB     | 10 GiB included, then metered by the GiB-hour, up to 100 GiB |

An organization needs a paid plan to [claim its namespace](../features/git.md#claim-a-namespace), in the app or on git.infrawrench.com. A namespace it already has stays when the plan ends, with the free limits. Public repositories are free on every plan, and their storage counts toward nothing. On the free plan the limits are fixed: a fourth private repository is refused, and so are pushes to private repositories once they hold 1 GiB. On a paid plan the first 10 GiB of private storage is included, and storage above that is measured every hour and billed on the same invoice as your seats. Pushes to private repositories are refused at 100 GiB. Write to us if you need more.

Going over a limit never deletes or hides anything, including after you cancel: your repositories stay readable and clonable, and you can't add to the private ones until you're back under. **Settings > Git** shows where you stand. Complimentary organizations are never billed for Git storage.

A personal namespace on git.infrawrench.com is separate from any organization's plan: it includes 5 private repositories and 1 GiB of private storage.

Someone who signs up on git.infrawrench.com without belonging to an organization can [set up a workspace](../features/git-getting-started.md#set-up-a-workspace) there: a new organization on the Pro plan with one seat, paid for on the same Stripe checkout as an upgrade in the app. It is billed and managed like any other organization from then on, on this page.

A personal [username](../features/git-getting-started.md#sign-in-and-choose-a-username) of 6 characters or fewer costs $50, paid once by card by the person who claims it. It is not part of any organization's plan and appears on no organization's invoice. Longer usernames are free, and so is every organization's name. If the name is taken before the payment goes through, the payment is refunded automatically.

**Self-hosting:** storage is only billed when `INFRAWRENCH_STRIPE_GIT_STORAGE_METER_EVENT` and `STRIPE_GIT_STORAGE_PRICE_ID` are set. The limits apply either way. Short usernames are charged at the one-time Stripe price whose lookup key is `git_short_username` (or the one `STRIPE_GIT_SHORT_USERNAME_PRICE_ID` names); without such a price, or without the forge and the app sharing `GIT_JOB_TOKEN_KEY`, short usernames cannot be claimed.
