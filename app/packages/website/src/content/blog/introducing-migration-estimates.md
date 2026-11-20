---
title: "Estimate what your service would cost on another cloud"
description: Compare current cloud spend with an estimate for equivalent resources on another provider in the Infrawrench Costs app.
date: 2026-11-20
author: The Infrawrench team
---

A cheaper VM doesn't tell you what a service would cost to move. You still have to price the database, storage and load balancer, then work out which sizes are comparable.

Migration estimates in the Infrawrench Costs app put those figures side by side. Open a service and choose **Estimate migration**, or select the resources you want to compare in a resource report. Pick a target provider and region to see the estimate.

![The migration estimate screen comparing an example AWS service with Hetzner Cloud using sample data](/blog/migration-estimates/estimate.png)

## See what goes into the comparison

Infrawrench looks for equivalent resources and picks sizes that meet the source's CPU, memory and GPU requirements where those apply. You can change the match for an individual resource if you already know what you want to run.

The current side uses the last 30 days of billed spend when available, and falls back to a provider estimate or list price. If a price is missing, it stays unknown. Resources with no equivalent are listed separately, and the reported difference only includes rows with a price on both sides.

That difference is an estimate of recurring resource costs for the priced rows. Budget separately for the work of moving and any period when both environments are running.

To try it, open **Costs → Migration estimates** in a connected Infrawrench workspace or start from the service you're considering moving.
