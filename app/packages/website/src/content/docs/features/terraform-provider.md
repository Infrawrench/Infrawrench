---
title: Terraform provider
description: Manage Infrawrench's own configuration — budgets, cost centres, allocation rules, tag policy, saved filters, reports, alerts, scenario models, billing rules and exports — as Terraform resources.
sidebar_order: 7
---

The Infrawrench Terraform provider manages **Infrawrench's own configuration** as Terraform resources: budgets, cost centres, allocation rules, tag policy, saved filters, cost reports and folders, cost alerts, scenario models, billing rules and cost exports. Each object is a resource with its own plan, its own drift detection, and its own `terraform import`.

It is for teams who already keep infrastructure in Terraform and want their FinOps configuration to arrive the same way — through a pull request, reviewed, with a plan that says exactly what will change.

<insert [A terraform plan output in a terminal showing an infrawrench_budget being updated in place, with the amount_cents and threshold changes highlighted] here>

## Which Terraform feature is this?

Three features have Terraform in the name. They point in different directions, and picking the wrong one costs you an afternoon.

| Feature                                   | What it manages                                            | Use it when                                                         |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| [Terraform export](./terraform-export.md) | **Your cloud resources**, written out as HCL               | You want to adopt existing resources into Terraform, or leave       |
| [Config as code](./config-as-code.md)     | **A whole organization's configuration**, as one document  | Cloning an org, seeding staging, disaster recovery                  |
| **Terraform provider** (this page)        | **Individual Infrawrench objects**, as Terraform resources | Budgets and cost policy belong in your Terraform repo, under review |

The short version: Terraform export is about getting your resources _out_. Config as code moves a whole org _at once_. The provider manages _one object at a time_, continuously.

They compose. Config as code is still the right tool for "make staging look like production in one shot". The provider is the right tool for "the platform team's budget lives in git and changes go through review".

## Why not just wrap config as code?

A fair question, and it was the first design considered. [Config as code](./config-as-code.md) already exports, plans and applies configuration, so wrapping it would have meant one implementation of diffing and validation instead of two.

It does not fit, for reasons that are worth knowing because they also tell you when to use each feature:

- **The document doesn't carry most of these objects.** It has sections for budgets, cost centres and tag policy — but not for saved filters, cost reports, report folders, cost alerts, scenario models, billing rules or cost exports.
- **The document addresses things by name, not by id.** That's exactly what makes one document apply cleanly to a fresh organization. It's also what makes `terraform import` impossible, and what would turn renaming a budget into destroying and recreating it.
- **Apply is all-or-nothing.** It takes the whole document in one transaction. Terraform walks its graph in parallel, so ten resources applying at once would mean ten overlapping rewrites of one document.
- **Deleting one object would mean owning all of them.** The document's `replace` mode deletes anything it doesn't name, so removing one budget from Terraform would have destroyed every budget created outside it.

So the provider talks to the API routes directly, one object at a time. That is what buys you per-resource plans, real imports, and deletions that affect exactly one thing.

## Install

```hcl
terraform {
  required_providers {
    infrawrench = {
      source  = "Infrawrench/infrawrench"
      version = "~> 0.1"
    }
  }
}
```

## Authenticate

```hcl
provider "infrawrench" {
  organization_id = "org_01HXYZABCDEF"
  # api_key comes from INFRAWRENCH_API_KEY
}
```

Every argument falls back to an environment variable, which is how you should run it in CI so the credential never lands in a `.tf` file or a saved plan:

| Argument          | Environment variable   | Default                       |
| ----------------- | ---------------------- | ----------------------------- |
| `base_url`        | `INFRAWRENCH_BASE_URL` | `https://app.infrawrench.com` |
| `api_key`         | `INFRAWRENCH_API_KEY`  | required                      |
| `organization_id` | `INFRAWRENCH_ORG_ID`   | required                      |

The organization id is the one in your URL when you're signed in — it starts with `org_`.

Create the credential on **Settings → API keys**. The permissions each object needs are the same ones the UI enforces, so a key that can't edit budgets in the app can't edit them through Terraform either:

| Objects                                                                                  | Read             | Write                |
| ---------------------------------------------------------------------------------------- | ---------------- | -------------------- |
| Budgets                                                                                  | `budgets:read`   | `budgets:write`      |
| Cost centres, allocation rules, saved filters, reports, folders, alerts, scenario models | `costs:read`     | `costs:write`        |
| Tag policy                                                                               | `resources:read` | `org:settings:write` |
| Billing rules, cost exports                                                              | `costs:read`     | `org:settings:write` |

Billing rules and cost exports are the odd ones: reading them needs only `costs:read`, but changing them needs org settings. A key scoped to `costs:write` will read them and fail to write them.

<insert [The API keys page under Settings with the scope checkboxes visible, showing a key being created with costs:read and costs:write selected] here>

## A worked example

One file: a saved filter, the cost centre it feeds, the rule that allocates to it, a budget, and an alert.

