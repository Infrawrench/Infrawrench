---
title: Terraform provider
description: Manage Infrawrench's own configuration — budgets and cost policy, probes and alerts, schedules and freezes, accounts, roles and alert routing — as Terraform resources.
sidebar_order: 7
---

The Infrawrench Terraform provider manages **Infrawrench's own configuration** as Terraform resources: cost allocation and reporting, monitoring, lifecycle governance, connected accounts and access control, and alert delivery. 45 resources and 6 data sources, each with its own plan, its own drift detection, and its own `terraform import`.

It is for teams who already keep infrastructure in Terraform and want the rest of their platform configuration to arrive the same way — through a pull request, reviewed, with a plan that says exactly what will change.

It does **not** manage your cloud resources. Your cloud provider's own Terraform provider creates the database; this one manages the budget that watches what the database costs, the probe that checks it is up, the schedule that powers it down at night, and the rule that decides who gets paged when it is not.

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

- **The document doesn't carry most of these objects.** It has sections for budgets, cost centres, tag policy and metric alerts — but not for saved filters, cost reports, cost alerts, scenario models, billing rules, cost exports, business metrics, accounts, roles, API keys, bastions, status pages, schedules, freezes, the alert routing table, or most of the rest.
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

Beyond cost, each area uses the permission the matching page in the app uses — `resources:write` for probes, status pages, sleep schedules and log queries; `metric-alerts:write` for metric alerts; `dashboards:write` for custom graphs; `freezes:write` for change freezes; `bastions:write`, `ssh-keys:write`, `apikeys:write` and `team:role:write` for the access resources; and `org:settings:write` for alert routing, Slack, Teams and the weekly digest. The full table is in the provider's README.

Two of those need care. Alert routing, Slack, Teams and the digest have **no separate read permission** — their GET is gated on `org:settings:write` too, so a read-only key cannot even refresh them. And an account needs three: `accounts:write` to connect, `secrets:write` to rotate its credentials, `accounts:delete` to disconnect.

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

## Beyond cost

The same file can carry the monitoring, governance and alert-delivery configuration a platform team would otherwise click together by hand.

```hcl
# One rule written once covers every instance the team creates afterwards:
# resources are selected by query, never by id.
resource "infrawrench_metric_alert" "cpu" {
  name        = "Platform CPU sustained"
  tag_key     = "team"
  tag_value   = "platform"
  metric_key  = "CPU %"
  comparator  = ">"
  threshold   = 90
  for_minutes = 20
}

resource "infrawrench_probe" "api" {
  name = "API health"
  url  = "https://api.example.com/health"
}

resource "infrawrench_status_page" "public" {
  title     = "Acme status"
  published = true

  component {
    probe_id = infrawrench_probe.api.id
    label    = "API"
  }
}

# A custom graph is source code, so it lives beside the rest of your source code.
resource "infrawrench_custom_graph" "burn" {
  name   = "Platform burn"
  source = file("${path.module}/graphs/burn.ts")
}

# A permission set whose diff is the point: adding a grant is a reviewed line.
resource "infrawrench_role" "finance" {
  name        = "Finance"
  description = "Read spend, own budgets, touch nothing else."
  permissions = ["costs:read", "budgets:read", "budgets:write", "invoices:read"]
}
```

Powering a development machine down outside working hours is the cheapest saving there is, and the one nobody remembers to apply by hand. Resolve the resource rather than hard-coding its id:

```hcl
data "infrawrench_resources" "api" {
  account_id       = data.infrawrench_accounts.aws.accounts[0].id
  resource_type_id = "ec2_instance"
  name_contains    = "api"
}

resource "infrawrench_schedule" "api_nights" {
  resource_id  = data.infrawrench_resources.api.resources[0].id
  account_id   = data.infrawrench_resources.api.resources[0].account_id
  days_of_week = [1, 2, 3, 4, 5]
  stop_time    = "19:00"
  start_time   = "08:00"
  timezone     = "Europe/Berlin"
}
```

<insert [A terraform plan output showing infrawrench_schedule and infrawrench_probe resources being created, with the projected monthly saving visible in the plan] here>

### Alert routing is one resource, in order

