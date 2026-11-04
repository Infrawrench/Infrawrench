---
title: IaC reconciliation
description: Upload the Terraform state you already have and Infrawrench sorts every synced resource into managed, drifted or unmanaged, then writes the import blocks to adopt the unmanaged ones.
---

Terraform tells you what it manages. It can't tell you what it _doesn't_: the security group someone widened at 2 a.m., the RDS instance created "just for a test" eighteen months ago, the load balancer nobody remembers asking for. Those are the resources that break a `terraform apply`, survive an environment teardown and stay on the bill forever.

**IaC reconciliation** finds them. Upload the Terraform state you already have, and every resource Infrawrench has synced goes into one of three groups:

| Status        | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| **Managed**   | Matched an entry in your state, and the live fields agree with it           |
| **Drifted**   | Matched an entry in your state, but the live fields have moved away from it |
| **Unmanaged** | In your inventory but not in your state: someone made it by hand            |

There's a fourth list too: resources that are **in state but not in inventory**. Terraform thinks they exist, but Infrawrench has never seen them.

![The Infrastructure as Code page with the four summary tiles across the top and the resource table below, showing a mix of managed, drifted and unmanaged rows](https://agent-assets.infrawrench.com/docs-screenshots/features/iac-reconciliation/iac-overview.png)

## Four things called "Terraform"

Four Infrawrench features mention Terraform. Here's which is which:

| Feature                                       | Direction                | Unit                          |
| --------------------------------------------- | ------------------------ | ----------------------------- |
| **IaC reconciliation** (this page)            | Terraform state, in      | Your cloud resources          |
| [Eject to Terraform](./terraform-export.md)   | HCL, out                 | Your cloud resources          |
| [Config as code](./config-as-code.md)         | JSON, both ways          | Your Infrawrench organization |
| [Terraform provider](./terraform-provider.md) | Terraform to Infrawrench | Your Infrawrench organization |

This is the only one that reads your state. Eject to Terraform writes HCL describing your cloud resources. Config as code moves your whole Infrawrench organization as one JSON document. The Terraform provider lets Terraform manage Infrawrench's own settings.

## Upload your state

Open **IaC** in the sidebar and choose **Upload state**. You can upload either:

- **`terraform show -json` output** (recommended). Run it in your workspace and upload the result. It's the format HashiCorp documents as stable.
- **A raw `.tfstate` file**, state format version 4 (Terraform 0.12 and later).

```bash
terraform show -json > state.json
```

Give the upload a **label** ("prod / us-east-1") and, optionally, a **scope**: one account, or the whole organization. Scope it to an account when each Terraform workspace covers one account, so only that account's resources are compared against it.

Unsupported versions are refused with an explanation instead of being half-read. That includes a version 3 state file, or a `terraform show` document in a format version Infrawrench can't read. A half-read state would wrongly flag managed resources as made by hand.

Upload again after each apply. Infrawrench keeps the twenty most recent uploads per organization and removes superseded ones after 90 days. The newest upload for each scope is always kept, so a workspace nobody has applied in months still has its answer.

## What happens to secrets in your state

Terraform state is full of secrets. For every upload:

1. **The file itself is never stored.** It's read once, on upload, and thrown away. Only the details needed for comparison are kept.
2. **Attributes your state marks as sensitive are dropped before anything is saved.** Both formats mark them (`sensitive_attributes` in a `.tfstate`, `sensitive_values` in `terraform show -json`), and both are respected. If anything nested inside an attribute is sensitive, the _whole_ attribute is removed.
3. **Removed attributes are never compared**, so a secret's value can't leak through a drift result. The page shows how many attributes were removed, so you can see it happened.

Limits on uploads:

- Up to 8 MiB per file and 250 attributes per resource.
- Files nested more than 64 levels deep inside a single attribute are rejected. Real Terraform state never gets close.
- Attribute values over 4 000 characters are cut off, and larger structures are dropped. These, like sensitive values, are left out of drift comparison.

## How resources are matched

Each Terraform address, like `aws_instance.web`, is matched to a resource Infrawrench synced. It uses the same mapping as [Eject to Terraform](./terraform-export.md), so any resource type that supports eject also supports reconciliation.

Infrawrench tries these in order:

1. the resource's **import ID**
2. the resource's **external ID** (the provider's own ID)
3. the `id`, `arn` or `self_link` in the state entry, but **only** when it points to exactly one state entry. Infrawrench would rather call a managed resource unmanaged than guess.

