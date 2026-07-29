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

The rest of the account still lists. Org accounts read from the cloud's synced copy instead, which is why they return instantly.

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

Accounts whose daily cost collection is failing are called out above the chart, with the provider link that fixes the cause; `--json` carries them as `collectionFailures`. Accounts that collected without error but have no spend to show yet are listed the same way, as `awaitingData`. See [when collection fails](./cloud-costs.md#when-collection-fails) and [when there is nothing to collect yet](./cloud-costs.md#when-there-is-nothing-to-collect-yet).

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
```

`--no-color` (or the `NO_COLOR` env var, or piping output) disables ANSI colors in text mode.

## Notes and limits

- Metric history, cost data, and paging are cloud features — `--local` has neither.
- The CLI reads the local workspace from the desktop app's database; it does not call provider APIs directly, so a resource created outside Infrawrench appears after the app next syncs.
- On Windows, run the command from a fresh terminal after installing so the `PATH` change is picked up.
