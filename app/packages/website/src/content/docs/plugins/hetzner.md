---
title: Hetzner Cloud
description: Manage Hetzner servers, volumes, networks, load balancers, images, and IP resources, with estimated spend priced from the published rate card.
sidebar_order: 5
---

## What you can manage

- Servers (create with image + size + datacenter + SSH key)
- Volumes
- Floating IPs
- Firewalls
- Networks
- Load balancers
- Primary IPs
- SSH keys
- Images, including snapshots and backups returned by the Hetzner API
- Placement groups

## Credentials

Hetzner Cloud Console → select a project → **Security → API tokens → Generate API token**. Read + write.

![Hetzner Add-account form with API token field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/hetzner/add-account.png)

Each API token is project-scoped. Add one infrawrench account per Hetzner project.

## Notable flows

- **SSH terminal** on servers.
- Idempotent SSH key upload: when you pick a key from infrawrench during server creation, it is uploaded to Hetzner if not already present.
- **Load balancer and network inventory** so service topology is visible without leaving the app.
- **Secret export to K8s** is not supported for Hetzner resources directly (they do not hold secrets).

## Cost

Hetzner Cloud has no billing API. There is no invoice endpoint and no spend endpoint — the only money the Cloud API exposes is the public rate card at `GET /pricing`. Invoices belong to a different Hetzner product line behind a different login, which your project API token cannot reach.

So infrawrench estimates instead: it lists everything in the project and prices it against Hetzner's own rate card. Cost figures for Hetzner accounts are labelled **estimated** throughout the app. Read them as "what this inventory lists for", not as "what Hetzner charged".

Nothing extra to set up — the same project API token you already added is all it needs.

<insert [Costs panel for a Hetzner account, with the estimated-costs notice visible above the chart and the service breakdown showing Server, Volume and Traffic] here>

### What gets priced

| Service       | Basis                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| Server        | Hourly rate, capped at the monthly price — Hetzner never bills a server past its monthly cap |
| Server Backup | The rate card's backup percentage (currently 20%) of that server's own cost                  |
| Load Balancer | Hourly rate, capped at the monthly price                                                     |
| Primary IP    | Hourly rate, capped at the monthly price. IPv6 primary IPs are free and produce no rows      |
| Floating IP   | Monthly price, spread across the month                                                       |
| Volume        | Size × price per GB-month, spread across the month                                           |
| Snapshot      | Compressed size × price per GB-month, spread across the month                                |
| Traffic       | Outgoing traffic beyond the server or load balancer's included allowance, at the per-TB rate |

Networks, firewalls, placement groups and SSH keys are free and are not priced.

A powered-off server is still billed in full, and infrawrench reports it that way. Hetzner allocates a server's resources regardless of its power state and charges for as long as it exists, so stopping a server does not reduce this figure — only deleting it does.

### Why it will not match your invoice

These are the specific, one-directional ways the estimate is wrong. All of them follow from having only an inventory to work from.

- **Deleted resources are invisible.** The estimate is built from what exists when it runs. A server that ran for three weeks and was destroyed on the 22nd is not in any listing afterwards, so the three weeks it cost are simply missing. This is why the estimate reads low, and it is the largest source of difference for an account with churn.
- **The series starts when you connect the account, and is not backfilled.** Reconstructing last March from today's inventory would produce a confident number that is wrong in the way above, so infrawrench does not do it. Months before you added the account show a gap, not zero spend.
- **Traffic has no history.** Hetzner's traffic counters cover the current billing period only and reset with it. The overage figure is the running total for the month in progress, recorded against the start of that month. If infrawrench is not collecting on the last day of a month, that month keeps the last figure it saw.
- **VAT is excluded.** Every amount is net. The rate card also publishes gross prices, but applying your own tax treatment to a net figure is the only thing that works for accounts outside Germany.
- **List prices only.** Anything negotiated, any credit, refund, or one-off charge, has no resource to hang off and can never appear.

Amounts are reported in the currency the project's rate card is denominated in — commonly EUR, but read from the API rather than assumed.

## Tips & limits

- Hetzner is cheap and fast, but its API has global rate limits (3600 requests per hour per project). A single large account refresh may briefly throttle.
- Cost collection is a handful of listing requests per day against that same budget, and it skips the requests entirely when there is nothing new to price.