[Alert routing](./alert-routing.md) is a single ordered table rather than one resource per rule, because order is the semantics: the list is evaluated top to bottom and is first-match-wins unless a rule sets `continue_on_match`. A rule cannot meaningfully be written without saying where it sits, so per-rule resources would have needed a position attribute and then a way to stop two configurations claiming the same slot.

```hcl
data "infrawrench_slack_installations" "workspace" {}

resource "infrawrench_slack_channel" "platform" {
  installation_id = data.infrawrench_slack_installations.workspace.installations[0].id
  channel_id      = "C0123456789"
  channel_name    = "platform-alerts"
}

resource "infrawrench_alert_routing" "org" {
  rule {
    name = "Spend goes to the platform channel"

    condition {
      field  = "trigger"
      op     = "in"
      values = ["budgetAlerts", "anomalyAlerts", "costChangeAlerts"]
    }

    destination {
      kind       = "slack"
      channel_id = infrawrench_slack_channel.platform.id
    }
  }

  rule {
    name = "Anything critical also wakes phones"

    condition {
      field    = "severity"
      op       = "gte"
      severity = "critical"
    }

    destination {
      kind = "push"
    }
  }

  rule {
    name = "Swallow drift chatter"

    condition {
      field  = "trigger"
      op     = "in"
      values = ["resourceDrift"]
    }
    # No destination: an enabled rule with nowhere to go silences the category
    # without deleting the rules that would otherwise catch it.
  }
}
```

Connecting the Slack workspace itself is an OAuth flow, which a Terraform provider cannot perform. Install the app once on **Settings → Alerts**, then read the installation with `data.infrawrench_slack_installations`.

## Adopting what you already have

Nobody starts from an empty organization, so every object with an id imports:

```sh
terraform import infrawrench_budget.platform      b1f2c3d4-...
terraform import infrawrench_cost_centre.platform 9a8b7c6d-...
terraform import infrawrench_probe.api            2c3d4e5f-...
terraform import infrawrench_role.finance         1a2b3c4d-...
```

The id is in the URL when you open the object in the app, and in the `--json` output of the [CLI](./cli.md).

**Organization singletons** — the ones there is only ever one of, with no id of their own — import under the organization id:

```sh
terraform import infrawrench_tag_policy.this       org_01HXYZABCDEF
terraform import infrawrench_alert_routing.org     org_01HXYZABCDEF
```

That covers [tag policy](./tag-policy-and-showback.md), [alert routing](./alert-routing.md), currency settings, the [anomaly](./cost-anomaly-alerts.md) and [efficiency](./commitment-and-unit-cost-alerts.md) alert settings, the drift, expiry and posture alert settings, [session recording](./session-recording.md), the [weekly digest](./weekly-digest.md), and the [Jira](./jira.md) and [Linear](./linear.md) connections.

Two resources import under something other than their own id. A [report notification](./cost-reports.md) hangs off its report, so it takes `<report-id>/<notification-id>`; a workflow schedule takes the id of the [workflow](./workflows.md) it belongs to.

### Secrets don't come back

Several resources hold write-only material that no route returns. Importing them works — recovering the secret does not. After importing, put it back in your configuration; where the API accepts an omitted credential as "keep the stored one", you can leave it out instead.

| Resource                         | Not recoverable                    | What you can still read              |
| -------------------------------- | ---------------------------------- | ------------------------------------ |
| `infrawrench_cost_export`        | access key, secret, webhook URL    | `has_credentials`, `credential_hint` |
| `infrawrench_account`            | the whole `credentials` map        | nothing                              |
| `infrawrench_api_key`            | `key` — returned once, at creation | `prefix`                             |
| `infrawrench_ssh_key`            | `private_key` — returned once      | `public_key`, `fingerprint`          |
| `infrawrench_bastion`            | `token` — returned once            | `token_prefix`                       |
| `infrawrench_msteams_webhook`    | `url`                              | `url_hint`                           |
| `infrawrench_jira_integration`   | `api_token`                        | `token_hint`                         |
| `infrawrench_linear_integration` | `api_key`                          | `key_hint`                           |
| `infrawrench_deploy_trigger`     | `answers`                          | nothing                              |

The provider can't detect drift on any of these. That's a property of the API rather than a limitation of the provider — the values genuinely aren't returned, deliberately.

### One warning about state files

