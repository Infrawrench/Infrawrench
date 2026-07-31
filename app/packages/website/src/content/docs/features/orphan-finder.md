---
title: Orphan & idle resource finder
description: Flag likely-wasted resources — unattached volumes, unassigned IPs — across your connected accounts, with the monthly cost where billing data exists.
sidebar_order: 14
---

The orphan finder scans the resources Infrawrench has already synced from your connected accounts and flags the ones that are probably costing money for nothing: volumes attached to no server, reserved or elastic IPs assigned to nothing, static IPs sitting unused. Each flagged resource comes with a plain-English reason from the provider plugin that knows what the fields mean.

No extra provider API calls are made — the finder runs entirely over data your accounts already list, so opening the page is instant and free.

## Where to find it

Open **Costs** in the sidebar and scroll to **Potential savings**, below the month-to-date chart and your budgets — what you're spending and what of it is wasted read together on one page.

Flagged resources are grouped by account, each row showing the resource, its type, and the reason it was flagged. Where Infrawrench collects cost data for the account, rows are annotated with the resource's spend over the last 30 days.

<insert [Costs page scrolled to the Potential savings section, showing flagged resources grouped by account — each row with resource name, type badge, reason string, and a 30-day cost figure on the right] here>

Click any row to jump to the resource's detail page, where you can confirm it really is unused and delete it in place.

The section is available in the web app and in the desktop app when signed in to an organization — the heuristics run server-side over your organization's synced resources, so local-only desktop mode has nothing to scan.

## What gets flagged

A resource is flagged when the provider plugin's heuristic matches the resource's current synced state. The first release ships heuristics for:

| Provider     | Flagged when                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| DigitalOcean | Volumes attached to no Droplet                                                                                     |
| Hetzner      | Volumes attached to no server; Floating IPs not assigned; Primary IPs unassigned that won't auto-delete            |
| AWS          | EBS volumes in `available` state (detached but still billed); Elastic IPs with no association                      |
| Google Cloud | Persistent disks attached to no instance; static external IPs in `RESERVED` (unused) state — internal IPs are free |

Heuristics are declared by each plugin, so coverage grows as plugins do — a provider that knows another "this is idle" signal can add it without any host changes.

> **Freshness.** The finder reads the last synced state of each resource. If you detached a volume a minute ago, it appears after the next account sync — open the account page or wait for the background poller.

## Cost annotations

When an account has [cost collection](./cloud-costs.md) enabled and the provider reports per-resource cost rows, each flagged resource shows its spend over the trailing 30 days — a concrete number for what deleting it saves. Resources without matching cost rows simply show no figure; the flag itself does not depend on billing data.

## From the CLI

The [desktop CLI](./cli.md) exposes the same finder for your cloud organizations:

```sh
infrawrench orphans                 # text table, grouped by account
infrawrench orphans --json          # stable JSON for scripting
infrawrench orphans --org <org-id>  # pick an organization explicitly
```

<insert [Terminal showing `infrawrench orphans` text output: account headings with flagged resource rows, reasons, and a cost column] here>