Every row shows how it was matched, so you can check it.

If a resource type can't be mapped to a Terraform type, the page lists it under **Coverage gaps** instead of guessing. This only affects the "in state only" list; resources Infrawrench actually has still match.

## Review drift

A drifted resource shows each field where your state and the live resource disagree, in the same before and after layout as the [change timeline](./change-timeline.md). The left value is what Terraform state says; the right is what's actually running.

Only the fields that eject to Terraform knows about are compared. The rest of a state entry is provider bookkeeping, and comparing it would just add noise.

If a resource matched but can't be expressed as a Terraform block, it shows as managed with a note: its drift is **unknown**, not absent. Infrawrench won't call a resource clean when it can't check.

## Adopt unmanaged resources

This is what the feature is for. Select unmanaged resources (or **Select all**) and choose **Generate import blocks**. You get one file with Terraform 1.5+ `import` blocks followed by the matching `resource` blocks:

```hcl
import {
  to = aws_instance.web
  id = "i-0abc123def456"
}

resource "aws_instance" "web" {
  ami           = "ami-0abc123"
  instance_type = "t3.medium"
  subnet_id     = "subnet-0123456"
  tags = {
    Name = "web"
  }
}
```

Add it to your configuration and run `terraform plan`. The `import` blocks adopt the live resources on the next apply, with no `terraform import` commands to run by hand, and the whole set comes under management in one reviewed change.

The HCL matches what [Eject to Terraform](./terraform-export.md) produces, plus the import blocks. Secrets are referenced as `var.*` input variables and never written inline.

**Every resource in the file is imported, never created.** A `resource` block without an `import` block would try to create a second copy, or fail because it already exists. So if a provider gives no import ID for a resource, or the resource can't be expressed in Terraform, it's left out of the file and listed with the reason instead. Nothing is dropped silently, and everything in the file is safe to plan.

![The Adopt into Terraform modal showing generated import blocks above the resource stanzas, with the Close, Copy HCL and "Download imports.tf" buttons in the footer](https://agent-assets.infrawrench.com/docs-screenshots/features/iac-reconciliation/adopt-into-terraform-modal.png)

## See who made it, and when

Unmanaged resources get two extra columns:

- **Owner**: from [resource ownership](../core-concepts/resource-ownership.md), if anyone recorded one.
- **First seen**: when the [change timeline](./change-timeline.md) first saw the resource appear.

Together they turn "you have 34 unmanaged resources" into a list you can act on: a name to ask, and a date to ask about.

## Permissions

| Permission  | Grants                                                     |
| ----------- | ---------------------------------------------------------- |
| `iac:read`  | View the classification, drift, and generate import blocks |
| `iac:write` | Upload and delete state documents                          |

Members get `iac:read` by default, because "is this managed?" is something you need to know before you touch anything. Uploading state stays with admins and owners.

## Where it's available

Cloud organizations only, on the web and desktop apps. It works on your organization's synced resources, which local-only desktop mode doesn't have, so the desktop panel tells you that instead.

## Related

- [Eject to Terraform](./terraform-export.md): generate HCL for resources you already have
- [Change timeline](./change-timeline.md): where the drift details come from
- [Resource ownership](../core-concepts/resource-ownership.md): who owns what
- [Config as code](./config-as-code.md): your Infrawrench organization as one JSON document
- [Terraform provider](./terraform-provider.md): manage Infrawrench with Terraform