[`infrawrench_api_key`](../team-and-billing/api-keys.md), `infrawrench_ssh_key` in generate mode, and `infrawrench_bastion` each write a credential into your Terraform state in plaintext, because the API returns it exactly once and never again.

Use them only with a state backend you'd put any other secret in — encrypted, access-controlled, not a local file in a repository. Prefer piping the value straight into the secret store that consumes it rather than into a Terraform output.

## What's managed

### Cost allocation and reporting

| Resource                                | Manages                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `infrawrench_budget`                    | [Budgets](./cloud-costs.md#budgets) and their alert thresholds                    |
| `infrawrench_cost_centre`               | [Cost centres](./tag-policy-and-showback.md)                                      |
| `infrawrench_allocation_rule`           | The rules that map spend onto cost centres                                        |
| `infrawrench_tag_policy`                | [Required tags](./tag-policy-and-showback.md) and their enforcement               |
| `infrawrench_saved_filter`              | [Saved cost filters](./cloud-costs.md)                                            |
| `infrawrench_cost_report`               | [Cost reports](./cost-reports.md)                                                 |
| `infrawrench_cost_report_folder`        | Report folders                                                                    |
| `infrawrench_cost_report_notification`  | Scheduled delivery of a report to Slack, Teams or email                           |
| `infrawrench_cost_alert`                | [Cost change alerts](./cost-change-alerts.md)                                     |
| `infrawrench_cost_annotation`           | Notes pinned to a date on cost charts                                             |
| `infrawrench_scenario_model`            | [Scenario models](./scenario-models.md)                                           |
| `infrawrench_billing_rule`              | [Billing rules](./billing-rules.md)                                               |
| `infrawrench_cost_export`               | [Scheduled cost exports](./cost-exports.md)                                       |
| `infrawrench_business_metric`           | [Unit-cost](./unit-costs.md) denominators — the definition, not the values        |
| `infrawrench_managed_account`           | [Managed accounts](./managed-accounts.md) an MSP bills                            |
| `infrawrench_currency_settings`         | The organization's display currency                                               |
| `infrawrench_exchange_rate`             | One stated rate, effective from a day                                             |
| `infrawrench_anomaly_settings`          | [Anomaly detection](./cost-anomaly-alerts.md) thresholds                          |
| `infrawrench_efficiency_alert_settings` | [Commitment and unit-cost alert](./commitment-and-unit-cost-alerts.md) thresholds |

### Monitoring

| Resource                   | Manages                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `infrawrench_probe`        | [Synthetic probes](./synthetic-probes.md)                          |
| `infrawrench_status_page`  | [Public status pages](./status-pages.md) and their components      |
| `infrawrench_metric_alert` | [Metric threshold alerts](./metric-alerts.md)                      |
| `infrawrench_log_query`    | [Log workspace](./log-workspace.md) saved queries and match alerts |
| `infrawrench_custom_graph` | [Custom graphs](./custom-graphs.md), source and all                |

### Lifecycle governance

| Resource                                 | Manages                                                         |
| ---------------------------------------- | --------------------------------------------------------------- |
| `infrawrench_schedule`                   | [Sleep schedules](./sleep-schedules.md)                         |
| `infrawrench_change_freeze`              | [Change freezes](../team-and-billing/change-freeze.md)          |
| `infrawrench_drift_alert_settings`       | What the [change timeline](./change-timeline.md) notifies about |
| `infrawrench_expiry_alert_settings`      | [Expiry radar](./expiry-radar.md) lead time                     |
| `infrawrench_posture_alert_settings`     | Whether [posture findings](./posture-checks.md) notify          |
| `infrawrench_session_recording_settings` | [Session recording](./session-recording.md) and retention       |

### Accounts and access

| Resource                        | Manages                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `infrawrench_account`           | Connected [cloud accounts](../core-concepts/resources-and-accounts.md)       |
| `infrawrench_bastion`           | [Bastion agent](./bastion-vms.md) enrollments                                |
| `infrawrench_role`              | Custom [roles and permissions](../team-and-billing/roles-and-permissions.md) |
| `infrawrench_api_key`           | [API keys](../team-and-billing/api-keys.md)                                  |
| `infrawrench_ssh_key`           | [SSH keys](../team-and-billing/ssh-keys.md), imported or generated           |
| `infrawrench_ssh_snippet`       | Saved [SSH fan-out](./ssh-fanout.md) commands                                |
| `infrawrench_deploy_trigger`    | Redeploy-on-push triggers for [Infrafile](./infrafile.md) projects           |
| `infrawrench_workflow_schedule` | The cron on an existing [workflow](./workflows.md)                           |

### Alert delivery

| Resource                         | Manages                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `infrawrench_alert_routing`      | The whole ordered [alert routing](./alert-routing.md) table |
| `infrawrench_slack_channel`      | [Slack](./slack-alerts.md) channels as destinations         |
| `infrawrench_msteams_webhook`    | [Teams](./teams-alerts.md) webhooks as destinations         |
| `infrawrench_digest_settings`    | When the [weekly digest](./weekly-digest.md) is sent        |
| `infrawrench_digest_recipient`   | An email address the digest goes to                         |
| `infrawrench_jira_integration`   | The [Jira](./jira.md) connection                            |
| `infrawrench_linear_integration` | The [Linear](./linear.md) connection                        |

### Data sources

| Data source                       | Reads                                                       |
| --------------------------------- | ----------------------------------------------------------- |
| `infrawrench_accounts`            | Connected accounts — for resolving account ids              |
| `infrawrench_plugins`             | Available plugins — for resolving plugin ids                |
| `infrawrench_cost_centres`        | Cost centres, including ones not managed by Terraform       |
| `infrawrench_resources`           | Synced resources — for resolving a probe or schedule target |
| `infrawrench_permissions`         | The permission catalogue roles and keys grant from          |
| `infrawrench_slack_installations` | Connected Slack workspaces                                  |

## Things worth knowing

**Objects deleted outside Terraform come back.** Every resource does a real read on refresh. If someone deletes a budget in the app, the next plan shows it as needing to be created again rather than failing.

**Live figures aren't in state.** A budget's month-to-date spend, an alert's last-fired time, a probe's uptime, an export's last run — none of it appears as a Terraform attribute. It changes constantly, and putting it in state would make every plan noisy for no benefit. Read those from the app, the [CLI](./cli.md), or the [API](../team-and-billing/openapi.md).

**Singletons don't really get destroyed.** There is always exactly one anomaly settings row, one routing table, one tag policy — so `terraform destroy` can't remove them. Each one does the sensible thing instead, and it differs on purpose:

- The cost settings and [alert routing](./alert-routing.md) **restore the shipped defaults**. An organization routing nothing at all is a worse state than the default one.
- Currency settings **clear the display currency**, which turns conversion off. Your stated exchange rates survive, so you can turn it back on without re-entering them.
- [Session recording](./session-recording.md) is deliberately **left running**. Silently disabling an audit control because someone deleted a resource block is not a safe default.
- The drift, expiry and posture alert settings are **left alone** — they have no documented shipped values to restore to.

**Deletes can be refused.** Saved filters and scenario models something still points at return a conflict rather than being deleted, and the error names what's referencing them. A role members still hold, and a managed account with invoices against it, are refused the same way. Repoint or reassign first — Terraform won't decide for you which permission set those people should get instead.

**Some things are create-only.** A probe's linked resource, a schedule's resource and account, a Slack channel's workspace, a deploy trigger's repo and branch — the API has no route to change them, so Terraform replaces instead. The plan says so; it's worth reading before applying to a bastion, where replacing means a new enrollment token and an agent that has to be restarted with it.

**Credentials are marked sensitive.** Export keys, account credentials, API keys, SSH private keys, bastion tokens and webhook URLs never appear in plan output in plaintext. They do appear in state — see the warning above.

**Billing rule amounts are in the major currency unit.** Everything else in Infrawrench counts cents; a fixed billing rule's `amount` is dollars. It's the one inconsistency, and it is inherited from the API.

**Custom graph source isn't type-checked at plan time.** The API has a checker, but calling it from a plan would mean your code had to compile before Terraform would tell you what it was about to change. A graph whose source doesn't compile is stored and fails when it renders.

## Related

- [Config as code](./config-as-code.md) — move a whole organization's configuration as one document
- [Terraform export](./terraform-export.md) — write your cloud resources out as HCL
- [The CLI](./cli.md) — the same objects from a terminal
- [HTTP API](../team-and-billing/openapi.md) — what the provider calls underneath