```hcl
resource "infrawrench_saved_filter" "platform" {
  name        = "Platform team"
  description = "Everything tagged team=platform, across every provider."

  filter {
    dimension = "tag"
    tag_key   = "team"
    op        = "in"
    values    = ["platform"]
  }
}

resource "infrawrench_cost_centre" "platform" {
  name        = "Platform"
  description = "Shared infrastructure owned by the platform team."
}

resource "infrawrench_allocation_rule" "platform_tag" {
  cost_centre_id = infrawrench_cost_centre.platform.id
  priority       = 100

  match {
    tag_key   = "team"
    tag_value = "platform"
  }
}

resource "infrawrench_budget" "platform" {
  name            = "Platform monthly"
  amount_cents    = 4500000
  currency        = "USD"
  saved_filter_id = infrawrench_saved_filter.platform.id
  cost_basis      = "amortized"

  threshold {
    type    = "actual"
    percent = 80
  }

  threshold {
    type    = "forecast"
    percent = 100
  }
}

resource "infrawrench_cost_alert" "platform_spike" {
  name              = "Platform week-on-week spike"
  cadence           = "weekly"
  direction         = "increase"
  threshold_percent = 25

  filter {
    dimension = "tag"
    tag_key   = "team"
    op        = "in"
    values    = ["platform"]
  }
}
```

Referencing account ids by hand is a mistake waiting to happen, so read them instead:

```hcl
data "infrawrench_accounts" "aws" {
  plugin_id = "aws"
}

resource "infrawrench_allocation_rule" "first_aws_account" {
  cost_centre_id = infrawrench_cost_centre.platform.id
  priority       = 200

  match {
    account_id = data.infrawrench_accounts.aws.accounts[0].id
  }
}
```

## Adopting what you already have

Nobody starts from an empty organization, so every object with an id imports:

```sh
terraform import infrawrench_budget.platform      b1f2c3d4-...
terraform import infrawrench_cost_centre.platform 9a8b7c6d-...
terraform import infrawrench_saved_filter.platform 2c3d4e5f-...
```

The id is in the URL when you open the object in the app, and in the `--json` output of the [CLI](./cli.md).

[Tag policy](./tag-policy-and-showback.md) is an organization singleton — there is only ever one, and it has no id of its own — so it imports under the organization id:

```sh
terraform import infrawrench_tag_policy.this org_01HXYZABCDEF
```

**Cost export credentials can't be imported.** The access key, secret and webhook URL are write-only: no API route returns them, deliberately. After importing an [export](./cost-exports.md) you must put the credentials back in your configuration, and the provider cannot tell you whether they've since been changed elsewhere — `has_credentials` and `credential_hint` are the only readable signals that a credential exists at all.

## What's managed

| Resource                         | Manages                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| `infrawrench_budget`             | [Budgets](./cloud-costs.md#budgets) and their alert thresholds      |
| `infrawrench_cost_centre`        | [Cost centres](./tag-policy-and-showback.md)                        |
| `infrawrench_allocation_rule`    | The rules that map spend onto cost centres                          |
| `infrawrench_tag_policy`         | [Required tags](./tag-policy-and-showback.md) and their enforcement |
| `infrawrench_saved_filter`       | [Saved cost filters](./cloud-costs.md)                              |
| `infrawrench_cost_report`        | [Cost reports](./cost-reports.md)                                   |
| `infrawrench_cost_report_folder` | Report folders                                                      |
| `infrawrench_cost_alert`         | [Cost change alerts](./cost-change-alerts.md)                       |
| `infrawrench_scenario_model`     | [Scenario models](./scenario-models.md)                             |
| `infrawrench_billing_rule`       | [Billing rules](./billing-rules.md)                                 |
| `infrawrench_cost_export`        | [Scheduled cost exports](./cost-exports.md)                         |

| Data source                | Reads                                                 |
| -------------------------- | ----------------------------------------------------- |
| `infrawrench_accounts`     | Connected accounts — for resolving account ids        |
| `infrawrench_plugins`      | Available plugins — for resolving plugin ids          |
| `infrawrench_cost_centres` | Cost centres, including ones not managed by Terraform |

## Things worth knowing

**Objects deleted outside Terraform come back.** Every resource does a real read on refresh. If someone deletes a budget in the app, the next plan shows it as needing to be created again rather than failing.

**Live figures aren't in state.** A budget's month-to-date spend, an alert's last-fired time, an export's last run — none of it appears as a Terraform attribute. It changes constantly, and putting it in state would make every plan noisy for no benefit. Read those from the app, the [CLI](./cli.md), or the [API](../team-and-billing/openapi.md).

**Deletes can be refused.** Saved filters and scenario models that something still points at return a conflict rather than being deleted, and the error names what's still referencing them. Repoint those first.

**Credentials are marked sensitive.** Export access keys, secrets and webhook URLs never appear in plan output or state diffs in plaintext.

**Billing rule amounts are in the major currency unit.** Everything else in Infrawrench counts cents; a fixed billing rule's `amount` is dollars. It's the one inconsistency, and it is inherited from the API.

## Related

- [Config as code](./config-as-code.md) — move a whole organization's configuration as one document
- [Terraform export](./terraform-export.md) — write your cloud resources out as HCL
- [The CLI](./cli.md) — the same objects from a terminal
- [HTTP API](../team-and-billing/openapi.md) — what the provider calls underneath
