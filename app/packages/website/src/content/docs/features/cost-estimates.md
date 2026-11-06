---
title: Live cost estimates
description: See a running "$X/month" as you fill in a create form, the same figure on the resource afterwards, what an edit will do to the bill before you save it, and the run-rate your week's changes leave behind.
sidebar_order: 3
---

[Cloud costs](./cloud-costs.md) shows what your providers have already billed. Cost estimates show the other half: what a machine you're about to create, or about to resize, will cost per month before you commit.

The figure updates live. Change the size, region, disk or node count and it moves with you. It's worked out from the provider's own published rates for exactly the configuration on screen.

## Where you see it

**In the create form.** A green **Estimated cost** badge sits in the header of every create dialog whose provider can price that type. Click it to see what the total is made of.

![Create form for an EC2 instance with the Estimated cost badge expanded, showing the instance line, the root volume line, and the total](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-estimates/create-form-badge-expanded.png)

**On the resource afterwards.** The same badge appears in the header of the resource's detail page, so you can check the number you were quoted at create time. In the mobile app it's a card lower down the resource screen, with the line items already open.

**Before you save an edit.** Change a machine's size in the **Edit** dialog and a line appears above the buttons: _This change adds $340/month_. Expand it for the new breakdown. Nothing is charged until you save. This is only the preview.

![Edit dialog for a VM with the size changed, showing the "This change adds $340/month" line expanded to reveal the new cost breakdown](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-estimates/edit-dialog-delta-expanded.png)

**In the weekly digest.** The [weekly digest](./weekly-digest.md) has a **Projected spend** line: what last week's creates and deletes do to your monthly run-rate, separate from what was actually billed that week. A cluster spun up last Sunday barely shows in last week's spend but is most of next month's. This line tells you so.

**From the CLI.**

```
infrawrench estimate <resource-id>
infrawrench estimate <resource-id> --json
```

This prints the monthly total and its line items. Cloud only.

**Carbon next to it.** Wherever a price is quoted, an [estimated carbon](./carbon.md) figure sits beside it: a grey **Estimated carbon** badge next to the cost badge, a CO2e figure on each size card in the create form, and a carbon line under the cost change in the edit dialog. Both figures always describe the same configuration.

## What the numbers mean

Estimates are **list-price projections, not bills**:

- They use on-demand, pay-as-you-go rates. Reserved instances, savings plans, committed-use discounts, sustained-use discounts and negotiated pricing are **not** applied, so if your account gets discounts, the figure will be higher than what you actually pay.
- They assume the resource runs for a whole month (730 hours). Anything you stop, [put on a sleep schedule](./sleep-schedules.md) or delete mid-month costs less.
- They price the resource's standing components only. Metered usage (data transfer, requests, IOPS, snapshots) isn't included.

For what you were actually charged, use [Cloud costs](./cloud-costs.md). To browse and compare list prices before you choose a configuration, use the [Price catalog](./price-catalog.md).

## When you see no estimate

No badge is different from an estimate of $0. It happens in two cases:

- **The provider doesn't publish rates for this type.** Most resource types have no standing price (a VPC, a security group, a DNS record), and not every provider offers a pricing API for the ones that do.
- **A rate couldn't be found.** For example an unrecognised SKU, or a missing permission on the provider's pricing API. Infrawrench shows nothing rather than a number that might be wrong.

When only _part_ of a resource can be priced, the badge reads **at least $X/mo** and the breakdown lists only the parts with known rates. An EKS cluster, for example, prices its worker nodes and their volumes but not the control-plane charge, and a note under the breakdown tells you which part is missing.

## Provider support

| Provider                                   | Priced types                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [AWS](../plugins/aws.md)                   | EC2 instances, EBS volumes, RDS instances, ElastiCache clusters, OpenSearch domains, Redshift clusters, EKS node groups                      |
| [Azure](../plugins/azure.md)               | VMs, AKS clusters, managed disks, Container Instances, Redis caches, App Service and Function App plans, SQL databases, Container Registries |
| [Google Cloud](../plugins/gcp.md)          | Compute Engine instances and disks, GKE node pools                                                                                           |
| [DigitalOcean](../plugins/digitalocean.md) | Managed databases (per node)                                                                                                                 |

AWS, Google Cloud and Alibaba Cloud instance rates come from the same data as [instances.infrawrench.com](https://instances.infrawrench.com), which needs nothing from your account: no permission and no pricing API access. Those providers' own price APIs are the fallback if that data is unreachable. They also price what it doesn't cover, so for AWS volumes and storage the account's credentials still need the `pricing:GetProducts` permission (used by the [Price List Query API](../plugins/aws.md)). Without it, an estimate that includes them reads **at least $X/mo** and lists only the parts it could price. Azure rates need no permissions.

Every figure is region-specific. The same instance type costs a different amount in Tokyo than in Virginia, and changing the region picker updates it.
