# Terraform provider for Infrawrench

> **Developed in the [Infrawrench monorepo](https://github.com/Infrawrench/Infrawrench/tree/main/terraform-provider-infrawrench);
> mirrored to [Infrawrench/terraform-provider-infrawrench](https://github.com/Infrawrench/terraform-provider-infrawrench).**
>
> The Terraform Registry resolves a provider to a dedicated public repository
> named `terraform-provider-{NAME}` and reads its releases from that
> repository's tags, which a monorepo subdirectory cannot satisfy. So the
> provider lives here and the mirror's tree is replaced wholesale on every
> release, workflows and this file included. Edit the monorepo copy; anything
> changed or opened in the mirror is overwritten the next time a version ships.
>
> Paths outside this directory (`app/packages/…`, `client-core/…`) are monorepo
> paths and do not exist in the mirror.

Manages **Infrawrench's own configuration** as code: cost allocation and
reporting, monitoring, lifecycle governance, connected accounts and access
control, and alert delivery. 45 resources and 6 data sources, each with its own
plan, its own drift detection and a real `terraform import`.

It does **not** manage your cloud resources. Those belong to your cloud's own
provider, and getting them out of Infrawrench as HCL is what eject-to-Terraform
is for — see the next section.

## What this is not

Three things in Infrawrench have "Terraform" in the name. They do different jobs
and confusing them wastes an afternoon.

| Feature                                                             | What it does                                                                                                                                                        | Direction                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Eject to Terraform** (`infrawrench export`, per-plugin exporters) | Writes HCL describing **your cloud resources** — the EC2 instances, the buckets — so you can walk away from Infrawrench                                             | Infrawrench → HCL, one shot     |
| **Org config as code** (`infrawrench config export/plan/apply`)     | Moves a **whole organization's configuration** as one JSON document: dashboards, workflows, budgets, probes. For cloning an org, seeding staging, disaster recovery | Document ↔ org, whole-org       |
| **This provider**                                                   | Manages **individual Infrawrench configuration objects** as Terraform resources, with per-object plans, drift detection and import                                  | Terraform ↔ objects, per-object |

The dividing line is worth stating plainly: your cloud provider's Terraform
provider creates the database; this one manages the budget that watches what the
database costs, the probe that checks it is up, the schedule that powers it down
at night, and the rule that decides who gets paged when it is not.

They compose fine. Org config as code is the right tool for "make staging look
like production". This provider is the right tool for "budgets live in the
platform team's Terraform repo and go through code review".

---

## Scoping decision: this provider talks to the resource routes directly

The alternative was to wrap the existing config-as-code plan/apply surface
(`client-core/src/org-config.ts`, `GET/POST /api/org/:orgId/config/{export,plan,apply}`).
Wrapping is genuinely attractive: one implementation of validation, diffing and
drift semantics, and the config surface has already solved ordering and
referential integrity.

**It is not usable for this.** Four findings, in descending order of severity.

### 1. It does not carry most of these objects

`ORG_CONFIG_SECTIONS` is a closed list of nine sections: `budgets`,
`customGraphs`, `workflows`, `dashboards`, `metricAlerts`, `probes`,
`costCentres`, `tagPolicy`, `alertSettings`.

Of the forty-five object types this provider manages, the document carries
**four** — budgets, cost centres (with allocation rules nested inside them), tag
policy and metric alerts, plus probes and custom graphs in a lossy form. Saved
filters, cost reports, report folders, cost alerts, scenario models, billing
rules, cost exports, business metrics, accounts, roles, API keys, bastions,
status pages, schedules, freezes, the alert routing table and everything else
have no section and no representation. Wrapping would mean shipping a provider
that could not manage the great majority of what it exists to manage. Nothing
about that is fixable on the provider side; it is a change to the document
format and its server-side apply.

### 2. There is no per-object identity, so there can be no import

The document addresses every entity by a `key` — a slug derived from its display
name — and says so explicitly:

> **Keys, not ids.** Every entity in the document is addressed by a `key` — a
> slug derived from its name — never by a database id. That is what makes one
> document apply to a staging org, a fresh disaster-recovery org, and the org it
> came from.

That property is exactly right for the job config-as-code does, and exactly
wrong for Terraform. Two consequences:

- **Import is impossible.** `terraform import infrawrench_budget.platform <id>`
  needs a stable server-assigned identifier. The document has none to offer, and
  a provider without import is a provider nobody with existing budgets can
  adopt.
- **Renaming becomes destroy-and-recreate.** `slugifyOrgConfigKey` derives the
  key from the name, so renaming a budget changes its identity. Terraform would
  plan a delete and a create — silently discarding the budget's alert history —
  for what is a one-word edit.

### 3. Apply is whole-document and transactional, which fights Terraform's graph

`POST /config/apply` takes an entire document and applies it in one transaction.
A Terraform run that touches one budget would have to send a document, and
Terraform walks its graph with a default parallelism of ten. Ten resources
applying concurrently means ten overlapping read-modify-write cycles against one
whole-org document: last writer wins, and the losers' changes vanish without an
error.

### 4. Deleting one object requires owning every object

Apply has two modes. `merge` creates and updates but never deletes — so
`terraform destroy` could not remove anything. `replace` deletes entities the
document does not name _within the sections it carries_ — so deleting one budget
means sending a document containing every other budget in the organization, and
any budget created outside Terraform gets destroyed as collateral.

Terraform's core promise is that it manages the resources in your configuration
and leaves everything else alone. Neither mode can honour it.

### Also: the document is lossy

Even for the three types it does carry, the document is a subset.
`OrgConfigBudget` has `key`, `name`, `amountCents`, `currency`, `filters` and
`thresholds` — while the budget routes additionally accept `savedFilterId`,
`scenarioModelId`, `costBasis` and `useAdjustedSpend`. `OrgConfigCostCentre` has
no `parentId`, so the cost-centre hierarchy is invisible to it, and its nested
allocation rules identify accounts by display name rather than by id.

### What this costs

Talking to the routes directly means the provider re-implements diffing and
drift detection — which is the work Terraform's framework does anyway — and it
means the provider must track the routes as they change. That last risk is
mitigated by keeping every wire shape in one package and testing it against the
OpenAPI document; see below.

The payoff is per-resource plans that read the way a practitioner expects, real
`terraform import`, deletions that affect exactly one object, and access to the
full field set of every object.

---

## Generated or hand-written? Hand-written, with a drift test

The repository already generates nine SDKs from `app/packages/web/openapi.json`,
Go among them, and adding a tenth target would have inherited version stamping
and the publish gate for free. It was still the wrong choice here, for two
reasons that are specific to this provider rather than to the generator.

**The spec lags the routes.** When this provider was written, scenario models
and billing rules were absent from `openapi.json` entirely — their routes
existed and their OpenAPI sources existed, but the document had not been
regenerated since they landed. Generating from it would have produced a provider
missing two resources. The 1.9.0 regeneration brought them in, and
`schemasKnownAbsent` in the drift test is empty as a result; the gap it records
is a recurring condition rather than a one-off, so the mechanism stays.

**The generator's IR drops the signals a provider needs.** It does not read
`discriminator`, so tagged unions collapse to `any` — which is precisely what
happens to `CostExportDestination` and `CostDateRange`, two shapes this provider
has to render as typed nested blocks. It also discards `readOnly` and `default`,
and those are exactly the signals that decide whether a Terraform attribute is
`Computed` and whether a plan diff is spurious. A generated type would have been
`any` where the schema matters most.

So the wire shapes are hand-written, in `internal/iw/wire.go` (cost allocation
and reporting) and `internal/iw/wire_platform.go` (everything else), and nothing
outside `internal/iw` builds a URL or a JSON body. The split is by domain and
purely for readability — the invariant that matters is the package boundary, not
the file count. The single source of truth is that package, and
`internal/iw/wire_spec_test.go` guards it: for every
schema `openapi.json` _does_ carry, it asserts that each property is either
decoded by the corresponding Go struct or named in an explicit ignore list with
a written reason. A field added to the API fails the build until somebody has
looked at it. The check runs one way only — extra Go fields are expected,
because the checked-in spec lags the routes.

It also records the schemas known to be missing, and fails when they appear, so
regenerating the spec pulls them into coverage rather than leaving them silently
uncovered. That list is empty today; the test says so out loud rather than
passing in silence.

---

## Install

Requires Go 1.25 or newer to build. This module is deliberately **not** part of
the pnpm workspace or the Turbo build graph — it is a standalone Go module with
its own toolchain.

```sh
cd terraform-provider-infrawrench
go build ./...
go test ./...
```

For local development, point Terraform at your build with a dev override in
`~/.terraformrc`:

```hcl
provider_installation {
  dev_overrides {
    "Infrawrench/infrawrench" = "/path/to/terraform-provider-infrawrench"
  }
  direct {}
}
```

## Authentication

```hcl
provider "infrawrench" {
  base_url        = "https://app.infrawrench.com" # optional
  api_key         = var.infrawrench_api_key       # prefer the env var
  organization_id = "org_01HXYZABCDEF"
}
```

Every argument falls back to an environment variable:

| Argument          | Environment variable   | Default                       |
| ----------------- | ---------------------- | ----------------------------- |
| `base_url`        | `INFRAWRENCH_BASE_URL` | `https://app.infrawrench.com` |
| `api_key`         | `INFRAWRENCH_API_KEY`  | — (required)                  |
| `organization_id` | `INFRAWRENCH_ORG_ID`   | — (required)                  |

Use the environment variables in CI so the credential never reaches a `.tf` file
or a saved plan.

### Two resources are closed to API keys

The provider sends `Authorization: Bearer <token>` and accepts either an
Infrawrench API key (`iwk_…`) or a WorkOS access token. Both work against the
whole org tree, and an API key is the credential to reach for in CI: it is
long-lived, scoped, revocable and pinned to one organization.

A short deny-list closes two of this provider's resources to API keys, whatever
scopes they hold:

| Resource              | With an API key        | Why                                                                                                     |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `infrawrench_api_key` | Closed entirely        | A key that can mint keys can mint a longer-lived, differently-scoped one and outlive its own revocation |
| `infrawrench_role`    | Readable, not writable | A key should not manufacture durable authority for other principals                                     |

Everything else in the provider is reachable with a correctly scoped key. If
your configuration manages either of those two, run that root with a WorkOS
access token — or, better, keep credential and role definitions in a separate
root a human applies, which is the separation the deny-list is arguing for
anyway.

The provider recognises this specific 403 and says which resource is affected
rather than leaving you to read a permission error that is not about
permissions.

### Scopes

| Objects                                                                                                                                   | Read                        | Write                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| Budgets                                                                                                                                   | `budgets:read`              | `budgets:write`                                                            |
| Cost centres, allocation rules, saved filters, reports, folders, alerts, annotations, scenario models, business metrics, managed accounts | `costs:read`                | `costs:write`                                                              |
| Tag policy                                                                                                                                | `resources:read`            | `org:settings:write`                                                       |
| Billing rules, cost exports, report notifications, currency and exchange rates                                                            | `costs:read`                | `org:settings:write`                                                       |
| Probes, status pages, sleep schedules, log queries                                                                                        | `resources:read`            | `resources:write`                                                          |
| Metric alerts                                                                                                                             | `metric-alerts:read`        | `metric-alerts:write`                                                      |
| Custom graphs                                                                                                                             | `dashboards:read`           | `dashboards:write`                                                         |
| Change freezes                                                                                                                            | `freezes:read`              | `freezes:write`                                                            |
| Accounts                                                                                                                                  | `accounts:read`             | `accounts:write` (credentials: `secrets:write`; delete: `accounts:delete`) |
| Bastions                                                                                                                                  | `bastions:read`             | `bastions:write`                                                           |
| SSH keys, SSH snippets                                                                                                                    | `ssh-keys:read`             | `ssh-keys:write`                                                           |
| API keys                                                                                                                                  | `apikeys:read`              | `apikeys:write`                                                            |
| Roles                                                                                                                                     | `team:read`                 | `team:role:write`                                                          |
| Deploy triggers                                                                                                                           | `deployments:read`          | `deployments:write`                                                        |
| Workflow schedules                                                                                                                        | `workflows:read`            | `workflows:write`                                                          |
| Session recording settings                                                                                                                | `session-recordings:read`   | `session-recordings:write`                                                 |
| Jira / Linear connections                                                                                                                 | `jira:read` / `linear:read` | `jira:write` / `linear:write`                                              |
| Alert routing, Slack channels, Teams webhooks, digest, drift / expiry / posture alert settings                                            | `org:settings:write`        | `org:settings:write`                                                       |

Three shapes are worth noticing.

- **Asymmetric pairs.** Billing rules, cost exports and report notifications read
  with `costs:read` but write with `org:settings:write`: a token holding only
  `costs:write` can see them and cannot manage them.
- **Org settings read with the write scope.** Alert routing, Slack, Teams and the
  digest have no separate read permission — the GET is gated on
  `org:settings:write` too, so a read-only token cannot refresh them at all.
- **Accounts need three.** Connecting is `accounts:write`, rotating credentials
  is `secrets:write`, disconnecting is `accounts:delete`. They are separate
  routes because they are separate decisions, and the provider surfaces a
  failure on whichever half a token may not do rather than refusing the whole
  update.

---

## Worked example

A platform team owning its own budget, allocation and reporting, in one file.

```hcl
terraform {
  required_providers {
    infrawrench = {
      source  = "Infrawrench/infrawrench"
      version = "~> 0.1"
    }
  }
}

provider "infrawrench" {
  organization_id = "org_01HXYZABCDEF"
  # api_key comes from INFRAWRENCH_API_KEY
}

# Resolve account ids rather than hard-coding them.
data "infrawrench_accounts" "production" {
  plugin_id = "aws"
}

# One filter, defined once, reused by everything below.
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

# Anything tagged team=platform is allocated to the platform cost centre.
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
  amount_cents    = 4_500_000 # $45,000
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

resource "infrawrench_cost_report_folder" "platform" {
  name = "Platform"
}

resource "infrawrench_cost_report" "platform_by_service" {
  name      = "Platform spend by service"
  folder_id = infrawrench_cost_report_folder.platform.id

  config {
    chart_type = "stacked_bar"
    binning    = "daily"
    group_by   = "service"
    top_n      = 10

    date_range {
      kind   = "relative"
      preset = "last_30_days"
    }

    filter {
      dimension = "tag"
      tag_key   = "team"
      op        = "in"
      values    = ["platform"]
    }
  }
}

# The report lands in Slack every Monday morning.
resource "infrawrench_cost_report_notification" "platform_weekly" {
  cost_report_id    = infrawrench_cost_report.platform_by_service.id
  cadence           = "weekly"
  send_day          = 1
  hour              = 9
  timezone          = "Europe/Berlin"
  slack_channel_ids = [infrawrench_slack_channel.platform.id]
}

output "platform_account_ids" {
  value = [for a in data.infrawrench_accounts.production.accounts : a.id]
}
```

### Beyond cost: the rest of the surface

The same file can carry the monitoring, governance and delivery configuration
that a platform team would otherwise click together by hand.

```hcl
# Alerts have to land somewhere before routing them means anything. The
# workspace connection itself is an OAuth flow, so it is read, not created.
data "infrawrench_slack_installations" "workspace" {}

resource "infrawrench_slack_channel" "platform" {
  installation_id = data.infrawrench_slack_installations.workspace.installations[0].id
  channel_id      = "C0123456789"
  channel_name    = "platform-alerts"
}

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

# Resolve the resource rather than hard-coding its id.
data "infrawrench_resources" "api" {
  account_id       = data.infrawrench_accounts.production.accounts[0].id
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

# The graph is code, so it lives beside the code.
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

# Order is the semantics: narrow rules first, broad ones after.
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

    # Hold overnight rather than dropping: a held alert is delivered when the
    # window closes. Critical is exempt.
    quiet_hours {
      timezone        = "Europe/Berlin"
      start_minute    = 1320 # 22:00
      end_minute      = 420  # 07:00 — an overnight window
      days            = [1, 2, 3, 4, 5]
      urgent_override = "critical"
    }

    # Nobody acknowledged in fifteen minutes? Widen it.
    escalation {
      after_minutes = 15

      destination {
        kind       = "slack"
        channel_id = infrawrench_slack_channel.platform.id
      }
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

## Importing existing objects

Nobody adopts a provider into an empty organization, so everything with a
server-assigned id imports by that id:

```sh
terraform import infrawrench_budget.platform              b1f2c3d4-...
terraform import infrawrench_cost_centre.platform         9a8b7c6d-...
terraform import infrawrench_allocation_rule.platform_tag 4e5f6a7b-...
terraform import infrawrench_saved_filter.platform        2c3d4e5f-...
terraform import infrawrench_probe.api                    7b8c9d0e-...
terraform import infrawrench_role.finance                 1a2b3c4d-...
```

Three shapes differ.

**Organization singletons** have no id of their own, so they import under the
organization id — any value is accepted, since there is only ever one:

```sh
terraform import infrawrench_tag_policy.this          org_01HXYZABCDEF
terraform import infrawrench_alert_routing.org        org_01HXYZABCDEF
terraform import infrawrench_currency_settings.this   org_01HXYZABCDEF
terraform import infrawrench_jira_integration.this    org_01HXYZABCDEF
```

The full list: `tag_policy`, `alert_routing`, `currency_settings`,
`anomaly_settings`, `efficiency_alert_settings`, `drift_alert_settings`,
`expiry_alert_settings`, `posture_alert_settings`,
`session_recording_settings`, `digest_settings`, `jira_integration`,
`linear_integration`.

**Report notifications** hang off a report, so the notification's own id cannot
build a URL. They import under a composite address:

```sh
terraform import infrawrench_cost_report_notification.weekly <report-id>/<notification-id>
```

**Workflow schedules** are addressed by the workflow they belong to:

```sh
terraform import infrawrench_workflow_schedule.nightly <workflow-id>
```

### Secrets do not come back

Several resources hold write-only material that no route returns. Importing them
works; recovering the secret does not. After importing, supply it in
configuration — or, where the API accepts an omitted credential as "keep the
stored one", leave it out.

| Resource                         | Not recoverable                    | What is readable                     |
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

The provider cannot detect drift on any of them. That is a property of the API
rather than a shortcut here: the values are genuinely not returned, by design.

### State-file warning

`infrawrench_api_key`, `infrawrench_ssh_key` (in generate mode) and
`infrawrench_bastion` each write a credential into Terraform state in plaintext,
because the API returns it exactly once and never again. Use them only with a
state backend you would put any other secret in — encrypted, access-controlled,
not a local file in a repository — and prefer piping the value straight into the
secret store that consumes it rather than into an output.

## Resources and data sources

### Cost allocation and reporting

| Resource                                | Import    | Notes                                                |
| --------------------------------------- | --------- | ---------------------------------------------------- |
| `infrawrench_budget`                    | by id     | Live spend status is deliberately not exposed        |
| `infrawrench_cost_centre`               | by id     | No single-GET route; read lists and filters          |
| `infrawrench_allocation_rule`           | by id     | Lower priority wins; first match only                |
| `infrawrench_tag_policy`                | by org id | Org singleton; destroy resets to unenforced          |
| `infrawrench_saved_filter`              | by id     | `filter` and `query` are mutually exclusive          |
| `infrawrench_cost_report`               | by id     |                                                      |
| `infrawrench_cost_report_folder`        | by id     | No single-GET route                                  |
| `infrawrench_cost_report_notification`  | composite | `<report-id>/<notification-id>`; needs a destination |
| `infrawrench_cost_alert`                | by id     | Needs at least one threshold                         |
| `infrawrench_cost_annotation`           | by id     | An end equal to the start is stored as null          |
| `infrawrench_scenario_model`            | by id     | Adjustment `key` is caller-assigned                  |
| `infrawrench_billing_rule`              | by id     | Query-time restatement; `amount` is a major unit     |
| `infrawrench_cost_export`               | by id     | Credentials are write-only and never imported        |
| `infrawrench_business_metric`           | by id     | Definition only; values are a pushed time series     |
| `infrawrench_managed_account`           | by id     | A centre or account belongs to at most one           |
| `infrawrench_currency_settings`         | by org id | Org singleton; destroy clears, rates survive         |
| `infrawrench_exchange_rate`             | by id     | Upsert keyed on (from, to, effective_from)           |
| `infrawrench_anomaly_settings`          | by org id | Org singleton; destroy restores the defaults         |
| `infrawrench_efficiency_alert_settings` | by org id | Org singleton; destroy restores the defaults         |

### Monitoring

| Resource                   | Import | Notes                                                 |
| -------------------------- | ------ | ----------------------------------------------------- |
| `infrawrench_probe`        | by id  | Numeric fields are clamped server-side                |
| `infrawrench_status_page`  | by id  | `slug` is minted with entropy; rotation is not a plan |
| `infrawrench_metric_alert` | by id  | Selects resources by query, so it covers future ones  |
| `infrawrench_log_query`    | by id  | One to eight streams; alerting is opt-in              |
| `infrawrench_custom_graph` | by id  | `source` is TypeScript — use `file()`                 |

### Lifecycle governance

| Resource                                 | Import    | Notes                                                     |
| ---------------------------------------- | --------- | --------------------------------------------------------- |
| `infrawrench_schedule`                   | by id     | Resource and account are create-only                      |
| `infrawrench_change_freeze`              | by id     | `starts_at` is Optional and Computed; ending is an action |
| `infrawrench_drift_alert_settings`       | by org id | Org singleton; destroy is a no-op                         |
| `infrawrench_expiry_alert_settings`      | by org id | Org singleton; destroy is a no-op                         |
| `infrawrench_posture_alert_settings`     | by org id | Org singleton; destroy is a no-op                         |
| `infrawrench_session_recording_settings` | by org id | Org singleton; destroy deliberately leaves it running     |

### Accounts and access

| Resource                        | Import         | Notes                                                       |
| ------------------------------- | -------------- | ----------------------------------------------------------- |
| `infrawrench_account`           | by id          | Credentials are write-only; three permissions, three routes |
| `infrawrench_bastion`           | by id          | Token returned once; renaming re-enrols                     |
| `infrawrench_role`              | by id          | Built-in roles are refused rather than half-managed         |
| `infrawrench_api_key`           | by id          | Every attribute replaces; delete is revoke                  |
| `infrawrench_ssh_key`           | by id          | Import a public key, or generate and hold the private one   |
| `infrawrench_ssh_snippet`       | by id          | Registers a command; does not run it                        |
| `infrawrench_deploy_trigger`    | by id          | `enabled` is the only mutable field                         |
| `infrawrench_workflow_schedule` | by workflow id | Attaches a cron to a workflow it does not own               |

### Alert delivery

| Resource                         | Import    | Notes                                                       |
| -------------------------------- | --------- | ----------------------------------------------------------- |
| `infrawrench_alert_routing`      | by org id | The whole ordered table; destroy restores the defaults      |
| `infrawrench_slack_channel`      | by id     | The workspace connection is an OAuth flow, read not written |
| `infrawrench_msteams_webhook`    | by id     | URL is write-only and Microsoft-host-restricted             |
| `infrawrench_digest_settings`    | by org id | Org singleton; destinations come from the routing table     |
| `infrawrench_digest_recipient`   | by id     | Address is normalized server-side                           |
| `infrawrench_jira_integration`   | by org id | Org singleton; omitting the token keeps the stored one      |
| `infrawrench_linear_integration` | by org id | Org singleton; omitting the key keeps the stored one        |

### Data sources

| Data source                       | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| `infrawrench_accounts`            | Resolve account ids for rule matches                 |
| `infrawrench_plugins`             | Resolve valid plugin ids                             |
| `infrawrench_cost_centres`        | Reference centres created outside Terraform          |
| `infrawrench_resources`           | Resolve a synced resource id for a probe or schedule |
| `infrawrench_permissions`         | The catalogue roles and API keys grant from          |
| `infrawrench_slack_installations` | Resolve the workspace a channel belongs to           |

## Testing

```sh
go test ./...                 # unit tests: schema validity, state mapping, wire drift
TF_ACC=1 go test ./... -v     # adds acceptance tests, which need a live org
```

Acceptance tests create and destroy real objects and are skipped unless `TF_ACC`
is set **and** `INFRAWRENCH_API_KEY` and `INFRAWRENCH_ORG_ID` are present. Point
them at a scratch organization, never a production one.

## Releasing

The Terraform Registry resolves straight to a Git URL and requires a **dedicated
public repository** named `terraform-provider-{NAME}`. A monorepo subdirectory
cannot be published, so the provider is developed here and mirrored to
`Infrawrench/terraform-provider-infrawrench` — the same arrangement the Go,
Swift and PHP SDKs use, and for the same reason.

**The monorepo is the direction of truth.** The satellite's tree is replaced
wholesale on every release, its own workflows included, so nothing there is
hand-maintained and a file deleted here disappears there. Do not edit the
satellite; the next release overwrites it.

To cut a release, change `VERSION` and merge to `main`. That is the whole
ritual:

1. `.github/workflows/publish-terraform-provider.yml` reads `VERSION` and checks
   the monorepo for the tag `terraform-provider-v<version>` — the ledger. An
   unchanged version is a no-op, so an ordinary provider change does not
   publish.
2. It re-runs gofmt, build, vet and the tests against the exact bytes about to
   ship, then mirrors this directory into the satellite and pushes `vX.Y.Z`.
3. That tag starts the satellite's own `release.yml` (mirrored from
   `.github/workflows/` in this directory, inert here because GitHub only reads
   workflows from a repository root). It runs GoReleaser, which builds the
   platform matrix, writes `_SHA256SUMS`, GPG-signs it, and attaches the
   registry manifest.
4. The Registry ingests the release and verifies the signature against the
   public key registered with the namespace.
5. The monorepo tag is written last, so it means "the release was handed off"
   rather than "somebody started one".

What that needs configured once, outside this repository:

- The satellite repository, public, named exactly `terraform-provider-infrawrench`.
- The SDK publisher GitHub App's installation extended to it. OIDC cannot grant
  write access to another repository, so this is the one unavoidable stored
  credential; the App token is installation-scoped and expires in an hour.
- `GPG_PRIVATE_KEY` and `PASSPHRASE` in the satellite, with the public half
  registered on the Registry namespace.
- The namespace `Infrawrench` claimed on registry.terraform.io. It must match
  the address in `main.go` (`registry.terraform.io/Infrawrench/infrawrench`) and
  the GitHub org that owns the satellite.

Versioning is the provider's own, not the API's. It is a client: `API_VERSION`
moving does not oblige a release here, and a provider fix ships without touching
the API. While the major is `0`, the resource schemas are still allowed to move.

**A released version is never re-cut.** The tag is the exact bytes the Registry
ingested, so a packaging mistake costs a version number rather than a force
push — `v0.1.0` was burnt that way, publishing the registry manifest without a
checksum for it. That is also why the publish workflow dry-runs the release and
checks the artifacts are ingestible _before_ it touches the satellite: the last
place you want to discover a packaging bug is the Registry, because by then the
tag exists and the only way out is another version.

## Repository notes

- This module is **not** in the pnpm workspace or `turbo.json`. It is a Go
  module with its own toolchain and its own test command, and
  `.github/workflows/terraform-provider.yml` is its CI.
- It is **not** added to `cliff.toml`'s `include_paths`. That list scopes the
  desktop changelog to the desktop app and the workspace packages it
  transitively depends on; a standalone Go module is outside that closure, and
  adding it would put provider commits into the desktop app's changelog.
- The provider is **MIT licensed**, which is not the repository's BUSL-1.1. That
  is deliberate: a Terraform provider is a client library people vendor into
  their own infrastructure repositories, and it has to carry a licence that lets
  them. `LICENSE` in this directory governs everything under it, and the mirror
  carries it to the satellite.
