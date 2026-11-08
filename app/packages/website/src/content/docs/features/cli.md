---
title: Command-line interface
description: Run Infrawrench from any terminal with an interactive TUI dashboard, plus scriptable JSON and text output that uses the desktop app's accounts and cloud session.
sidebar_order: 13
---

> **Desktop app required.** The `infrawrench` command runs through the desktop app, so it sees the same data: your local accounts, your cloud session, and every organization you belong to.

You can use the CLI in three ways:

- **TUI mode.** Run `infrawrench` with no arguments for a full-screen interactive dashboard. Switch between Local and your organizations, browse accounts and resources, open a resource to see its fields and live metric charts, and pull up 30-day cost graphs.
- **Text mode.** Human-readable tables and terminal charts. This is the default for every subcommand.
- **JSON mode.** Pass `--json` to any command for stable output you can script against (with `jq`, for example).

`infrawrench help` lists every command. Most of the listing commands also have their own help, so `infrawrench orgs --help` prints just that command's usage and flags: `access`, `accounts`, `agents`, `blast-radius`, `cli`, `commitments`, `cost-visibility`, `credits`, `declared-incidents`, `dns`, `estimate`, `expiring`, `extended-support`, `github-issues`, `idle-rules`, `incidents`, `issues`, `leases`, `login`, `logout`, `orgs`, `orphans`, `oversized`, `ownership`, `probes`, `resource`, `resources`, `schedules`, `slos`, `status-pages`, `webhooks` and `whoami`. More commands get this as they are updated. Those commands are also strict about what they're given. A flag they don't take, an extra argument or an unknown subcommand (`access frobnicate`, `issues trello`) prints their help and the error to stderr and exits with status 2. Before, the extra input was ignored, or the command printed a one-line error and exited with status 1. Their own flags go after the command name: `infrawrench resources --type droplet -a prod`, not `infrawrench --type droplet resources`.

## Install the shell command

