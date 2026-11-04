---
title: Config as code
description: Export your organization's dashboards, workflows, budgets, graphs, alert rules and policies as one JSON document, keep it in git, and apply it back.
---

You can export everything you've set up in Infrawrench (apart from provider accounts and live resources) as one JSON document. Commit it to git, review changes like any other code, and apply it back. Apply it to the same organization to recover from a mistake, or to a different one to set up a staging environment, a demo or a new client's workspace.

![The Config as Code settings page, with the export section's checkboxes and the import panel showing a plan](https://agent-assets.infrawrench.com/docs-screenshots/features/config-as-code/export-and-plan.png)

## What's in the document

| Section         | What it carries                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `budgets`       | Monthly spend budgets, their filters and alert thresholds                                                                                 |
| `customGraphs`  | Each [custom graph](./custom-graphs.md)'s name, description and source                                                                    |
| `workflows`     | Each [workflow](./workflows.md)'s source, trigger, declared metrics, enabled                                                              |
| `dashboards`    | Every [dashboard](./dashboard.md), its name, its cards in grid order, and the roles defaulting to it                                      |
| `metricAlerts`  | [Metric alert rules](./metric-alerts.md): selector, condition, cooldown                                                                   |
| `probes`        | [Synthetic probes](./synthetic-probes.md): URL, interval, failure threshold                                                               |
| `slos`          | [SLOs](./slos.md): source (probe key or resource), target, window, alerting                                                               |
| `costCentres`   | Cost centres and their [allocation rules](./tag-policy-and-showback.md)                                                                   |
| `tagPolicy`     | The org's required tags and whether they're enforced at create time                                                                       |
| `alertSettings` | Cost anomaly tuning, drift/expiry/posture/extended-support alerting, the idle resource rules (`idleFindings`), the weekly digest schedule |
| `savingsViews`  | [Saved views](./savings-findings.md#saved-views) over the savings findings list, accounts by name                                         |

## What's not in it

- **Accounts and credentials.** An export can never be used to take an organization's provider keys. Connect accounts in the target organization first.
- **Resources.** These belong to your provider. A dashboard card pinned to a resource is saved by provider, type, external id and account _name_. If the target organization has synced the same resource, the card works. If not, that card is skipped and reported.
- **Workflow webhook signing secrets.** These are never returned, so a document can't leak or set one. After importing a git-triggered workflow, set its secret again.
- **History and alert state.** Firing history, run logs, cooldowns and change freezes aren't included, so a restore won't page people twice.

### Role default dashboards

A dashboard's `defaultForRoles` lists the roles whose members [land on it](./dashboard.md#default-dashboards), by role name (not case sensitive). Roles aren't in the document, so those names must exist in the target organization. A role that doesn't exist, can't view dashboards or can't see this dashboard is skipped and reported. Leave the field out to keep role defaults as they are, or set `[]` to clear every role defaulting to that dashboard. Each role can only be named by one dashboard.

```json
{ "key": "spend-overview", "name": "Spend overview", "defaultForRoles": ["Finance"], "cards": [] }
```

## How items are matched

Every item in the document has a **key**, a slug made from its name like `monthly-cloud-spend`. Keys are what let one document apply to any organization, and an import matches on them:

- A key the target doesn't have is **created**.
- A key it already has is **updated**, even if the name changed. Renaming an item but keeping its key is a rename, not a delete and recreate.
- A key the document doesn't mention is left alone, unless you use replace mode.

References between items use keys too. A budget card or [KPI card](./dashboard.md#kpi-cards) on a dashboard names the budget's key, and so does a workflow with a budget trigger.

## Export your config

**In the app:** go to **Settings > Config as Code > Download infrawrench.json** and tick the sections you want.

**From the [CLI](./cli.md):**

```bash
infrawrench config export --out infrawrench.json
infrawrench config export --sections budgets,workflows --out spend.json
infrawrench config export | jq .            # no --out: straight to stdout
```

Exports are stable. The same organization exports exactly the same file until something actually changes, so `git diff` shows real configuration changes, not noise.

## Import a document

Importing is always two steps: **plan**, then **apply**. The plan checks the document, matches it against the target organization and lists exactly what would be created, updated and deleted, without changing anything.

```bash
infrawrench config plan  -f infrawrench.json      # dry run, safe on any org
infrawrench config apply -f infrawrench.json      # shows the plan, then asks
```

In the app, go to **Settings > Config as Code > Import**. Paste or choose a file and click **Preview changes**. The apply button only appears after you've seen the list.

The whole document applies at once. If any part fails, nothing changes, so your organization is never left half updated.

### Merge or replace

By default an import **merges**. It creates and updates what the document names and leaves everything else alone, so it's safe on a live organization.

`--prune` (the **Delete anything the document doesn't name** checkbox) switches to **replace**. Items the document doesn't name are deleted too, but only in the sections the document includes. A document with only a `budgets` section can never touch your workflows, in either mode. The default dashboard is never deleted.

```bash
# Make staging an exact copy of production's dashboards and budgets
infrawrench config export --sections dashboards,budgets --out prod.json --org production
infrawrench config apply -f prod.json --prune --org staging
```

### Run it in CI

`config plan` changes nothing and only needs read access, so it works well as a pull request check:

```yaml
- run: infrawrench config plan -f infrawrench.json
```

`config apply` won't run without confirmation in a non-interactive terminal. Once the plan has been reviewed, pass `-y`:

```yaml
- run: infrawrench config apply -f infrawrench.json -y
```

## When something can't be applied

One broken reference won't block the rest of your import. Anything the target organization can't support is listed under **Not applied** (or in the plan's `unresolved` list) and skipped, and everything else still applies:

- A card pinned to a resource nobody has synced yet. Sync the account and apply again.
- An account name the target organization hasn't connected (on a resource pin, an allocation rule or the drift alert scope).
- A workflow whose budget trigger names a budget the document doesn't define. The workflow is imported with a manual trigger instead.

Two things fail the import instead of being skipped:

- A drift alert scope that matches no accounts at all. An empty scope means _every_ account, so dropping unknown names would widen your alerts.
- A probe or widget with settings the normal editor would also reject.

## Manage single objects with Terraform

A document moves a whole organization at once. That's ideal for cloning, setting up staging or restoring. It's not a good fit when one budget lives in the platform team's repo and changes go through review, because the document applies everything together and `--prune` deletes anything it doesn't name.

For that, use the [Terraform provider](./terraform-provider.md). It manages individual Infrawrench objects (budgets, cost centres, allocation rules, tag policy, saved filters, reports, cost alerts, scenario models, billing rules and exports) as Terraform resources, with per-object plans, drift detection and `terraform import`. It also covers objects this document doesn't.

You can use both: set up an organization with a document, then move the pieces you want under ongoing review into Terraform.

## Permissions

Exporting needs `config:read`. Importing needs `config:write`. Owners and admins have both.

You also need the permission for each section involved, so `config:write` can't get around a role that doesn't have `workflows:write`. If you can't read a section, the export fails instead of leaving it out. A partial document would look complete, and applying it with `--prune` would delete what you couldn't see.

Every export and apply is recorded in the [audit log](../team-and-billing/audit-log.md).
