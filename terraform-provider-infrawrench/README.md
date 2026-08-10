# Terraform provider for Infrawrench

Manages **Infrawrench's own FinOps configuration** as code: budgets, cost
centres, allocation rules, tag policy, saved filters, cost reports and folders,
cost alerts, scenario models, billing rules and cost exports.

## What this is not

Three things in this repository have "Terraform" in the name. They do different
jobs and confusing them wastes an afternoon.

| Feature                                                             | What it does                                                                                                                                                        | Direction                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Eject to Terraform** (`infrawrench export`, per-plugin exporters) | Writes HCL describing **your cloud resources** — the EC2 instances, the buckets — so you can walk away from Infrawrench                                             | Infrawrench → HCL, one shot     |
| **Org config as code** (`infrawrench config export/plan/apply`)     | Moves a **whole organization's configuration** as one JSON document: dashboards, workflows, budgets, probes. For cloning an org, seeding staging, disaster recovery | Document ↔ org, whole-org       |
| **This provider**                                                   | Manages **individual Infrawrench configuration objects** as Terraform resources, with per-object plans, drift detection and import                                  | Terraform ↔ objects, per-object |

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

Of the eleven object types this provider manages, the document carries **three**
— budgets, cost centres (with allocation rules nested inside them) and tag
policy. Saved filters, cost reports, report folders, cost alerts, scenario
models, billing rules and cost exports have no section and no representation.
Wrapping would mean shipping a provider that could not manage eight of the
eleven things it exists to manage. Nothing about that is fixable on the provider
side; it is a change to the document format and its server-side apply.

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

**The spec does not describe two of these objects.** Scenario models and billing
rules are absent from `openapi.json` entirely — their routes exist and their
OpenAPI sources exist, but the document has not been regenerated since they
landed. Generating from it would have produced a provider missing two resources.

**The generator's IR drops the signals a provider needs.** It does not read
`discriminator`, so tagged unions collapse to `any` — which is precisely what
happens to `CostExportDestination` and `CostDateRange`, two shapes this provider
has to render as typed nested blocks. It also discards `readOnly` and `default`,
and those are exactly the signals that decide whether a Terraform attribute is
`Computed` and whether a plan diff is spurious. A generated type would have been
`any` where the schema matters most.

So the wire shapes are hand-written, in one file — `internal/iw/wire.go` — and
nothing outside `internal/iw` builds a URL or a JSON body. The single source of
truth is that package, and `internal/iw/wire_spec_test.go` guards it: for every
schema `openapi.json` _does_ carry, it asserts that each property is either
decoded by the corresponding Go struct or named in an explicit ignore list with
a written reason. A field added to the API fails the build until somebody has
looked at it. The check runs one way only — extra Go fields are expected,
because the checked-in spec lags the routes.

It also records the seven schemas known to be missing, and fails when they
appear, so regenerating the spec pulls them into coverage rather than leaving
them silently uncovered.

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

### Known limitation: API keys are rejected on these routes

The provider sends `Authorization: Bearer <token>` and accepts either an
Infrawrench API key (`iwk_…`) or a WorkOS access token.

**Today, only the WorkOS access token works.** The org-scoped API tree
(`/api/org/{orgId}/…`) is guarded by `sessionMiddleware`, whose Bearer branch
authenticates the token as a WorkOS JWT only; an `iwk_` key is not a JWT, fails
signature verification, and gets a 401 — even when the key is valid, unrevoked
and correctly scoped. The codebase acknowledges this directly: chat and cost
ingest bypass the middleware and call `authenticateOrgRequest` precisely because
"the org tree's normal middleware stack … 401s an `iwk_` key outright".

The provider detects this exact case and attaches an explanatory hint to the
401, rather than leaving you to debug a credential that is not actually wrong.
Making `iwk_` keys work end to end is a **server-side change** — moving these
route groups onto `authenticateOrgRequest`, the way chat and cost ingest already
are — and is deliberately not attempted here.