In the desktop app, click **Install shell command** at the bottom of the sidebar. On macOS and Linux this adds an `infrawrench` launcher to `/usr/local/bin` (or `~/.local/bin` if that isn't writable). On Windows it goes in a per-user `bin` directory that is added to your `PATH`.

<insert [Desktop app sidebar footer showing the "Install shell command" button below "Add account", with the success toast visible after clicking] here>

After that, you can manage the launcher from the CLI itself:

```
infrawrench cli status
infrawrench cli install
infrawrench cli uninstall
```

After you update the app, `infrawrench cli status` warns you if the launcher points at an older build. Run `infrawrench cli install` again to refresh it.

## Sign in and pick an organization

The CLI uses the desktop app's session. If you're already signed in to the app, there's nothing to do: `infrawrench whoami` shows your account. You can also sign in from the CLI:

```
infrawrench login     # opens your browser (PKCE), then returns to the terminal
infrawrench whoami
infrawrench logout
```

Organizations work like the app's org switcher: your local workspace plus every cloud organization.

```
infrawrench orgs                     # list your organizations
infrawrench accounts                 # accounts everywhere: Local + each org
infrawrench accounts --local         # just the local workspace
infrawrench accounts --org acme      # one org (id, name, or unique prefix)
```

While the desktop app is open, `login` and `logout` ask you to use the app instead. Close the app and the CLI can do both.

## Browse resources

```
infrawrench resources -a "Production GCP"           # all resources of an account
infrawrench resources -a prod --type gce-instance   # filter by resource type
infrawrench resource <resource-id>                  # fields + outputs of one resource
```

You can refer to an account by its id, its exact name, or a unique name prefix. If the same name exists both locally and in an org, add `--local` or `--org` to pick one.

Local accounts are listed live from the provider, just like the desktop sidebar, so what you see is what the provider says right now. A listing is only as fast as the provider's API. If your credentials can't reach a resource type, the CLI tells you on stderr instead of quietly leaving it out:

```
volume: 403 Forbidden: token is missing the "block_storage:read" scope
```

The rest of the account still lists. Org accounts are refreshed from the provider first, so they're current too. If the refresh fails (a provider outage, a rate limit or [a list too long to read whole](../core-concepts/resources-and-accounts.md#when-a-list-cant-be-read-whole)), the CLI prints the last copy it has and says so on stderr. The TUI works the same way: when you open an account you see the last copy straight away, and it updates in place when the refresh finishes.

## Search and starred items

`search` is the [command palette](./spotlight-search.md) in your terminal. It covers everything you can open in the org, not only resources: workflows, cost reports, dashboards, budgets, SLOs, services, runbooks and more. Best matches come first, each with the web address that opens it.

```
infrawrench search checkout                    # every kind you can read
infrawrench search spend --kind cost_report,dashboard
infrawrench search db --json                   # kind, id, name and url per hit
infrawrench starred                            # your starred items in this org
infrawrench starred add cost_report <id>       # kind and id as search --json prints them
infrawrench starred remove cost_report <id>
```

Both are cloud only. You only see what you'd see in the palette: a report that isn't shared with you, or a budget outside your cost visibility, never shows up.

## Export to Terraform

```
infrawrench export -a "Production Hetzner" > main.tf     # HCL on stdout
infrawrench export -a prod --format terraform --json     # structured result
```

This gives you the same Terraform configuration as the web app's **Export to Terraform** action: a provider block, `var.*` variables for secrets, and one resource block per supported resource with its `terraform import` hint. Resources that aren't supported yet are listed on stderr (or in the `unsupported` array with `--json`), so redirected stdout stays pure HCL. See [Terraform export](./terraform-export.md) for supported providers and how to adopt the result.

## View metrics and costs

The CLI draws metric series as terminal charts:

```
infrawrench metrics <resource-id> --last 6h
infrawrench metrics <resource-id> --series cpu --last 24h
infrawrench metrics <resource-id> --local        # a local resource, live from the provider
```

Cloud resources [pinned to a dashboard](./dashboard.md#historical-metrics) keep history, so you can ask for long ranges. Unpinned ones are fetched live from the provider, so you still get a chart, limited to whatever window the provider offers. Local resources are always fetched live.

<insert [Terminal showing `infrawrench metrics` output with two colored area charts (CPU and memory series) including y-axis labels and a time axis] here>

Cost graphs use the same data as the dashboard cost widgets:

```
infrawrench costs                        # last 30 days, grouped by provider
infrawrench costs --last 90d --group-by service
infrawrench costs --group-by account --json
infrawrench costs --group-by tag:team    # one tag's values, e.g. a Kubernetes namespace or gpu_model
infrawrench costs --last 12m --bin quarter --cumulative          # running quarterly totals
infrawrench costs --measure count --group-by service              # how many services were billed each day
infrawrench costs --measure usage --unit Hrs --group-by service   # summed usage quantity in one unit
infrawrench costs --x-axis service --compare                     # one bar per service, with the change since last period
infrawrench costs --group-by virtual_tag:team      # a virtual tag key; virtual_tag['team'] works too
infrawrench costs --group-by tag:env     # any tag; Kubernetes labels: k8s_node_label:team, k8s_pvc_label:<key>
infrawrench costs tag-keys               # the tag keys in your cost data, with the --group-by value for each
infrawrench costs forecast "Platform spend" --all   # a report's forecasts with low/expected/high ranges
infrawrench costs forecasts "Platform spend"        # a report's named forecasts
```

Options you'll use most:

- `--measure` picks what is summed. `cost` is the default (money). `usage` sums the usage quantity providers report, in the unit `--unit` names; leave out `--unit` and the command lists the units your cost data has. `count` counts how many distinct `--group-by` values had nonzero cost per bin, and the headline total counts each value once over the whole range.
- `--bin day|week|month|quarter` sets the bin. `--bin hour` is refused, with the reason, because every provider reports daily rows.
- `--cumulative` draws running totals.
- `--json` echoes `measure`, `usageUnit`, `binning` and `cumulative` next to the response. The response's `measure` field tells you when the amounts aren't money.

See [display options](./cloud-costs.md#display-options).

<insert [Terminal showing `infrawrench costs` output with the daily sparkline and per-provider horizontal bar chart] here>

If an account's daily cost collection is failing, it's called out above the chart with the provider link that fixes it. `--json` lists these as `collectionFailures`. Accounts that collected fine but have no spend yet are listed the same way, as `awaitingData`. See [when collection fails](./cloud-costs.md#when-collection-fails) and [when there is nothing to collect yet](./cloud-costs.md#when-there-is-nothing-to-collect-yet).

### Spend anomalies

`--anomalies` turns `costs` into the [spend anomaly](./cost-anomaly-alerts.md) list: the days a provider or service went above its own recent baseline, with the actual spend, the baseline, and the percentage change. Rows marked `[new source]` are providers or services that had no spend in the window and then billed a real amount. They show `none` for the baseline and `new` for the change.

```
infrawrench costs --anomalies
infrawrench costs --anomalies --days 7      # 1-90; --last 2w says the same thing
infrawrench costs --anomalies feedback <id> --expected|--unexpected [--reason r] [--note text] [--recurrence weekly]
infrawrench costs --anomalies suppressions | precision | sensitivity
```

### Cost reports

`reports` lists the org's saved [cost reports](./cost-reports.md), with each one's shape and how many dashboards show it. Run one by name to chart it without retyping any filters:

```
infrawrench reports
infrawrench reports "Monthly spend"
infrawrench reports "Monthly spend" --json
infrawrench reports "Monthly spend" --format pdf --out monthly.pdf
```

The CLI tries an exact name match first, then a substring. If your query matches more than one report, it lists them instead of guessing. An id works anywhere a name does.

`reports move` and `reports delete` move or remove many reports and folders at once, all or nothing, just like [selecting several on the Reports page](./cost-reports.md#moving-and-deleting-many-at-once). Each argument is one item. Quote names with spaces and prefix folders with `folder:`. `delete` asks before it runs unless you pass `-y`:

```
infrawrench reports move "Monthly spend" folder:"Finance / Old" --folder Archive
infrawrench reports delete "Old draft" -y --json
```

`reports anomalies` lists the reports that have their own [anomaly alert](./cost-reports.md#anomaly-alerts-for-a-report): on or off, sensitivity, minimum rise, where it sends, and its latest findings with whether each was sent. Name a report to see just its alert. This is read-only (you set alerts up on the report page or with Terraform), and `--json` includes everything:

```
infrawrench reports anomalies
infrawrench reports anomalies "Platform" --json
```

`--format pdf` downloads the [PDF](./dashboard-pdf.md) instead of drawing a chart. It saves to `--out <path>` (or `--file`), or to a file named after the report in the current directory.

<insert [Terminal showing `infrawrench reports` listing three saved reports, then `infrawrench reports "Monthly spend"` with its sparkline and per-service bar chart] here>

### Resource reports

`resource-reports` lists the org's saved [resource reports](./resource-reports.md): inventory tables of resources with per-resource cost. Run one by name to print a page of its rows with every column it shows, including tags, metadata and cost.

- `--limit` sets the page size (up to 500) and `--offset` moves to the next page.
- `--sort <column>`, with optional `--desc`, overrides the saved sort for this run. Use column ids such as `core:name`, `tag:team` or `cost:mtd`.
- `--format csv` writes every row (up to 50,000) to `--out <path>` or stdout.
- `--json` prints the rows with their columns and cost windows.

```bash
infrawrench resource-reports
infrawrench resource-reports "Production compute" --limit 100 --sort cost:mtd --desc
infrawrench resource-reports "Production compute" --format csv --out prod.csv
infrawrench resource-reports "Production compute" --json
```

### Budgets

`budgets` lists the org's budgets with month-to-date spend, forecast, and how many of this month's alerts nobody has explained yet. `budgets <name|id>` shows one budget's alert history with the note on each alert. `budgets annotate` [explains a fired alert](./cloud-costs.md#explaining-a-budget-alert) (the latest one, unless `--event <id>` names another). Your note is posted as a reply in the alert's Slack threads and shown on the cost charts:

```
infrawrench budgets
infrawrench budgets "Prod" --json
infrawrench budgets annotate "Prod" --note "Q3 load test, ends Friday"
```

The list shows every budget as the same tree the Costs panel draws: each level's period-to-date actual and forecast against its own limit (in money, or in a usage budget's unit), the period being measured, fired alerts, and any children that outgrow their parent. `--json` returns the full rows.

### Dashboards

`dashboards` lists your dashboards with their delivery schedules and the one you [land on](./dashboard.md#default-dashboards) (yours, your role's or the organization's; `--json` includes it as `default`). It also takes `--format pdf`:

```
infrawrench dashboards
infrawrench dashboards "Platform"          # its KPI cards' figures and change, then its schedules
infrawrench dashboards "Platform" --format pdf
infrawrench dashboards send "Platform"     # deliver it to its schedules right now, PDF attached
```

Name a dashboard to see each of its [KPI cards](./dashboard.md#kpi-cards) as it appears on screen: the figure, the change against the previous period (green when that's good news, red when it isn't) and the window it covers. `--output json` includes the same readings under `kpis`. A card that couldn't be answered has an `error` instead.

### Canvases

`canvas` reads the org's [canvases](./ai-canvas.md), the reports the AI assistant builds from a description. `canvas show` prints a canvas's blocks. `canvas refresh` re-runs every query (without calling the AI model) and prints each KPI, table, chart total, budget and anomaly. `--json` gives the full result, and `--format pdf` saves the canvas as a PDF:

```
infrawrench canvas list
infrawrench canvas show "AI spend by team"
infrawrench canvas refresh "AI spend by team" --json
infrawrench canvas refresh "AI spend by team" --format pdf --out ai-spend.pdf
```

<insert [Terminal showing `infrawrench canvas refresh "AI spend by team"` with KPI lines, a monthly table by team, and a chart total with its sparkline] here>

### Scheduled cost exports

`exports` lists the org's [scheduled cost exports](./cost-exports.md): each one's format, schedule, destination, and how its last run went, with any failure printed in full below the table. It's the quick way to catch a nightly export that quietly stopped working:

```
infrawrench exports
infrawrench exports run "Finance warehouse"
infrawrench exports --json
infrawrench exports warehouses
infrawrench exports create --name "Finance warehouse" --plugin snowflake -a "Prod Snowflake" \
  --target database=ANALYTICS --target schema=FINOPS --target table=COSTS
infrawrench exports setup "Finance warehouse"
```

- `exports warehouses` lists the Snowflake and Databricks table destinations, your connected accounts for each, and the `--target` keys they take.
- `exports create` makes a [table export](./cost-exports.md#destination-snowflake-or-databricks-table) from them. Optional flags: `--cadence`, `--hour`, `--timezone`, `--restatement-days` and `--dimensions`.
- `exports setup <name|id>` prints the least-privilege GRANT statements the export needs.

All three take `--json`.

`exports run` starts a run now and lists the objects it wrote. It exits non-zero if the destination rejected it, so a CI step can depend on it.

<insert [Terminal showing `infrawrench exports` with a table of three exports, one row red with "failed", and its full error message printed below the table] here>

### One-off cost downloads

`export --format focus` downloads cost rows once as a [FOCUS 1.4](./cost-exports.md#focus) CSV (or 1.3 with `--focus-version 1.3`). It takes the same range and filter flags as `costs`. Name a saved report to start from its range and filters; range flags then override its range, and `--where` narrows it further:

```
infrawrench export --format focus --last 30d > focus.csv
infrawrench export --format focus "Monthly AWS" --out aws-focus.csv
infrawrench export --format focus --from 2026-07-01 --to 2026-09-30 --where "provider = 'aws'" --charge-type usage
infrawrench export --format focus --last 7d --json      # { request, rowCount, csv }
```

Only the CSV goes to stdout, so a redirect gives you a clean file. The row count goes to stderr.

For bigger exports, add `--async` to run the export as a [background job](./cost-reports.md#large-exports-in-the-background) on the server. `csv` and `ndjson` write the native columns (a report's group-by as row identity, plus its per-day unit cost when it has one), and `focus` writes FOCUS. Without `--wait`, the command prints the job and returns. With `--wait`, it shows progress on stderr and writes the file when it's ready. Without a report, `--dimensions service,account` sets the row identity of a native file:

```
infrawrench export --async --format csv "Monthly spend" --wait --out monthly.csv
infrawrench export --async --format focus --last 365d --wait > focus-year.csv
infrawrench export --async --format ndjson --last 90d --dimensions service,region --where "provider = 'aws'"
infrawrench export jobs                       # your recent background exports
infrawrench export jobs 3f2a91c0 --wait --out monthly.csv   # wait for one (an id prefix works) and download it
infrawrench export jobs 3f2a91c0 cancel
```

All of them take `--json`. Finished files are kept for 24 hours.

## Check schedules, probes, SLOs and services

`schedules` lists the org's [sleep/wake schedules](./sleep-schedules.md): each window, its timezone, the next change, how the last run went (including freeze skips and failures), and the projected monthly saving:

```
infrawrench schedules
infrawrench schedules --json
```

`probes` lists the org's [synthetic probes](./synthetic-probes.md): each endpoint's live status, check interval, uptime over the last 24 hours and last latency, checked from outside your infrastructure. Give it a probe's id or name for its details plus a 24-hour latency sparkline. Cloud only and read-only: you create probes from the Probes tab on web or desktop.

```
infrawrench probes
infrawrench probes api-health     # one probe: state, facts, latency sparkline
infrawrench probes --json
```

`slos` lists the org's [SLOs](./slos.md), worst first: status, SLI against target, window, error budget left (as a share and as time), 1-hour burn rate and what each one measures. Give it an SLO's id or name for burn rates per window, the page and ticket thresholds, and sparklines of the daily SLI and budget burndown. Cloud only and read-only: you write SLOs from the SLOs tab on web or desktop.

```
infrawrench slos
infrawrench slos checkout         # one SLO: budget, burn rates, burndown sparkline
infrawrench slos --json
```

`services` lists the org's [services](./services.md), the named sets of resources that make up one system across providers. You see each one's tier, owning team or members, member count, and its level on every scorecard that applies. `--tier 1` keeps one criticality tier.

`services show` takes a service's id, slug or name (a unique part of the name works too) and prints a summary:

- owners and links, and who is on call now and next
- the last 30 days of member cost per currency (shown as "unavailable" if cost data couldn't be read, never as zero)
- linked SLOs and runbooks
- posture, orphan and backup findings (naming any that couldn't be loaded)
- members and where each came from, and recent changes
- each scorecard's score, with the reason for every failing check

Its `--json` is `{ org, service, members, excluded, summary, scorecards, history }`. Cloud only and read-only: you edit services from the Services tab.

```
infrawrench services
infrawrench services --tier 1
infrawrench services show checkout-api   # owners, on-call, cost, SLOs, findings, members, changes
infrawrench services show "Checkout API" --json
```

`scorecards` starts with the [org grade](./services.md#org-grade): the overall grade and score, the change since the oldest stored reading, a 90-day sparkline on the full 0 to 100 range, the biggest drag, and one row per pillar with its weight, score (or `n/a` and why) and reading. If the grade can't be read, the rest still prints.

Then comes the [scorecard](./services.md#scorecards) matrix: one row per service, one column per scorecard. Each cell shows the score and level reached: green at the top level, yellow in between, red below the lowest. A service a scorecard doesn't apply to (by tier) shows `n/a`, and one where no check applied shows "not scored", never 0%.

Give it a scorecard's id or name for its definition (checks with their weights and parameters, levels, tiers, and whether a level drop alerts) and every service's score on it, best first, with a 90-day trend sparkline and the checks it fails. The matrix `--json` is `{ org, orgGrade, scorecards, services, results }`, with `orgGrade` null if it couldn't be read.

```
infrawrench scorecards
infrawrench scorecards "production readiness"
infrawrench scorecards --json
```

`dora` is [Delivery (DORA metrics)](./dora-metrics.md): deployment frequency, lead time for changes, change failure rate and time to restore for production. Each comes with its performance band, the previous period and a sparkline trend, then a breakdown by environment (or `--group-by repository|owner|service`).

- `--scope <dimension>=<value>` narrows to one environment, repository, owner or service (by service id). `--scope owner` on its own shows deploys with no owner recorded.
- `dora changes` lists the production changes behind the numbers. Add `--failed` for the failed ones and what they were blamed on.
- `dora restores` lists the recoveries, and `dora settings` shows what counts as production.

Cloud only. Needs `deployments:read`.

```
infrawrench dora
infrawrench dora --last 90d --group-by repository
infrawrench dora --scope environment=production --json
infrawrench dora changes --failed
infrawrench dora restores
```

## Track credits, savings and waste

`credits` is the [credit burndown](./credit-burndown.md): prepaid balances with a measured burn rate and a runway, for providers that report one. It's a good one for a morning check, since a prepaid balance that runs out means an outage, not an invoice. Needs `costs:read`:

```
infrawrench credits
infrawrench credits --json
```

`savings` is [realized savings](./realized-savings.md): what resizes, orphan cleanups, sleep schedules, commitments and logged actions actually saved compared with each resource's spend before the action, next to the projection. It includes a breakdown (`--group-by month|kind|cost-centre|account`) and lists every action. `savings log` records a saving Infrawrench couldn't see happen (needs `costs:write`). Needs `costs:read`:

```
infrawrench savings
infrawrench savings --group-by cost-centre --from 2026-01-01 --json
infrawrench savings log "Cancelled the legacy CDN" --amount 420 --currency USD --from 2026-09-01
```

`savings findings` is the [savings findings](./savings-findings.md) list: every finding with its status, detected date, and a summary (potential, realized, savings rate, counts by status). It opens on open findings. Filter with `--status`, `--kind`, `--provider`, `-a/--account`, `--region`, `--tag key[=value]`, `--min-savings`, `--from`/`--to` (detected date) or `--search`, or open a saved view with `--view <name>`. `savings findings set <key>... --status <status> [--note]` changes findings' status (needs `resources:write`), and `savings views` lists saved views. Needs `resources:read`:

```
infrawrench savings findings
infrawrench savings findings --status all --kind orphan,oversized --min-savings 50 --json
infrawrench savings findings set orphan:4f6c0a52-... --status archived --note "Kept for the DR drill"
infrawrench savings views
```

`idle-rules` lists the [idle resource](./idle-resources.md) rules for your providers, with the organization's thresholds and lookback window, and each account's last metrics read and any error. `idle-rules rescan` queues a fresh read for every account. The idle findings themselves show up in `orphans`, which adds an **Idle evidence** section naming each metric, its value over the window and the threshold. Cloud only; both take `--json`:

```
infrawrench idle-rules
infrawrench idle-rules rescan
```

`oversized` lists [right-sizing recommendations](./right-sizing.md): machines whose 14-day p95 CPU and memory sit well below their size, with the recommended smaller size and the monthly saving at current prices. Cloud only and read-only. To apply a resize, use the Costs panel on web or desktop, or run the [remediation commands](./remediation-commands.md) printed under the table. `orphans` and `schedules` print theirs the same way, and `--json` includes them as `remediation` on every row:

```
infrawrench oversized
infrawrench oversized --json
```

`oversized` and `estimate` both show carbon too: a `co2e/mo` column, and a carbon line under the price.

`seats` lists [SaaS seat findings](./saas-seats.md): paid seats that are inactive, duplicated across tools, or on a pricier tier, with the monthly saving and remediation commands. `seats all` lists every seat with its last activity and how that was worked out. `seats remove <id>` removes a flagged seat through its provider (it asks first unless you pass `-y`), and `seats refresh` collects again now. Cloud only:

```sh
infrawrench seats
infrawrench seats all --json
infrawrench seats remove 7c0e1f52-... -y
```

`extended-support` lists [extended support findings](./extended-support.md): clusters and databases on versions billed at extended-support or end-of-life rates, with the monthly surcharge an upgrade removes (from your billing data where the provider names it, list price otherwise). `--local` checks the desktop workspace on your machine, at list price:

```
infrawrench extended-support
infrawrench extended-support --local
infrawrench extended-support --json
```

## Look up prices, estimates and carbon

`prices` searches the [price catalog](./price-catalog.md): providers' published list prices, filtered by provider, specs, GPU and price, cheapest first. `prices compare` finds the cheapest instance per provider that meets a vCPU, memory or GPU target, or that matches a product you name. Cloud only; both take `--json`:

```
infrawrench prices search --min-vcpus 4 --min-memory 16 --area europe
infrawrench prices search --gpu required --gpu-model H100 --rate spot
infrawrench prices compare --vcpus 8 --memory 32
infrawrench prices compare m7i.xlarge --provider aws --json
```

`estimate` prints one resource's [monthly cost estimate](./cost-estimates.md) at the provider's list price, itemized. It's the same figure the create form and the resource page show. Cloud only. This is a projection, not a bill: `costs` shows what you were actually charged, while `estimate` shows the run rate the resource's current setup implies. Pass the full resource id, or a display name or external id with `--account`:

```
infrawrench estimate acc-123:ec2-instance:i-0abc
infrawrench estimate my-api-box --account production
infrawrench estimate acc-123:ec2-instance:i-0abc --json
```

`carbon` prints the organization's [estimated carbon](./carbon.md) by provider, region and resource, with how many resources couldn't be estimated next to the total, and the assumptions underneath. Cloud only:

```
infrawrench carbon
infrawrench carbon --days 90
infrawrench carbon --json
```

## Kubernetes and network costs

`k8s-efficiency` lists your saved [Kubernetes efficiency reports](./kubernetes-efficiency.md). Name one to run it: totals, efficiency, the split by cost category, and a row per group with used, requested but unused, unmeasured, idle and overhead cost.

- `--group-by` runs an unsaved report over every cluster you can see (`cluster`, `namespace`, `workload`, `node_pool`, `category`, or a label key such as `k8s_pod_label:team`), with `--basis total|allocated`.
- `--format csv|ndjson` writes a saved report's per-period export to `--out` or stdout.

Cloud only.

```
infrawrench k8s-efficiency
infrawrench k8s-efficiency "Payments efficiency" --json
infrawrench k8s-efficiency --group-by namespace --last 30d
infrawrench k8s-efficiency "Payments efficiency" --format csv --out efficiency.csv
```

`k8s-network` prints one Kubernetes cluster's [network costs](./kubernetes-costs.md#network-costs): bytes and money by traffic class, namespace and workload, the top talkers, and billed data transfer split across them when a billed source is set. With one cluster you don't need an argument; with several, name one. Cloud only.

```
infrawrench k8s-network
infrawrench k8s-network prod-cluster --last 30d --json
```

`network-reports` lists your saved [network flow reports](./network-flow-reports.md), or runs one by name or id: estimated cost and bytes over the window, group totals and the top talking pairs. Figures from a sampling flow source are marked as sampled. `--format csv` writes the series CSV and `--format pairs-csv` the top talkers CSV (add `--out` to write a file). Cloud only.

```
infrawrench network-reports
infrawrench network-reports "Cross-zone traffic by pair" --json
infrawrench network-reports "Cross-zone traffic by pair" --format pairs-csv --out pairs.csv
```

## Tags, allocation and AI spend

`tags` and `showback` are the [tag governance](./tag-policy-and-showback.md) reports. `tags` shows the org's required tags with per-account compliance scores and the spend missing a required key. `showback` shows spend grouped by cost centre using the org's allocation rules:

```
infrawrench tags                  # policy, compliance table, untagged spend
infrawrench tags --last 90d --json
infrawrench showback              # spend by cost centre; unmatched spend is "unallocated"
```

`ai-spend` is [AI spend by caller](./ai-attribution.md): billed versus attributed AI spend per provider, each request log source's match rate, and spend split by a caller dimension (the first one mapped, or the one you name):

```
infrawrench ai-spend              # coverage, match rates, spend by the first dimension
infrawrench ai-spend feature --last 90d
infrawrench ai-spend sources      # request-log sources and their collection state
infrawrench ai-spend team --json
```

<insert [Terminal showing `infrawrench tags` output with the compliance table (green/yellow/red score column) and the untagged-spend bar chart below] here>

`tag-keys` lists every tag key in your organization's cost data and resources, with the providers that use it, how much, and whether your [tag key settings](./tag-keys.md) hide it from pickers or pin it to the top. Four commands edit those settings. Quote a prefix pattern so your shell leaves the `*` alone:

```
infrawrench tag-keys                              # every key, busiest first
infrawrench tag-keys --json
infrawrench tag-keys hide 'aws:cloudformation:*'  # or an exact key
infrawrench tag-keys unhide 'aws:cloudformation:*'
infrawrench tag-keys pin team                     # appended to the preferred order
infrawrench tag-keys unpin team
```

Hiding a key only changes what pickers offer. You can still query its data. Editing needs `org:settings:write`.

Virtual tags are keys your organization computes from ordered rules, like one `team` or `env` across every provider. You can list, inspect and reprocess them:

```
infrawrench virtual-tags                   # every tag: key, rule count, status, unmatched share
infrawrench virtual-tags show team         # rules in order, the spend each claims, top values
infrawrench virtual-tags reprocess team    # re-run the evaluation over stored history now
infrawrench virtual-tags show team --json
```

Refer to a tag by its key, id or name. The unmatched share is the part of the spend no rule matched: it got the tag's default value, or is "not set". Use the key anywhere a cost filter or grouping is accepted: `--where "virtual_tag['team'] = 'platform'"` and `--group-by virtual_tag:team`. You edit rules in Settings, where you can preview a change before it applies to past reports. See [Virtual tags](./virtual-tags.md).

## Billing rules, currencies and invoices

`billing-rules` shows your organization's own adjustments to collected spend. It's the answer to "why doesn't this total match the invoice":

```
infrawrench billing-rules                 # every rule, in the order it evaluates
infrawrench billing-rules "Platform overhead"
infrawrench billing-rules --json
infrawrench billing-rules preview "Volume tiers" --customer northwind --month 2026-09
```

This is read-only. Changing a rule needs `org:settings:write` and is recorded in the audit log. `preview` is a dry run of one saved rule against a month of real spend (last month by default). It shows the totals with and without the rule and the lines it changed. `--customer` prices one managed account's invoice scope. See [Billing rules](./billing-rules.md).

`currency` shows the exchange rates behind any converted figure:

```
infrawrench currency                      # display currency, automatic rates, ECB feed state, stated rates
infrawrench currency rate EUR 2026-09-30  # which rate that day converts at, its source and date, and why
infrawrench currency rate GBP USD         # any pair, today
infrawrench currency feed --currency USD  # every ECB reference rate for today, in USD
infrawrench currency template > rates.csv # the CSV an upload reads, with one example per row shape
infrawrench currency import rates.csv     # preview every row, then ask before writing
```

`currency rate` follows your organization's order: a rate you stated for that day wins, then the automatic ECB rate if automatic rates are on (carried over weekends and holidays, converted through EUR). All of them take `--json`.

You set single rates in Settings. `currency import` is the only command here that writes. It always shows a preview first, marking each row as new, replacing a stored rate, unchanged, or an error with its line. Then it asks before writing:

- `-y` skips the question. You need it in a non-interactive shell, which otherwise stops at the preview.
- A file with errors writes nothing unless you pass `--skip-invalid`.

See [Uploading many rates from a CSV](./cloud-costs.md#uploading-many-rates-from-a-csv).

If you bill customers for infrastructure you run for them, `invoices` shows the invoices themselves:

```
infrawrench invoices                      # every invoice, newest period first
infrawrench invoices customers            # the managed accounts and their scope
infrawrench invoices INV-2026-0004        # one invoice, with its full derivation
infrawrench invoices northwind --json     # by customer name
infrawrench invoices profiles             # billing profiles: addressee, tax, terms, numbering
infrawrench invoices profiles "EU"        # one profile in full (account numbers masked; --json has them)
infrawrench invoices unassigned           # last month's spend no customer is billed for
infrawrench invoices unassigned --from 2026-01-01 --to 2026-03-31
```

The detail view shows the whole chain: what was collected, what your billing rules added, the exchange rate and the day it was read, and the final figure. Compare it with `infrawrench showback` for the same period. In the list, a draft says so in the status column and its total shows as `not computed` rather than `0.00`.

This is read-only. Approving an invoice locks what the customer will be sent, needs `invoices:issue`, and is recorded in the audit log with the person's name. See [Managed accounts & invoices](./managed-accounts.md).

## Security and access

`hygiene` is the [credential hygiene](../team-and-billing/credential-hygiene.md) report: unused API keys, unreferenced SSH keys, and members holding write permissions they never use. The `--json` form is worth scheduling, because these build up slowly and nobody opens a settings page to check. Needs `audit:read`:

```
infrawrench hygiene
infrawrench hygiene --days 180        # 7-365; default 90
infrawrench hygiene --json
```

`access` lists [break-glass access](../team-and-billing/break-glass-access.md) requests and the elevations active right now. It's read-only, but it answers "who is elevated right now" fast. Needs `access:read`:

```
infrawrench access                # every request, live elevations first
infrawrench access active         # only what is in force right now
infrawrench access --json
```

`jit` is [just-in-time access](./just-in-time-access.md) to cloud roles: the queue, live grants and failed revokes, plus every action on them. To approve or deny, you need to be one of the policy's approvers, same as in the app:

```sh
infrawrench jit                           # the queue, live grants and failed revokes
infrawrench jit --mine --holding          # your grants that may be live right now
infrawrench jit policies                  # what you can request
infrawrench jit request --policy prod --role AdministratorAccess --for 2h --reason "INC-4417 restore"
infrawrench jit approve <id> [--note "…"] # or deny; an id prefix is enough
infrawrench jit cancel <id>
infrawrench jit extend <id> --by 30m
infrawrench jit revoke <id>
infrawrench jit --json
```

`cost-visibility` lists your organization's [cost visibility scopes](../team-and-billing/cost-visibility.md). `cost-visibility me` tells you whether your own cost figures are scoped, which is the first thing to check when your totals don't match a colleague's. Read-only; you edit scopes in Settings > Cost Visibility. Listing needs `team:read`:

```
infrawrench cost-visibility
infrawrench cost-visibility me
infrawrench cost-visibility --json
```

`recordings` lists the org's [recorded SSH sessions](./session-recording.md): who connected, to what, for how long, and each session's status. `recordings get <id>` prints the recording in asciinema's asciicast format, so you can replay a session on any machine, even one without Infrawrench. Needs `session-recordings:read`:

```
infrawrench recordings
infrawrench recordings get 3f9c21e8 | asciinema play -
infrawrench recordings get 3f9c21e8 --file incident-4417.cast
infrawrench recordings --json         # list plus the org's policy and storage usage
```

`ownership` lists [resource ownership](../core-concepts/resource-ownership.md): who owns each resource, what it's for, and its ticket link. Only resources with something recorded appear, so a resource missing from this list has no owner. `infrawrench orphans` shows unowned resources that also look wasted. Pass a query to filter by resource name, owner or purpose. Cloud only and read-only: you set owners from a resource's Ownership tab.

```
infrawrench ownership
infrawrench ownership sam            # filter by resource, owner or purpose
infrawrench ownership --json
```

## Status pages and incidents

`status-pages` lists the org's [public status pages](./status-pages.md): what each one shows, whether it's live, and its URL. Drafts show their URL too, so you can check a page before publishing. Give it a page's name or id for its components and their states. Cloud only and read-only: you create and publish pages from the Probes tab on web or desktop.

```
infrawrench status-pages
infrawrench status-pages "Acme API"   # one page: settings and its components
infrawrench status-pages --json
```

There are three kinds of incident in the CLI:

- `declared-incidents` is incidents [your organization declared](./incident-mode.md).
- `incidents` is [provider status correlation](./provider-status.md): somebody else's outage.
- `paging` is incidents from your paging providers.

`declared-incidents` shows severity, status, duration, who declared it, and whether anything the declaration asked for (the change freeze, the announcement, the public update) failed. Give it an id or part of a title for that incident's timeline, artefacts first, with failures in red. Cloud only and read-only: you declare and resolve incidents in the web, desktop and mobile apps.

```
infrawrench declared-incidents
infrawrench declared-incidents "checkout"   # one incident: facts, artefacts, joined timeline
infrawrench declared-incidents --json
```

`paging` lists incidents from your [paging providers](./on-call.md#paging-providers) (PagerDuty, incident.io), open ones first. `ack` and `resolve` take an Infrawrench id, a provider id or the provider's reference (`#1234`, `INC-56`), and update the provider as you. `events` lists the alerts Infrawrench opened at the provider, including any still being retried:

```
infrawrench paging                 # open provider incidents
infrawrench paging --all           # including resolved ones
infrawrench paging ack 1234        # acknowledge PagerDuty incident #1234
infrawrench paging resolve INC-56
infrawrench paging events --json
```

## See what changed and what depends on what

Four read commands cover your organization's history and dependencies:

```
infrawrench changes                        # the drift feed, newest first
infrawrench changes --last 7d --kind deleted
infrawrench changes -a "Production GCP"    # one account
infrawrench changes --resource <id>        # one resource, with before → after diffs

infrawrench diff -a staging -b prod        # two environments compared
infrawrench diff staging prod --all        # positional, ids and timestamps included

infrawrench moment                         # everything that happened around now, every feed merged
infrawrench moment 2026-08-03T03:14 -w 1h  # ±1h around a timestamp

infrawrench graph                          # the dependency tree for the whole org
infrawrench graph --resource <id>          # what it needs, and its blast radius

infrawrench blast-radius <id>              # what breaks if you delete it
infrawrench blast-radius <id> --output json
```

`changes` is the [change timeline](./change-timeline.md) as a table: when each event was seen, a `+`/`~`/`-` symbol for appeared, changed or disappeared, the resource, its type, its account, and which fields changed. `--limit` caps the rows (200 max). `--json` includes the full diffs and the `total` matching your filter.

`diff` is the [environment diff](./environment-diff.md): two accounts of one provider side by side. You get an inventory table with per-type counts and differences, then, for each resource type, what exists on only one side and which fields differ between matching resources. Resources are matched by type and by name with environment words removed, so `api-staging` lines up with `api-prod`.

- Ids, addresses and timestamps are hidden by default, since they always differ. `--all` shows them.
- `--type <typeId>` narrows to one resource type.
- `--json` includes the whole comparison.
- `diff` also works with `--local`, comparing two of your desktop workspace's accounts live from the provider. Any resource type it couldn't list is reported instead of being counted as missing.

`moment` is the [moment view](./moment.md) in your terminal: one timeline of everything that happened around a timestamp. That includes changes, provider incidents, cost anomalies, workflow runs, deployments, audit entries, freezes and alert deliveries. If you lack permission for a feed, or a feed fails, it says so inline. Leave out the timestamp for "around now". `-w/--window 15m|1h|6h` sets how far either side to look. `--json` includes the events, each feed's status and overlapping incidents.

`graph` prints the [dependency graph](./dependency-graph.md) as a text tree. Roots are resources nothing depends on, and each child is something its parent depends on. Focus on one resource and you get a **Depends on** tree and a **Depended on by** tree headed with the blast radius count. `--json` gives the node and edge lists.

`blast-radius` is the [blast radius](./blast-radius.md) report for one resource. It shows:

- everything that depends on it, directly or through other resources, marked direct or with the number of hops
- the dashboards, probes, status pages, alerts, leases, schedules, log queries and workflows that point at it
- what talks to it over the network
- what the check couldn't look at (always printed, even on an otherwise empty report)

`--output json` gives the whole report, including `unchecked`, so a decommissioning script can stop if it doesn't like what it sees.

`changes`, `moment`, `graph` and `blast-radius` need an organization. With `--local` they tell you so instead of printing an empty table.

## Run a command on many hosts

`infrawrench ssh-fanout` is [Fan-out SSH](./ssh-fanout.md) in the terminal. It runs one command on many machines, collapses identical output, and shows outliers as a diff against the majority:

```bash
infrawrench ssh-fanout --list --plugin hetzner       # what can I fan out to?
infrawrench ssh-fanout "uname -r" --tag env:prod --key ops
infrawrench ssh-fanout --snippet kernel --hosts web- --key ops --yes --json
infrawrench ssh-fanout snippets                      # the org's saved commands
```

Like the app, it tells you how many hosts it will hit before running anything (`Run on 14 hosts?`). On a non-interactive terminal it won't run unless you pass `-y/--yes`.

- `--hosts` matches a name, address or tag. `--plugin` and `--tag` narrow it further.
- `--key <id|name>` supplies the org SSH key that VM hosts need.
- `--user` overrides the username.
- `--concurrency <n>` sets how many connections run at once (default 8, max 16).

Text output prints one block per distinct result (`majority`, `outlier`, `failed`), with outliers shown as a `+`/`-` diff so you don't reread the same output. `--json` gives the raw per-host `stdout`, `stderr` and `exitCode`. Runs are cloud only and recorded in the audit log. For local-only SSH accounts, use the desktop app's Fan-out screen.

## Send pages and costs to Infrawrench

The CLI wraps both [push endpoints](./server-push.md), so the machine that has the news can tell Infrawrench directly. You can send an on-call page, or cost rows for spend Infrawrench has no plugin for:

```bash
# Wake somebody up. Repeats under the same key are throttled server-side,
# so a monitor can call this on every tick.
infrawrench page "backup did not complete" --source backups --key nightly

# Recovered? Re-arm the key so the next failure pages immediately.
infrawrench page clear --source backups --key nightly

# Report spend, from a file or a pipeline.
infrawrench costs push --source colo --file rows.json
parse-invoice --json | infrawrench costs push --source colo

# Upload a billing file into a custom cost source (CSV columns are
# auto-detected; --map overrides any of them).
infrawrench costs push --source "Colo invoices" --format csv --file bill.csv \
  --map cost="Amount (EUR)" --map tag=Rack
infrawrench costs push --source "Partner cloud" --format focus --file focus.csv --replace

# List custom cost sources, or one source's upload history.
infrawrench costs sources
infrawrench costs sources "Colo invoices" --json
```

`--source` names the system doing the pushing, and both commands require it.

When `--source` names a [custom cost source](./custom-cost-sources.md), the rows become an upload in its history. `--format csv` and `--format focus` read the file on your machine, the same way the Settings page does, and only send daily totals. `--currency` covers a file with no currency column, and `--date-format mdy|dmy` settles slash dates that could be read either way. If the file's dates overlap an earlier upload, the command stops and lists them. Run it again with `--replace` (replace that spend) or `--append` (add to it).

`page` also takes `--title`, `--key`, `--cooldown <minutes>` and `--voice`. A throttled page still exits zero and prints when the key can fire again. You need a session (or role) with `pages:write` or `costs:write`. See [push from your own servers](./server-push.md) for the endpoints and their limits.

## Check alert routing, webhooks and issues

When a page didn't reach you, the next question is where it went. `infrawrench routing` prints the org's [alert routing rules](./alert-routing.md) as sentences, in the order they're checked. `infrawrench routing queue` lists alerts held for quiet hours or waiting on an acknowledgement:

```bash
infrawrench routing            # rules, top to bottom, first match wins
infrawrench routing queue      # held and escalating alerts   [--limit 50]
infrawrench routing email      # alert email policy and unsubscribed addresses
```

[Event subscriptions](./event-subscriptions.md) send the same events to your own systems. `infrawrench webhooks` lists them with their health (on, off, turned off automatically, failing). `webhooks test <id|name>` sends a test event now and exits non-zero if the receiver refuses it. `webhooks deliveries [id|name]` prints the delivery log. All three take `--json`:

```bash
infrawrench webhooks                       # subscriptions and their health
infrawrench webhooks test "Security feed"  # send infrawrench.test now
infrawrench webhooks deliveries --json     # the last 50 deliveries, every subscription
```

`infrawrench issues` lists every finding filed as an issue in [Jira](./jira.md), [Linear](./linear.md) or [GitHub](./github-issues.md), with each issue's [live status](./jira.md#live-status), status category and assignee, unfinished first. `infrawrench issues jira` (or `linear`, `github`) narrows it to one tracker. `--json` returns `{ org, issues: [{ tracker, issue, url, sourceKind, sourceId, status, statusCategory, assignee, issueUpdatedAt, statusSyncedAt, filedAt }] }`. If you can't read a tracker, it's skipped and the rest of the list still prints.

`infrawrench github-issues` lists findings filed as [GitHub issues](./github-issues.md) (open first, with status, assignee and any pull request). `infrawrench github-issues settings` prints the repository routing, the Terraform sources, and whether each GitHub App installation has approved the permissions needed to file issues. Both take `--json`.

`infrawrench pr-check` runs the [pull request check](./pr-checks.md) without posting anything. By default it checks your local working tree against where it branched from the default branch, uncommitted edits included (`--base <ref>` for a different base). For an open pull request, use `--repo owner/name --pr <n>`. It prints the monthly cost change, blast radius and warnings per Terraform resource. `--json` returns the full report. Needs `iac:read`.

These are all read-only and need the **Organization settings** permission. An address on the unsubscribed list, or outside the [email](./email-alerts.md) domains your organization allows, is skipped when alerts go out. You edit rules on the Notifications page on web or desktop.

## Handle leaked credentials

`infrawrench leaks` lists credentials a secret scanner (GitHub secret scanning, GitLab secret detection) found committed to code. For each one you see the token type with a masked hint, where it was found, what Infrawrench matched it to (an account, a secret stored on a resource, or nothing it holds), when it was detected, and its status. Above the table are counts per status and one line per scanner account, with its last scan or the error that stopped it. It's the "Leaked credentials" category of the [Posture](./posture-checks.md) tab, in your terminal:

```bash
infrawrench leaks                          # open leaks, the scanners and the counts
infrawrench leaks --status all             # also rotated, dismissed and resolved upstream
infrawrench leaks --account "Prod AWS"     # leaks that matched, or may belong to, one account
infrawrench leaks scan                     # scan every scanner account now
infrawrench leaks --json                   # the raw response: full ids, finding URLs, rotation modes
```

Refer to a leak by the short id the table prints, or any unique prefix of the full id. The actions:

```bash
infrawrench leaks rotate 3f9a1c2e                              # the provider reissues the value
infrawrench leaks rotate 3f9a1c2e --value-stdin < new-key.txt  # store a value you created yourself
infrawrench leaks mark-rotated 3f9a1c2e                        # you rotated it at the provider
infrawrench leaks dismiss 3f9a1c2e --reason used-in-tests --comment "fixture key"
infrawrench leaks reopen 3f9a1c2e
```

`rotate` does the same as the Rotate button:

- If the provider can issue a new value, it does, and every resource that uses it is updated.
- If the stored secret is a literal value, you supply the replacement, and only on stdin: piped in, or typed at the prompt with echo off. It's never accepted as an argument, so it never ends up in your shell history.
- A leaked account credential, or one Infrawrench doesn't hold, can't be rotated from here. The command tells you where to rotate it at the provider and exits non-zero. Run `mark-rotated` afterwards (updating the account's credentials also marks it).

`--reason` for `dismiss` is `false-positive`, `wont-fix` or `used-in-tests`. `rotate`, `mark-rotated` and `dismiss` also close the finding on the scanner when the scanner allows it; `--keep-upstream-open` leaves it open there. Every subcommand takes `--json`. Reading needs `resources:read`; scanning and every action need `secrets:write`. Cloud only: scanning runs on the server, so `--local` is refused.

## Manage config as code

`infrawrench config` exports your organization's dashboards, workflows, custom graphs, budgets, alert rules and policies as one JSON document, and applies one back:

```bash
# Snapshot the organization into a file you can commit.
infrawrench config export --out infrawrench.json

# What would applying it change? Writes nothing, so it's the CI check.
infrawrench config plan -f infrawrench.json

# Apply it. Shows the plan, then asks. -y for unattended runs.
infrawrench config apply -f infrawrench.json
```

`--sections budgets,workflows` narrows either direction. `--prune` also deletes anything the document doesn't name (within the sections it covers), which is how you make a staging organization an exact copy. See [config as code](./config-as-code.md) for what the document includes and leaves out.

## Deploy a project

`infrawrench deploy` builds and ships the project in the current directory, using the [Infrafile](./infrafile.md) at its repository root:

```bash
# One environment declared? Nothing else to say.
infrawrench deploy

# Show what it decided and the Dockerfile it rendered, but build nothing.
infrawrench deploy --plan --env production

# Answer a select() without prompting, so this runs in CI.
infrawrench deploy --env staging --set build-host=local --json
```

The CLI builds with the **Docker daemon on your machine**, so you keep your layer cache and don't need a build VM. You can deploy a working tree with uncommitted changes, and the CLI points it out when it spots them. Anything the Infrafile asks about with `select` is prompted for in the terminal, or you can answer up front with a repeatable `--set <key>=<value>`.

Every run is recorded in your organization, so terminal and web deploys share one history. It's also recorded on your machine, which is the only record a `--local` run has:

```bash
# The organization's deploy history.
infrawrench deploy log --env production

# What this machine built, wherever it was building it.
infrawrench deploy log --local
```

`--local` lists the runs the **desktop app's Deploy tab** shows when no organization is selected. It includes the project directory each one built, and a `*` on any commit built from a working tree with uncommitted changes.

`infrawrench deploy typings > Infrafile.d.ts` writes type declarations that give your editor autocomplete for your own accounts.

## Use the TUI

`infrawrench` (or `infrawrench tui`) opens the interactive dashboard:

<insert [Full-screen TUI showing the org tabs across the top, the accounts list on the left, resources of the selected account on the right, and the key-hint footer] here>

| Key                | Action                                       |
| ------------------ | -------------------------------------------- |
| `↑`/`↓` or `j`/`k` | move selection                               |
| `tab`              | switch between accounts and resources panes  |
| `enter`            | list the selected account / open a resource  |
| `o`                | cycle through Local and your organizations   |
| `c`                | 30-day cost view for the active organization |
| `r`                | refresh the current pane                     |
| `esc`              | back                                         |
| `q`                | quit                                         |

Scrolling through accounts only moves the cursor. Press `enter` to load an account's resources from the provider. Opening a resource shows its fields and outputs, plus six-hour metric charts for cloud resources with history.

If the CLI can't read your workspace's master key (for example, your login keychain is locked, or your terminal session can't access it), it stops with an error and changes nothing. Unlock the keychain, or open the desktop app once, then run the command again.

## Script with the CLI

Every command accepts `--json` and exits non-zero on failure, so the CLI fits into scripts and CI:

```bash
# All droplet names in an org account
infrawrench resources -a do-prod --type droplet --json | jq -r '.[].displayName'

# Monthly cost total per currency
infrawrench costs --org acme --json | jq '.totals'

# Anything deleted in the last day, as "account: resource"
infrawrench changes --last 1d --kind deleted --json \
  | jq -r '.entries[] | "\(.accountName): \(.displayName)"'

# What breaks if this database goes away
infrawrench graph --resource "$DB_ID" --json | jq -r '.blastRadius[]'
```

`--no-color` (or the `NO_COLOR` environment variable, or piping the output) turns off colors in text mode.

## Open graphical apps on a Linux host

```
infrawrench apps <resource-id> --key ~/.ssh/id_ed25519
infrawrench apps <resource-id> --json
infrawrench apps <resource-id> --launch org.gnome.Nautilus.desktop
```

`apps` lists what's installed on a Linux host, read from the host's own desktop entries. Nothing is installed on the host.

`--launch` opens that application in the desktop app, since a window needs somewhere to draw. See [Linux applications](./linux-apps.md).

## Notes and limits

- Metric history, cost data and paging are cloud features. `--local` doesn't have them.
- On Windows, open a new terminal after installing so the `PATH` change is picked up.
