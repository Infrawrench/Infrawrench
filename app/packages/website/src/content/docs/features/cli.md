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

## Metrics and cost charts

Cloud resources that are pinned to a dashboard accumulate metric history; the CLI renders it as terminal charts:

```
infrawrench metrics <resource-id> --last 6h
infrawrench metrics <resource-id> --series cpu --last 24h
```

<insert [Terminal showing `infrawrench metrics` output with two colored area charts (CPU and memory series) including y-axis labels and a time axis] here>

Cost graphs use the same data as the dashboard cost widgets:

```
infrawrench costs                        # last 30 days, grouped by provider
infrawrench costs --last 90d --group-by service
infrawrench costs --group-by account --json
```

<insert [Terminal showing `infrawrench costs` output with the daily sparkline and per-provider horizontal bar chart] here>

Accounts whose daily cost collection is failing are called out above the chart, with the provider link that fixes the cause; `--json` carries them as `collectionFailures`. See [when collection fails](./cloud-costs.md#when-collection-fails).

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

## The TUI

`infrawrench` (or `infrawrench tui`) opens the interactive dashboard:

<insert [Full-screen TUI showing the org tabs across the top, the accounts list on the left, resources of the selected account on the right, and the key-hint footer] here>

| Key                | Action                                       |
| ------------------ | -------------------------------------------- |
| `↑`/`↓` or `j`/`k` | move selection                               |
| `tab`              | switch between accounts and resources panes  |
| `enter`            | open the selected account / resource         |
| `o`                | cycle through Local and your organizations   |
| `c`                | 30-day cost view for the active organization |
| `r`                | refresh the current pane                     |
| `esc`              | back                                         |
| `q`                | quit                                         |

Opening a resource shows its fields and outputs plus six-hour metric charts for cloud resources with history.

## Scripting

Every command accepts `--json` and exits non-zero on failure, so the CLI slots into scripts and CI:

```bash
# All droplet names in an org account
infrawrench resources -a do-prod --type droplet --json | jq -r '.[].displayName'

# Monthly cost total per currency
infrawrench costs --org acme --json | jq '.totals'
```

`--no-color` (or the `NO_COLOR` env var, or piping output) disables ANSI colors in text mode.

## Notes and limits

- Metric history, cost data, and paging are cloud features — `--local` has neither.
- The CLI reads the local workspace from the desktop app's database; it does not call provider APIs directly, so a resource created outside Infrawrench appears after the app next syncs.
- On Windows, run the command from a fresh terminal after installing so the `PATH` change is picked up.
