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
- `deploy [-e <env>] [--plan] [--set key=value]` — build & ship via the project's Infrafile; `--plan` is a read-only dry run: planned changes ("N to create…") plus a diff against the last successful deploy's plan
- `deploy typings` — print Infrafile.d.ts for the editor
- `deploy log [-e <env>] [--local]` — recent deploys
- `deploy outputs [-e <env>]` — the latest successful deploy's `infra.output(...)` value, as JSON
- `deploy status [-e <env>]` — drift check against the local deploy history's ledger: each created resource ok / missing / unknown, plus a summary
- `deploy rollback [-e <env>] [--to-run <runId>] [--delete-created]` — ship a previous deploy's image again; `--delete-created` also deletes resources newer runs created
- `deploy destroy [-e <env>] [--created]` — run the Infrafile's destroy() stage: tear the environment down (asks once at a TTY; CI proceeds); `--created` skips the stage and deletes what the env's recorded runs created instead (newest first, children before parents, best-effort; requires -e)
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

## Writing an Infrafile

An `Infrafile` sits at the repo root and calls `defineInfra({ envs, plan,
dockerfile, deploy, destroy? })` once. Before writing one, run
`infrawrench deploy typings` — it prints `Infrafile.d.ts` generated from the
connected accounts. `infra.accounts` merges the **local workspace and your
org's cloud accounts** — the scope is asked once pre-run at a TTY, or answered
up front with `--org <id|name>` / `--local` (non-interactive default: local +
default org); cloud accounts support list/get/outputs/create/delete, while
SSH/storage/SQL surfaces need a local account.

- **Self-provision in plan().** Find-or-create via `infra.accounts.<plugin>`:
  list, match by name, else `group.create(fields)`. First deploy creates,
  later deploys find — the Infrafile stays idempotent.
- **Don't prompt for secrets a resource can answer.** Sensitive outputs resolve
  with `account.resolveOutput(typeId, resource.id, outputKey)` (e.g. a
  database's `connectionString`, or gcp's `gcp-project` → `accessToken`, which
  logs into Artifact Registry as `oauth2accesstoken` and drives gcloud via
  `CLOUDSDK_AUTH_ACCESS_TOKEN` — no pasted service-account key).
- **Key every ask/select** (`ask("gcpProject", ...)`) so CI answers with
  `--set gcpProject=...`; give defaults so humans mostly press enter.
- **Registries resolve their own docker credentials.** DO `container-registry`,
  AWS `ecr-repository` and Azure `azure-container-registry` all expose sensitive
  `username`/`password` outputs for `docker login` plus `dockerConfigJson` — a
  ready-made `kubernetes.io/dockerconfigjson` pull secret for `importYaml`.
- **Prefer listings over typed ids.** A choice like "which GCP project" should
  be a `select` over a real listing (e.g. `gcp.projects.list()`), with a typed
  `ask` only as the no-account fallback.
- **Regions are a picker too:** create-capable groups expose
  `group.regions()` (the plugin's own list — flags and locations included, the
  same data the GUI's region picker shows); `select` renders the flag/location
  as a hint while `--set` matches the label or the stable `id` (e.g. `fra1`).
- **Managed clusters are first-class.** A managed-cluster resource exposes a
  `kubernetes` sidecar: `cluster.kubernetes.importYaml(yaml)` is kubectl
  apply, and `cluster.kubernetes.{deployments,services,namespaces}.list()`
  cover rollout waits (`fields.readyReplicas`) and LoadBalancer IPs
  (`fields.externalIP`). Deploy runs get a 1-hour budget, so polling with a
  retry loop while a cluster provisions is fine. Provider-CLI containers via
  `ctx.run` are the last resort for what no plugin covers.
- `--plan` is read-only: `infra.accounts` creates are intercepted and become
  planned changes; outputs on a not-yet-created resource resolve to
  `"(known after apply)"`. Guard readiness-waits with `ctx.dryRun` or an
  `id.startsWith("planned:")` check so a dry run doesn't hang.
- **Set `platform: "linux/amd64"` in the plan** when the image ships to a
  cluster/server. CLI builds that push from an arm64 machine assume it when
  unset; without either, an Apple Silicon build produces a manifest amd64
  nodes refuse ("no match for platform in manifest").
- Record machine-readable results (service URL, IPs) with
  `infra.output({...})` in `deploy()`; read them back with
  `deploy outputs --json`.
- Declare `destroy({ env, git, plan, notes })` for anything with preview envs —
  it never prompts, but `plan` carries the env's last successful deploy's
  recorded plan (possibly absent). Write choices like the account name into
  the plan during `plan()` and read them back here; fall back to `env`/`git`
  naming.

Every run records what it created via `infra.accounts.*.create()`;
`deploy rollback --delete-created` deletes what runs after the target created
(children before parents, best-effort, reported in notes). Opt-in because such
resources can hold data.

## Behavior to know

- While the desktop app is open, the CLI runs read-only against the shared
  database, and `login`/`logout` hand off to the app.
- Cloud `resources` listings sync the account first so rows reflect the
  provider now; on sync failure the CLI warns on stderr and serves cached rows.
- Bare `infrawrench` without a TTY prints help instead of launching the TUI.
  `NO_COLOR` or a non-TTY stdout disables ANSI colors.
