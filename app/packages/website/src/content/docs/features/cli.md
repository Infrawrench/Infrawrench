---
title: Command-line interface
description: Run Infrawrench from any terminal — an interactive TUI dashboard plus scriptable JSON and text output, sharing the desktop app's accounts and cloud session.
sidebar_order: 13
---

> **Desktop app required.** The `infrawrench` command is a thin launcher for the desktop app running in headless CLI mode, so it sees exactly the same data: your local accounts, your cloud session, and every organization you belong to.

The CLI has three faces:

- **TUI mode** — run `infrawrench` with no arguments for a full-screen interactive dashboard: switch between Local and your organizations, browse accounts and resources, open a resource to see its fields plus live metric charts, and pull up 30-day cost graphs.
- **Text mode** — human-readable tables and terminal charts, the default for every subcommand.
- **JSON mode** — pass `--json` to any command for stable, script-friendly output (`jq` away).

## Installing the shell command

From the desktop app, click **Install shell command** at the bottom of the sidebar. This writes a tiny `infrawrench` launcher to `/usr/local/bin` (or `~/.local/bin` when that isn't writable) on macOS and Linux, or to a per-user `bin` directory that is added to your `PATH` on Windows.

<insert [Desktop app sidebar footer showing the "Install shell command" button below "Add account", with the success toast visible after clicking] here>

You can manage the launcher from the CLI itself afterwards:

```
infrawrench cli status
infrawrench cli install
infrawrench cli uninstall
```

After updating the app, `infrawrench cli status` warns if the launcher points at an older build — rerun `infrawrench cli install` to refresh it.

## Signing in and organizations

The CLI shares the desktop app's session. If you're already signed in from the app there is nothing to do — `infrawrench whoami` will show your account. Signing in from the CLI works too:

```
infrawrench login     # opens your browser (PKCE), then returns to the terminal
infrawrench whoami
infrawrench logout
```

Everything org-related mirrors the app's org switcher: the local workspace plus every cloud organization.

```
infrawrench orgs                     # list your organizations
infrawrench accounts                 # accounts everywhere: Local + each org
infrawrench accounts --local         # just the local workspace
infrawrench accounts --org acme      # one org (id, name, or unique prefix)
```

While the desktop app is running, the CLI opens the shared database read-only and reuses the app's tokens without refreshing them — `login`/`logout` will ask you to use the app instead. Close the app and the CLI takes over fully.

## Browsing resources

```
infrawrench resources -a "Production GCP"           # all resources of an account
infrawrench resources -a prod --type gce-instance   # filter by resource type
infrawrench resource <resource-id>                  # fields + outputs of one resource
```

Account references accept an id, an exact name, or a unique name prefix. When the same name exists both locally and in an org, disambiguate with `--local` or `--org`.

Local accounts are listed live from the provider, exactly as the desktop sidebar does — the CLI holds no cached copy of your infrastructure, so what it prints is what the provider says right now. That also means a listing is only as fast as the provider's API, and a resource type the credentials can't reach is reported on stderr rather than quietly dropped:

```
volume: 403 Forbidden — token is missing the "block_storage:read" scope
```

The rest of the account still lists. Org accounts ask the cloud to re-sync the account from the provider first and then read the synced copy, so they reflect what exists right now too — if the sync fails (provider outage, rate limit) the CLI prints the last synced copy and says so on stderr. The TUI does the same when you open an account: the synced copy appears instantly, then refreshes in place once the live sync completes.

## Metrics and cost charts

The CLI renders metric series as terminal charts:

```
infrawrench metrics <resource-id> --last 6h
infrawrench metrics <resource-id> --series cpu --last 24h
infrawrench metrics <resource-id> --local        # a local resource, live from the provider
```

Cloud resources [pinned to a dashboard](./dashboard.md#historical-metrics) answer from their accumulated history, which supports long ranges; unpinned ones are fetched live from the provider on demand, so you still get a chart — just limited to whatever window the provider serves. Local resources are always fetched live through the plugin.

<insert [Terminal showing `infrawrench metrics` output with two colored area charts (CPU and memory series) including y-axis labels and a time axis] here>

Cost graphs use the same data as the dashboard cost widgets:

```
infrawrench costs                        # last 30 days, grouped by provider
infrawrench costs --last 90d --group-by service
infrawrench costs --group-by account --json
```

<insert [Terminal showing `infrawrench costs` output with the daily sparkline and per-provider horizontal bar chart] here>

Accounts whose daily cost collection is failing are called out above the chart, with the provider link that fixes the cause; `--json` carries them as `collectionFailures`. Accounts that collected without error but have no spend to show yet are listed the same way, as `awaitingData`. See [when collection fails](./cloud-costs.md#when-collection-fails) and [when there is nothing to collect yet](./cloud-costs.md#when-there-is-nothing-to-collect-yet).

`--anomalies` turns the same command into the [spend-anomaly](./cost-anomaly-alerts.md) list — the days one provider or service cleared its own trailing baseline, with the actual spend, the baseline, and the percentage change. Rows marked `[new source]` are providers or services that had no spend at all across the window and then billed a material amount; they print `none` for a baseline and `new` for a change, since there is nothing for them to be up from:

```
infrawrench costs --anomalies
infrawrench costs --anomalies --days 7      # 1-90; --last 2w says the same thing
```

`schedules` lists the org's [sleep/wake schedules](./sleep-schedules.md) — each window, its timezone, the next transition, the last run's outcome (including freeze skips and failures), and the projected monthly saving:

```
infrawrench schedules
infrawrench schedules --json
```

`probes` lists the org's [synthetic probes](./synthetic-probes.md) — each endpoint's live status, check interval, trailing-24h uptime and last latency, probed from outside your infrastructure. Give it a probe's id or name for that probe's detail plus a 24-hour latency sparkline. Cloud-only, and read-only: probes are created from the web or desktop Probes tab, where the endpoint suggestions live:

```
infrawrench probes
infrawrench probes api-health     # one probe: state, facts, latency sparkline
infrawrench probes --json
```

`oversized` lists [right-sizing recommendations](./right-sizing.md) — machines whose 14-day p95 CPU/memory sits well under their size, with the recommended smaller size and the live-priced monthly saving. Cloud-only (the percentiles live in the cloud metrics store), and read-only: applying a resize is done from the web or desktop Costs panel:

```
infrawrench oversized
infrawrench oversized --json
```

`estimate` prints one resource's [monthly cost estimate](./cost-estimates.md) at the provider's list price, itemized — the same figure the create form and the resource page quote. Cloud-only, and a projection rather than a bill: `costs` is what you were actually charged, this is the run-rate the resource's current shape implies. Pass the compound resource id, or a display name / external id scoped with `--account`:

```
infrawrench estimate acc-123:ec2-instance:i-0abc
infrawrench estimate my-api-box --account production
infrawrench estimate acc-123:ec2-instance:i-0abc --json
```

`tags` and `showback` are the [tag governance](./tag-policy-and-showback.md) reports: the org's required tags with per-account compliance scores and the spend missing a required key, and spend grouped by cost centre through the org's allocation rules:

```
infrawrench tags                  # policy, compliance table, untagged spend
infrawrench tags --last 90d --json
infrawrench showback              # spend by cost centre; unmatched spend is "unallocated"
```

<insert [Terminal showing `infrawrench tags` output with the compliance table (green/yellow/red score column) and the untagged-spend bar chart below] here>

## What changed, and what depends on what

Three read commands over the organization's own history and topology:

```
infrawrench changes                        # the drift feed, newest first
infrawrench changes --last 7d --kind deleted
infrawrench changes -a "Production GCP"    # one account
infrawrench changes --resource <id>        # one resource, with before → after diffs

infrawrench moment                         # everything that happened around now, every feed merged
infrawrench moment 2026-08-03T03:14 -w 1h  # ±1h around a timestamp

infrawrench graph                          # the dependency tree for the whole org
infrawrench graph --resource <id>          # what it needs, and its blast radius
```

`changes` is the [change timeline](./change-timeline.md) in a table: when an event was seen, a `+`/`~`/`-` glyph for appeared / changed / disappeared, the resource, its type, its account, and which fields moved. `--limit` caps the rows (200 max); `--json` carries the full diffs and the `total` matching your filter.

`moment` is the [moment view](./moment.md) in the terminal: one merged, chronological narrative of everything the platform knows happened around a timestamp — changes, provider incidents, cost anomalies, workflow runs, deployments, audit entries, freezes and alert deliveries — with per-feed permission omissions and failures reported inline rather than silently dropped. Omit the timestamp for "around now"; `-w/--window 15m|1h|6h` sets the ± half-window; `--json` carries the typed events, per-feed statuses and overlapping incident spans.

`graph` prints the [dependency graph](./dependency-graph.md) as an ASCII tree rather than a picture — roots are the resources nothing depends on, and each child is something its parent depends on. Focused on one resource it becomes the terminal's **Dependencies** tab: a **Depends on** tree, and a **Depended on by** tree headed with the blast-radius count. `--json` emits the node and edge lists.

Both read data the cloud poller collects, so they need an organization; `--local` says so rather than printing an empty table.

## Running a command on many hosts

`infrawrench ssh-fanout` is [Fan-out SSH](./ssh-fanout.md) in the terminal — one command over many boxes, with identical output collapsed and outliers diffed against the majority:

```bash
infrawrench ssh-fanout --list --plugin hetzner       # what can I fan out to?
infrawrench ssh-fanout "uname -r" --tag env:prod --key ops
infrawrench ssh-fanout --snippet kernel --hosts web- --key ops --yes --json
infrawrench ssh-fanout snippets                      # the org's saved commands
```

Like the app, it names the host count before it runs anything — `Run on 14 hosts?` — and refuses to fan out on a non-interactive terminal unless you pass `-y/--yes`. `--hosts` matches a name, address or tag; `--plugin` and `--tag` narrow further; `--key <id|name>` supplies the org SSH key that VM hosts need; `--user` overrides the username; `--concurrency <n>` changes how many connections run at once (default 8, max 16).

Text output prints one block per distinct result — `majority`, `outlier`, `failed` — with outliers rendered as a `+`/`-` diff instead of repeating output you have already read. `--json` gives the raw per-host `stdout`, `stderr` and `exitCode`. Runs are cloud-only and audit-logged; use the desktop app's Fan-out screen for local-only SSH accounts.

## Pushing back up

The CLI is often already installed on the machine that has the news, so it wraps both [push endpoints](./server-push.md) — an on-call page, and cost rows for spend Infrawrench has no plugin for:

```bash
# Wake somebody up. Repeats under the same key are throttled server-side,
# so a monitor can call this on every tick.
infrawrench page "backup did not complete" --source backups --key nightly

# Recovered — re-arm the key so the next failure pages immediately.
infrawrench page clear --source backups --key nightly

# Report spend, from a file or a pipeline.
infrawrench costs push --source colo --file rows.json
parse-invoice --json | infrawrench costs push --source colo
```

`--source` names the system doing the pushing and is required by both. `page` also takes `--title`, `--key`, `--cooldown <minutes>`, and `--voice`; a suppressed page still exits zero and prints when the key can fire again. Both need a session (or role) carrying `pages:write` / `costs:write` — see [push from your own servers](./server-push.md) for the endpoints and their limits.

## Deploying

`infrawrench deploy` builds and ships the project in the current directory, driven by the [Infrafile](./infrafile.md) at its repository root:

```bash
# One environment declared? Nothing else to say.
infrawrench deploy

# Show what it decided and the Dockerfile it rendered — build nothing.
infrawrench deploy --plan --env production

# Answer a select() without prompting, so this runs in CI.
infrawrench deploy --env staging --set build-host=local --json
```

The CLI builds with the **Docker daemon on your machine**, so you keep your layer cache and need no build VM — and you can deploy a working tree with uncommitted changes, which it points out when it spots them. Anything the Infrafile asks about via `select` is prompted for in the terminal, or answered up front with a repeatable `--set <key>=<value>`.

Every run is recorded, twice when it can be: in the organization, so a terminal deploy and a web deploy share one history, and on this machine, which is the only record a `--local` run has.

```bash
# The organization's deploy history.
infrawrench deploy log --env production

# What this machine built, wherever it was building it.
infrawrench deploy log --local
```

`--local` lists the runs the **desktop app's Deploy tab** shows when no organization is selected, including the project directory each one built and a `*` on any commit that was built from a working tree with uncommitted changes.

`infrawrench deploy typings > Infrafile.d.ts` writes the declarations that give your editor autocomplete over your own accounts.

## The TUI

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

Moving through the accounts list only moves the cursor — `enter` is what asks the provider for that account's resources, so scrolling never fires a burst of API calls. Opening a resource shows its fields and outputs plus six-hour metric charts for cloud resources with history.

If the CLI cannot read your workspace's master key — a locked login keychain, or a terminal session that has no access to it — it stops with an error instead of continuing. Nothing is rewritten: minting a replacement key would leave every stored credential unreadable. Unlock the keychain, or open the desktop app once, and run the command again.

## Scripting

Every command accepts `--json` and exits non-zero on failure, so the CLI slots into scripts and CI:

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

`--no-color` (or the `NO_COLOR` env var, or piping output) disables ANSI colors in text mode.

## Notes and limits

- Metric history, cost data, and paging are cloud features — `--local` has neither.
- The CLI reads the local workspace from the desktop app's database; it does not call provider APIs directly, so a resource created outside Infrawrench appears after the app next syncs.
- On Windows, run the command from a fresh terminal after installing so the `PATH` change is picked up.
