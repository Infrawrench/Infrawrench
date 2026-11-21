---
title: Environment files
description: Commit an .infraenv in place of your .env. It names where every variable comes from, holds no secrets, and regenerates .env on checkout.
sidebar_order: 12
---

A `.env` file mixes two things that want opposite treatment. Its **shape** (which variables exist, what each environment sets, where each value comes from) belongs in Git: it should be reviewed, versioned, and arrive with `git clone`. Its **values** are secrets and must never reach Git. So teams gitignore the whole file, and the shape lives in a Slack thread, a wiki page or a `.env.example` that drifted months ago.

An `.infraenv` is the shape on its own. Every variable is a plain value, a reference to an output of a resource Infrawrench already syncs (a database's connection string, a bucket's endpoint, a secret manager's value), or a reference to an organization secret. It holds no secret values, so you commit it. `infrawrench env pull` reads it and writes a normal `.env`, and a git hook can do that every time you switch branches.

![The Environment files tab with northwind/storefront's .infraenv open on Shared: a stage = dev substitution above the variables, DATABASE_URL and the Upstash variables as by-name resource references whose names use ${stage} (each showing the resource it found), and plain values and secrets below](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/v2-tab-shared.png)

## The file

```ini
# Infrawrench environment map. Safe to commit: it holds references, never secret values.

[vars]
stage = dev

[env]
NODE_ENV = development
APP_URL = http://localhost:3000
# Neon: storefront / dev (Connection string)
DATABASE_URL = resource("neon/neon-branch", "storefront / ${stage}", "connectionString")
STRIPE_SECRET_KEY = secret("STRIPE_TEST_KEY")

[vars.production]
stage = main

[env.production]
NODE_ENV = production
APP_URL = https://example.com
STRIPE_SECRET_KEY = secret("STRIPE_LIVE_KEY")
```

- **`[env]`** applies to every environment.
- **`[env.<name>]`** overrides `[env]` for one environment. Variables it doesn't mention are inherited.
- **`[vars]`** and **`[vars.<name>]`** hold substitutions (see [Substitutions](#substitutions)). They never become environment variables themselves.
- **`[infrawrench]`** holds optional settings: `output` is where `env pull` writes (default `.env`, next to the `.infraenv`), and `org` pins the file to one organization. Leave `org` out unless you mean it: without it the file resolves in whichever organization pulls it.

Each line is `KEY = value`, where the value is one of:

| Value                                               | What it is                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `development`, `"two words"`                        | A plain value, written as is. Quote it if it has spaces or a `#`. A quoted value is always plain.                                                                                                                         |
| `resource("<plugin>/<type>", "<name>", "<output>")` | An output of the synced resource with that plugin, type and display name, in the organization doing the pull. Add `@<account>` to the type (`"neon/neon-branch@Neon EU"`) when two accounts have a resource of that name. |
| `resource("<id>", "<output>")`                      | An output of one resource, pinned by its id. Use it when a name is ambiguous or you want this exact resource. It only resolves in the organization that owns it.                                                          |
| `secret("<NAME>")`                                  | An organization secret, stored encrypted by Infrawrench. The same secrets [workflows](./workflows.md) use. Each organization has its own, so one name can hold a different value in each.                                 |

Resource outputs are read from the provider when you pull, so a rotated password comes through on the next pull. Secret manager values (AWS Secrets Manager, GCP Secret Manager, Vault and the like) work the same way.

### Substitutions

`${name}` inside the arguments of `resource()` and `secret()` is replaced before anything is looked up, so one line can serve several environments or several organizations:

```ini
[vars]
team = storefront
stage = dev

[env]
DATABASE_URL = resource("neon/neon-branch", "${team} / ${stage}", "connectionString")
SENTRY_DSN = secret("SENTRY_DSN_${environment}")

[vars.production]
stage = main

[env.production]
```

![The preview environment, where stage is preview-checkout-v2: DATABASE_URL finds the Neon branch storefront / preview-checkout-v2, while the Upstash variables are flagged because no resource named sessions-preview-checkout-v2 exists, and SESSION_SECRET is flagged because that secret has no value](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/v2-tab-preview.png)

Values come from, lowest first: `[vars]`, the built-in `environment` (the environment's name, when you pull one), `[vars.<environment>]`, then `--var name=value` on the command line. A name with no value is reported on that variable and left out of the `.env`. Substitution never touches plain values, so `PATH_HINT = ${HOME}/bin` stays exactly as written. Write `$${` for a literal `${` inside a reference.

### One file, several organizations

A file with no `org` setting, by-name `resource()` references and `secret()` names resolves in whichever organization runs `env pull`. A team whose staging and production live in separate organizations can commit one `.infraenv`, and so can someone working across several clients: each organization needs resources with the same names (or names a substitution produces) and secrets with the same names. Pinning by id is still there for the one resource you mean exactly.

In the app, a named environment lists the variables it overrides and, read-only, the ones it inherits from `[env]`:

![The production environment: its stage substitution overrides the shared one, NODE_ENV, APP_URL and SESSION_SECRET override the shared variables, and the rest are inherited from Shared with an Override button](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/v2-tab-production.png)

Lines before any section belong to `[env]`, so a `.env` of plain values is already a valid `.infraenv`. Comments start with `#`; the editor writes one above each reference naming the resource, so reviews read well.

### Why `.infraenv` and not `.env.something`

Most frameworks' default `.gitignore` ignores `.env*`. A file called `.env.infrawrench` would be ignored by exactly the rule that keeps secrets out, and the point of this file is to be committed.

## Edit it in the app

Open **Environment files** from the sidebar.

1. Pick a repository, branch and path (default `.infraenv`) and click **Open**. A file that doesn't exist yet opens empty. You can also start a **New file** or **Import** pasted text without a repository.
2. Pick an environment: **Shared** is `[env]`; add, rename or remove named environments beside it.
3. Add variables. For each one choose where its value comes from:
   - **Value**: type it.
   - **Resource output**: search your resources and pick an output. An empty name is filled in from the output (for example `DATABASE_URL` for a database's connection string).
   - **Secret**: pick an organization secret, or create one with **New secret**. The value is stored encrypted and never written to the file.
4. Rows that point at something missing (a deleted resource, an output the type doesn't have, a secret with no value) are flagged as you edit.

The text of the file is shown beside the table. Copy it, download it, or edit the text directly.

![The Pick a resource output dialog searching "storefront", listing Neon branches, a Resend API key, an AWS secret and a Cloudflare R2 bucket with their provider, type and account](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/resource-picker-search.png)

![The same dialog after picking the storefront-assets R2 bucket, listing its outputs: Bucket Name, S3-compatible Endpoint and Public r2.dev URL](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/v2-resource-picker-outputs.png)

### Commit it

**Commit** writes the file to the repository as the Infrawrench GitHub App, either straight to the branch or as a pull request on a new branch. The file is checked first, so a file that doesn't parse is never committed. If someone changed the file on GitHub since you opened it, the commit is refused; reopen it and apply your change again.

![The Commit .infraenv dialog for northwind/storefront on main, with Open a pull request selected, the message "Update .infraenv" and an Open pull request button](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/commit-dialog.png)

This needs the [GitHub App](./github-issues.md) installed on the repository with **Contents** and **Pull requests** write access. If the installation hasn't accepted those permissions yet, you're shown the link where a GitHub owner approves them.

### Download a .env

**Download .env** resolves one environment and downloads the result. Values aren't shown on screen. A variable that couldn't be resolved is listed and left out of the file.

## Pull it from the command line

```bash
infrawrench env init --from .env      # write .infraenv with one secret("KEY") per variable, never the values, and install the git hooks
infrawrench env pull                  # resolve [env] into .env
infrawrench env pull --env production # resolve [env.production] over [env]
infrawrench env pull --var stage=qa   # override a substitution
infrawrench env check                 # every reference, what it points at, and any problems
```

`env pull` finds the nearest `.infraenv` from the current directory up to the repository root, resolves it in the organization `--org` names, else the one its `org` setting names, else your current organization, and writes the output with owner-only permissions. The generated file starts with a header:

```bash
# Auto-generated by Infrawrench. Do not edit.
# Source: .infraenv (environment: production).
# Edit .infraenv instead, then run `infrawrench env pull` to regenerate this file.
# It holds secret values: keep it out of Git.
```

`env pull` won't overwrite a `.env` that doesn't start with that header, so a first pull never clobbers a file you wrote by hand. Pass `--force` once to replace it. It also warns when the output isn't gitignored, and `env init` adds it to `.gitignore` for you.

A variable that fails to resolve is reported with its line and left out; the rest are still written, and the command exits 1. `--stdout` prints the file instead of writing it, and `--json` prints the full response. See [CLI](./cli.md#environment-files).

### Regenerate on checkout

`env init` installs git hooks that keep `.env` up to date as you work; on an existing project, run `infrawrench env hooks install`. They cover `post-checkout`, `post-merge`, `post-rewrite` (a rebase) and `post-commit`, so the `.env` in your working copy follows the `.infraenv`:

- After you switch branches, merge, pull, rebase or commit, the hook checks whether that changed the `.infraenv`, or whether the `.env` is missing. Only then does it pull. A checkout that doesn't touch the file costs one `git diff`, and no Infrawrench process starts.
- The pull runs in the background, so the git command returns at once. Its output goes to `.git/infraenv.log`. Set `INFRAENV_HOOK_FOREGROUND=1` to wait for it instead.
- The hook uses the fastest puller it finds: the project's own [`@infrawrench/infraenv`](#use-it-from-npm) (`node_modules/.bin/infraenv`), then an `infraenv` on your `PATH`, then `infrawrench env pull`.
- Existing hooks are kept: a marked block is added to them instead of replacing them, and `infrawrench env hooks uninstall` removes only that block. A hook written in another language is left alone. A failed pull never fails the git command.

`infrawrench env hooks status` shows which hooks have the block.

## Use it from npm

`@infrawrench/infraenv` is the same pull and check as a small Node package with no dependencies, for projects with a `package.json`. It starts in a few tens of milliseconds instead of booting the desktop app, which is what the git hooks want. Like Husky, it installs its hooks from a `prepare` script:

```bash
npm install --save-dev @infrawrench/infraenv
npm pkg set scripts.prepare="infraenv install"
npx infraenv login                  # paste an API key (Settings, API keys); stored in ~/.config/infrawrench with owner-only permissions
npx infraenv pull --env production
```

| Command                              | What it does                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infraenv pull`                      | Resolve and write the `.env`. Same flags as `infrawrench env pull`: `-e/--env`, `-f/--file`, `--out`, `--var`, `--stdout`, `--force`, `-q`, `--json`. |
| `infraenv check`                     | What each reference points at, and every problem. Exit 1 on any.                                                                                      |
| `infraenv install`                   | The git hooks (the same block `infrawrench env hooks install` writes). Does nothing outside a repository or when `CI` is set.                         |
| `infraenv uninstall`, `status`       | Remove the hooks, or show which have the block.                                                                                                       |
| `infraenv login`, `logout`, `whoami` | Store, forget or show the API key and its organization.                                                                                               |
| `infraenv skill install`             | Link the bundled agent skill into `.agents/skills/` (and `.claude/skills/` when the project has a `.claude` folder).                                  |

It authenticates with `INFRAWRENCH_API_KEY` when that's set (an `iwk_` key, which is how CI uses it), else the key `infraenv login` stored. The organization is the API key's own unless `--org`, `INFRAWRENCH_ORG_ID` or the file's `org` setting names another. With no key at all, `pull` and `check` hand over to `infrawrench env pull` / `check` when the desktop CLI is installed.

With Husky, chain them: `"prepare": "husky && infraenv install"`. Set `INFRAENV_SKIP_INSTALL=1` to skip the hooks for one install.

### In your code

The package also loads the file straight into `process.env`, the way dotenv does, so your program needs no `.env` step. Use one of:

```js
// ESM: resolve, then assign every variable that is not already set
import { config } from "@infrawrench/infraenv";
await config({ environment: "production" });

// Or as a side effect, before anything reads process.env
import "@infrawrench/infraenv/config";

// CommonJS: blocks until the variables are set
require("@infrawrench/infraenv").configSync();
```

`node --import @infrawrench/infraenv/config app.js` does the same without touching your code. Set `INFRAENV_ENVIRONMENT` to pick an environment; `override`, `required` (keys that must be set) and `strict` (throw when a variable does not resolve) are options, and `load()` returns the values without assigning them. Where the values come from:

- With an API key (`INFRAWRENCH_API_KEY`, the key `infraenv login` stored, or the `apiKey` option), from Infrawrench. Each call is an audited secret read, so run it once at startup.
- Without one, from the `.env` that `infraenv pull` or the git hooks wrote, as long as it has the generated header and is for the same environment. A hand-written `.env` is never read.

Nothing prints or throws a value, and the library never writes a file.

### In any CI

Any CI system that can run Node can pull the `.env` for a job: store an API key with **Secrets: read** as a CI secret, then

```bash
INFRAWRENCH_API_KEY=$INFRAWRENCH_API_KEY npx @infrawrench/infraenv pull --env staging
```

For Infrawrench CI itself, see [In Infrawrench CI](#in-infrawrench-ci): it needs no key.

### In Infrawrench CI

Infrawrench CI reads the file itself, with no API key: name it in a job with `env-file:`.

```yaml
jobs:
  test:
    env-file: { path: .infraenv, environment: staging }
    run: pnpm test
```

The file is read at the run's own commit, and its variables are added to the job's environment; the job's own `env:` wins on a conflict. Jobs only get what CI is allowed to use:

- Each `resource()` must be granted to CI for the repository and branch, with that output ticked (see [Infrawrench CI](./ci.md#environment-files)). A reference to anything else fails the job and names what to grant.
- `secret("NAME")` reads the repository's **CI secrets**, not your organization's secrets, which are never given to CI jobs. Set the secrets your pipelines need as CI secrets under the same names.
- A pull request from a fork gets nothing.

## Use it with a coding agent

The environment files skill teaches a coding agent the format and the rules that matter: never write a secret value into the file, prefer references by name, check the file before handing it back. Add it from the card. The npm package also ships it, in `node_modules/@infrawrench/infraenv/skills/infraenv/`, where tools that collect skills from your dependencies (such as skills-npm) find it; `npx infraenv skill install` links it into `.agents/skills/` yourself.

<skill id="infraenv" />

The [MCP server](./mcp.md) has the same tools as the app: find resources to reference (`list_env_sources`), check a file (`describe_env_file`), read and commit it in a repository (`list_env_file_repos`, `read_env_file`, `commit_env_file`, a pull request by default) resolve it (`resolve_env_file`, which always asks for your approval in chat because it returns secret values), and check what an Infrawrench CI job would get from it (`check_ci_env_file`, which names the grant covering each resource or why a job would fail, and reads no values).

## Permissions

| Action                                         | Permission           |
| ---------------------------------------------- | -------------------- |
| Edit and check a file, search resources        | Resources: read      |
| Resolve a file (`env pull`, **Download .env**) | Secrets: read        |
| Open a file from a repository                  | GitHub issues: read  |
| Commit a file                                  | GitHub issues: write |
| Create an organization secret                  | Secrets: write       |

Every resolve is recorded in the [audit log](../team-and-billing/audit-log.md) with the variable names and the environment, never the values. Commits are recorded with the repository, path, branch and commit.

## Limits

- Resolving needs the cloud: the desktop app's local mode and `infrawrench --local` don't resolve `.infraenv` files.
- A by-name reference needs exactly one match. If two accounts have a resource with that name, `env check` and the editor say how many matched; add `@<account>` or pin it by id. A deleted resource is flagged the same way until you point the variable somewhere else.
- The mobile app doesn't edit or resolve environment files.
