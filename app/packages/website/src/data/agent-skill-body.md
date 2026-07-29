# infrawrench CLI

The Infrawrench desktop app doubles as the `infrawrench` CLI: same local
accounts, same cloud session, same organizations. Enable the shell command
once from the desktop app's sidebar footer, or run `infrawrench cli install`.

For scripting, always pass `--json` — every listing/data command supports it.
Text mode (the default) renders ANSI tables and charts for humans.

## Commands

- `infrawrench` / `infrawrench tui` — interactive dashboard (needs a TTY)
- `login` / `logout` / `whoami` — cloud session (browser PKCE)
- `orgs` — list organizations
- `accounts` — list accounts (local + every org by default)
- `resources --account <id|name> [--type <typeId>]` — list an account's resources
- `resource <id>` — one resource's fields & outputs
- `metrics <id> [--last 6h] [--series cpu] [--local]` — metric charts
- `costs [--last 30d] [--group-by provider|account|service|region|resource]` — org cost graphs
- `costs push --source <name> [--file rows.json]` — push your own cost rows (stdin when no file)
- `page <message> --source <name> [--key k] [--title t] [--cooldown min] [--voice]` — alert on-call
- `page clear --source <name> [--key k]` — drop a page key's cooldown after recovery
- `deploy [-e <env>] [--plan] [--set key=value]` — build & ship via the project's Infrafile
- `deploy typings` — print Infrafile.d.ts for the editor
- `deploy log [-e <env>] [--local]` — recent deploys
- `deploy rollback [-e <env>] [--to-run <runId>]` — ship a previous deploy's image again
- `cli install|uninstall|status` — manage the shell command

## Flags

- `--org <id|name>` or `--local` — scope to one org / the local desktop workspace (mutually exclusive)
- `-a, --account <id|name>` — account for resource commands
- `--json` / `--text` — output mode (mutually exclusive; default text)
- `--last 30m|6h|7d|2w` or `--from` / `--to` — time range for metrics & costs
- `--no-color`, `-v/--version`, `-h/--help`

Exit codes: `0` ok, `1` runtime error, `2` usage error. Errors print as a
single line on stderr.

## Examples

```sh
infrawrench resources --account prod-aws --json | jq '.[].name'
infrawrench metrics res_abc123 --last 6h --series cpu
infrawrench costs --org acme --last 30d --group-by service
echo '[{"amount": 12.5, "service": "ci"}]' | infrawrench costs push --source ci
infrawrench page "db replica lagging" --source poller --key db-lag --cooldown 30
infrawrench deploy --plan
```

## Behavior to know

- While the desktop app is open, the CLI runs read-only against the shared
  database, and `login`/`logout` hand off to the app.
- Cloud `resources` listings sync the account first so rows reflect the
  provider now; on sync failure the CLI warns on stderr and serves cached rows.
- Bare `infrawrench` without a TTY prints help instead of launching the TUI.
  `NO_COLOR` or a non-TTY stdout disables ANSI colors.
