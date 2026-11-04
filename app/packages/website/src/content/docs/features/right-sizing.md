---
title: Right-sizing (Oversized resources)
description: Find machines whose two-week p95 CPU (and memory, where measured) sits well under their size, get the smallest size that still leaves headroom, and apply the resize in one click.
sidebar_order: 14
---

The [orphan finder](./orphan-finder.md) shows what's wasted entirely. Right-sizing shows the quieter waste: real work running on a machine twice the size it needs. Infrawrench looks at the 95th-percentile CPU and memory use over the last 14 days. When a machine is well under its size, it checks the provider's own size list (the same sizes the create form offers, with live prices) and recommends the cheapest smaller size that still leaves comfortable headroom.

Each finding also appears in the [savings findings](./savings-findings.md) list at the top of the Savings tab, where it gets a status (Ready for review, In progress, Completed, Archived), a detected date, and a place in saved views.

The numbers come from the metrics Infrawrench already records for resources pinned to a dashboard, and the sizes and prices come from each provider's live catalog.

## Find oversized machines

Open **Costs** in the sidebar, go to the **Savings** tab, and find **Oversized**. Each row shows the machine, its current and recommended size, the p95 CPU and memory figures behind the recommendation, and the estimated monthly saving, with the [estimated CO2e](./carbon.md) the resize would save each month below it.

![Costs page Savings tab showing the Oversized section, showing a flagged server row with current and recommended size, p95 CPU/memory figures, a monthly saving on the right, and the Apply resize button](https://agent-assets.infrawrench.com/docs-screenshots/features/right-sizing/oversized-section.png)

**Remediate** on a row shows the same resize as provider CLI commands (stop, resize, start, in whatever order the provider needs), ready to copy. If Terraform manages the machine, you get a Terraform hint instead. See [Remediation commands](./remediation-commands.md).

You can also see the list:

- in the mobile app's Costs tab, under **Savings** (read-only, apply from web or desktop)
- with `infrawrench oversized` in the CLI (`--json` for scripts)
- through the `list_oversized_resources` [MCP tool](./mcp.md)

## When a machine is flagged

A machine is flagged when, over the last 14 days:

- its p95 CPU use is under 20%, **and**
- where the provider reports memory, its p95 memory use is under 40%, **and**
- there are at least three days of metrics behind the numbers.

The recommended size is the cheapest one where your p95 still fits under about 70% of capacity, so you keep headroom. You'll never be offered a size the provider would reject: a different CPU architecture or family, a size not available in that region, or one with a smaller included disk than the machine already has.

Not every provider measures memory. Where it isn't available (Hetzner, EC2, Compute Engine without an agent), the row says **memory not measured**, the recommendation is based on CPU, and it will never suggest cutting RAM below half the current size. The confirm dialog repeats this so you can check the workload's memory yourself before applying.

## Supported providers

- **Hetzner Cloud:** Servers (per-location EUR prices; CPU only, as Hetzner doesn't report memory)
- **DigitalOcean:** Droplets (USD prices; memory measured where the DO Metrics Agent runs on the Droplet)
- **AWS:** EC2 instances (live per-region on-demand prices; needs the `pricing:GetProducts` permission)
- **Azure:** Virtual machines (memory from the Available Memory Bytes metric)
- **Google Cloud:** Compute Engine VM instances (Cloud Billing catalog prices)
- **Linode (Akamai Cloud):** Linodes (regional USD prices; CPU only, as Linode doesn't report memory; LKE worker nodes are resized through their node pool instead)

## Apply a resize

Click **Apply resize**. The confirm dialog shows exactly what will change: both sizes with their vCPU and RAM, the expected use on the new size, the saving, and the provider's own requirement, because there almost always is one:

- Hetzner, EC2 and Compute Engine only resize a **stopped** machine. Stop it first (or let a [sleep schedule](./sleep-schedules.md) window do it), apply, then start it again.
- DigitalOcean powers the Droplet off for the resize and boots it afterwards.
- Linode powers the instance off, moves it to the new plan and boots it again. A smaller plan only works if your data fits on its disk.
- Azure resizes a running VM but **restarts** it during the change.

<insert [Apply resize confirm dialog quoting the change: current and recommended size with vCPU/RAM, p95 figures, monthly saving, and the provider note that the server must be powered off first] here>

A resize follows the same rules as any edit: an active [change freeze](../team-and-billing/change-freeze.md) blocks it with the freeze's message, and every resize is recorded in the [audit log](../team-and-billing/audit-log.md). Disks are never touched. Where the provider offers a choice, Infrawrench always requests the CPU and RAM only resize, which you can reverse.

## Why a machine isn't listed

- **No metrics yet.** Only machines pinned to a dashboard have metrics recorded. Pin the machine and give it a few days.
- **Less than about 3 days of data.** You get no recommendation rather than a shaky one.
- **It's stopped.** For a machine that stays stopped, use a [sleep schedule](./sleep-schedules.md) or delete it.
- **No cheaper size fits.** There's no smaller size in the same family and region that keeps enough headroom. Good news.
- **It's already the smallest size in its family.**

## File a recommendation as an issue

A resize is often someone else's change to make, or one that needs scheduling. With [Jira](./jira.md), [Linear](./linear.md) or [GitHub](./github-issues.md) connected, each row in the Oversized section has a link that opens an issue prefilled with the resource, its current and recommended size, the p95 CPU and memory, and the estimated monthly saving. Once filed, the row shows the issue key. When Terraform manages the machine, **Open PR** proposes the size change in your repository instead. See [GitHub issues and pull requests](./github-issues.md#terraform-pull-requests).
