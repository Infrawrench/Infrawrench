---
title: Orphan & idle resource finder
description: Flag likely-wasted resources, like unattached volumes and unassigned IPs, across your connected accounts, with the monthly cost where billing data exists.
sidebar_order: 14
---

The orphan finder looks through the resources in your connected accounts and flags the ones that are probably costing money for nothing: volumes attached to no server, reserved or elastic IPs assigned to nothing, static IPs sitting unused. Each flagged resource comes with a plain-English reason.

Each finding also appears in the [savings findings](./savings-findings.md) list at the top of the Savings tab, where it gets a status (Ready for review, In progress, Completed, Archived), a detected date, and a place in saved views.

It makes no extra provider API calls, so opening the page is instant and free.

## Find orphaned resources

Open **Costs** in the sidebar and go to the **Savings** tab. **Potential savings** is the first section. The Overview tab next to it shows what you're spending, so you can read the two together.

Flagged resources are grouped by account. Each row shows the resource, its type and why it was flagged. Where Infrawrench collects cost data for the account, rows also show the resource's spend over the last 30 days.

![Costs page Savings tab showing the Potential savings section, showing flagged resources grouped by account, each row with resource name, type badge, reason string, and a 30-day cost figure on the right](https://agent-assets.infrawrench.com/docs-screenshots/features/orphan-finder/potential-savings-section.png)

Click a resource name to open its detail page, where you can confirm it really is unused and delete it. You can also reach every flagged resource with the keyboard.

Prefer the terminal? **Remediate** on a row shows the provider CLI commands to clean it up, filled in with the resource's id and region, with a snapshot first where the provider supports one. See [Remediation commands](./remediation-commands.md). These work in local mode too.

The **mobile app** has the same section on the **Savings** tab of its Costs screen, grouped by account. Tap a row to open the resource. You need to be signed in, since there's no local mode on a phone.

<insert [Mobile app Costs tab, Savings tab selected, showing Potential savings with two account groups with flagged resources, name, type and reason, and a 30-day cost figure on the right] here>

## Cloud mode and local mode

The same checks run wherever your resources are stored. What differs is which resources are checked and whether cost data is available:

| Where you are                                                  | What is checked                                        | Cost column                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Web app, mobile app, or desktop signed in to an organization   | Your organization's synced resources                   | Last 30 days of spend where the provider reports per-resource cost |
| Desktop signed out (local mode), `infrawrench orphans --local` | The resources stored in this machine's local workspace | None (see below)                                                   |

Local mode needs no account credentials and makes no network calls, so it works offline.

It covers less, though. The local workspace only holds resources you created or pinned in the desktop app, not everything your providers hold. Sign in to an organization to check your complete, continuously synced inventory.

<insert [Desktop app in local mode, Costs panel Savings tab showing Potential savings, showing flagged resources with reasons and no cost column] here>

## What gets flagged

| Provider     | Flagged when                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| DigitalOcean | Volumes attached to no Droplet; Reserved IPs assigned to no Droplet (free while assigned, $5/month while idle)                           |
| Hetzner      | Volumes attached to no server; Floating IPs not assigned; Primary IPs unassigned that won't auto-delete                                  |
| AWS          | EBS volumes in `available` state (detached but still billed); Elastic IPs with no association                                            |
| Google Cloud | Persistent disks attached to no instance; static external IPs in `RESERVED` (unused) state (internal IPs are free)                       |
| Azure        | App Service Plans with no web app or function app assigned (Free and consumption tiers aren't flagged)                                   |
| Cursor       | Paid seats whose member has had no editor, agent or Bugbot activity in 30 days                                                           |
| GitHub       | Copilot seats with no activity for 30 days; codespaces unused for 14 days; offline self-hosted runners                                   |
| Crusoe Cloud | Disks attached to no VM; stopped VMs (compute stops billing, but their disks keep billing for storage)                                   |
| Linode       | Powered-off Linodes (billed in full until deleted); volumes attached to nothing; NodeBalancers with no backends; unassigned reserved IPs |
| Anyscale     | Workspaces that are running while Anyscale reports them idle (no Ray workload, command or editor activity)                               |
| Baseten      | Deployments that keep min replicas above 0 but billed no inference requests in the last 7 days                                           |

Some waste only shows up in a resource's metrics: a NAT gateway nothing routes through, a load balancer with no requests, a cache with no connections, a provisioned DynamoDB table using a sliver of its capacity, a custom metric nobody queries. [Idle resource findings](./idle-resources.md) check those metrics once a day and add what they find to the same list, with the metric evidence and a list-price estimate where there's no billing data.

> **Freshness.** The finder uses each resource's last synced state. If you detached a volume a minute ago, it appears after the next account sync. Open the account page or wait for the next automatic sync.

## Who owns each flagged resource

A list of waste with no names on it is a list nobody acts on. Every flagged resource shows its [owner](../core-concepts/resource-ownership.md), and resources with no owner say **Unowned** rather than leaving the cell blank:

| Resource        | Reason                               | Owner                  |
| --------------- | ------------------------------------ | ---------------------- |
| `backups-old`   | Volume is not attached to any server | Sam Reyes              |
| `staging-lb-ip` | Floating IP is not assigned          | Platform team _(team)_ |
| `vol-8823a1`    | Volume is not attached to any server | _Unowned_              |

Below the list you'll see a count like **"12 of 34 have no recorded owner: nobody to ask before deleting, and nobody an alert can reach."** Set an owner on a resource's **Ownership** tab to take it off that count.

A free-text owner ("Platform team") is marked as such, because only a real org member can be sent alerts.

**Local mode has no owner column**, since ownership is stored in the cloud. That doesn't mean nobody owns those resources.

## Cost

When an account has [cost collection](./cloud-costs.md) turned on and the provider reports per-resource costs, each flagged resource shows its spend over the last 30 days, which is roughly what deleting it saves. Resources without matching cost data show no figure. Flags don't depend on billing data.

**Local mode has no cost column**, since cost data is stored in Infrawrench Cloud. Instead of showing a misleading `$0.00`, the desktop section and CLI leave the column out and say so below.

## Use the CLI

The [desktop CLI](./cli.md) has the same finder:

```sh
infrawrench orphans                 # your cloud organization, with cost
infrawrench orphans --local         # this machine's workspace, no cost column
infrawrench orphans --json          # stable JSON for scripting
infrawrench orphans --org <org-id>  # pick an organization explicitly
```

`--json` includes `unownedCount` alongside `totalCount`, and an `owner` object on each flagged resource (`null` when nobody owns it), so you can script things like "open a ticket for every unowned orphan". Local scans include `"costBasis": "unavailable"` and `"costWindowDays": 0`, so a script can tell "nothing was spent" apart from "spend is unknown".

<insert [Terminal showing `infrawrench orphans` text output: account headings with flagged resource rows, reasons, and a cost column] here>

## Oversized machines

Waste isn't always a resource doing nothing. Sometimes it's a machine doing real work on twice the hardware it needs. The **Oversized** section right below Potential savings covers that: [right-sizing recommendations](./right-sizing.md) based on two weeks of p95 CPU and memory use, each with the cheapest smaller size that still leaves headroom and a one-click resize.

## File a flagged resource as an issue

Deleting something is a decision, and often not yours alone. With [Jira](./jira.md), [Linear](./linear.md) or [GitHub](./github-issues.md) connected, each flagged row has a link that opens an issue prefilled with the resource, its type, account and provider id, recent spend, and why it was flagged. Filed rows show their issue key instead. A GitHub issue closes itself (or gets a comment) once the resource is no longer flagged, and a resource managed by Terraform can get an **Open PR** link that deletes its block. See [GitHub issues and pull requests](./github-issues.md).