### Scopes

| Objects                                                                                  | Read             | Write                |
| ---------------------------------------------------------------------------------------- | ---------------- | -------------------- |
| Budgets                                                                                  | `budgets:read`   | `budgets:write`      |
| Cost centres, allocation rules, saved filters, reports, folders, alerts, scenario models | `costs:read`     | `costs:write`        |
| Tag policy                                                                               | `resources:read` | `org:settings:write` |
| Billing rules, cost exports                                                              | `costs:read`     | `org:settings:write` |

Billing rules and cost exports are the asymmetric ones: a token holding only
`costs:write` can read them but cannot manage them.

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

output "platform_account_ids" {
  value = [for a in data.infrawrench_accounts.production.accounts : a.id]
}
```

## Importing existing objects

Everything that has a server-assigned id imports by that id:

```sh
terraform import infrawrench_budget.platform            b1f2c3d4-...
terraform import infrawrench_cost_centre.platform       9a8b7c6d-...
terraform import infrawrench_allocation_rule.platform_tag 4e5f6a7b-...
terraform import infrawrench_saved_filter.platform      2c3d4e5f-...
terraform import infrawrench_cost_report.platform_by_service 7b8c9d0e-...
```

`infrawrench_tag_policy` is an organization singleton with no id of its own, so
it imports under the organization id — any value is accepted, since there is
only ever one:

```sh
terraform import infrawrench_tag_policy.this org_01HXYZABCDEF
```

**Cost export credentials cannot be imported.** The access key, secret and
webhook URL are write-only: no route returns them, by design. After importing an
`infrawrench_cost_export` you must supply them in configuration. The provider
cannot detect drift on them either — `has_credentials` and `credential_hint` are
the only readable signals that a credential exists.

## Resources and data sources

| Resource                         | Import    | Notes                                            |
| -------------------------------- | --------- | ------------------------------------------------ |
| `infrawrench_budget`             | by id     | Live spend status is deliberately not exposed    |
| `infrawrench_cost_centre`        | by id     | No single-GET route; read lists and filters      |
| `infrawrench_allocation_rule`    | by id     | Lower priority wins; first match only            |
| `infrawrench_tag_policy`         | by org id | Org singleton; destroy resets to unenforced      |
| `infrawrench_saved_filter`       | by id     | `filter` and `query` are mutually exclusive      |
| `infrawrench_cost_report`        | by id     |                                                  |
| `infrawrench_cost_report_folder` | by id     | No single-GET route                              |
| `infrawrench_cost_alert`         | by id     | Needs at least one threshold                     |
| `infrawrench_scenario_model`     | by id     | Adjustment `key` is caller-assigned              |
| `infrawrench_billing_rule`       | by id     | Query-time restatement; `amount` is a major unit |
| `infrawrench_cost_export`        | by id     | Credentials are write-only and never imported    |

| Data source                | Purpose                                     |
| -------------------------- | ------------------------------------------- |
| `infrawrench_accounts`     | Resolve account ids for rule matches        |
| `infrawrench_plugins`      | Resolve valid plugin ids                    |
| `infrawrench_cost_centres` | Reference centres created outside Terraform |

## Testing

```sh
go test ./...                 # unit tests: schema validity, state mapping, wire drift
TF_ACC=1 go test ./... -v     # adds acceptance tests, which need a live org
```

Acceptance tests create and destroy real objects and are skipped unless `TF_ACC`
is set **and** `INFRAWRENCH_API_KEY` and `INFRAWRENCH_ORG_ID` are present. Point
them at a scratch organization, never a production one.

## Repository notes

- This module is **not** in the pnpm workspace or `turbo.json`. It is a Go
  module with its own toolchain and its own test command.
- It is **not** added to `cliff.toml`'s `include_paths`. That list scopes the
  desktop changelog to the desktop app and the workspace packages it
  transitively depends on; a standalone Go module is outside that closure, and
  adding it would put provider commits into the desktop app's changelog.
