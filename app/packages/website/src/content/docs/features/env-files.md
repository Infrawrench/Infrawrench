---
title: Environment files
description: Commit an .infraenv in place of your .env. It names where every variable comes from, holds no secrets, and regenerates .env on checkout.
sidebar_order: 12
---

A `.env` file mixes two things that want opposite treatment. Its **shape** (which variables exist, what each environment sets, where each value comes from) belongs in Git: it should be reviewed, versioned, and arrive with `git clone`. Its **values** are secrets and must never reach Git. So teams gitignore the whole file, and the shape lives in a Slack thread, a wiki page or a `.env.example` that drifted months ago.

An `.infraenv` is the shape on its own. Every variable is a plain value, a reference to an output of a resource Infrawrench already syncs (a database's connection string, a bucket's endpoint, a secret manager's value), or a reference to an organization secret. It holds no secret values, so you commit it. `infrawrench env pull` reads it and writes a normal `.env`, and a git hook can do that every time you switch branches.

![The Environment files tab with northwind/storefront's .infraenv open on the Shared environment: NODE_ENV and APP_URL are plain values, DATABASE_URL points at a Neon branch's connection string, the Upstash and Resend variables at resource outputs, and STRIPE_SECRET_KEY and SESSION_SECRET at organization secrets](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/tab-shared.png)

## The file

```ini
# Infrawrench environment map. Safe to commit: it holds references, never secret values.

[infrawrench]
org = 3f0c9a52-0000-4000-8000-000000000000
output = .env

[env]
NODE_ENV = development
APP_URL = http://localhost:3000
# Neon: dev branch (Connection string)
DATABASE_URL = resource("neon:2b7e…:br-dev-123", "connectionString")
STRIPE_SECRET_KEY = secret("STRIPE_TEST_KEY")

[env.production]
NODE_ENV = production
APP_URL = https://example.com
# Neon: main branch (Connection string)
DATABASE_URL = resource("neon:2b7e…:br-main-456", "connectionString")
STRIPE_SECRET_KEY = secret("STRIPE_LIVE_KEY")
```

- **`[infrawrench]`** holds settings: `org` is the organization the references live in, `output` is where `env pull` writes (default `.env`, next to the `.infraenv`). Both are optional.
- **`[env]`** applies to every environment.
- **`[env.<name>]`** overrides `[env]` for one environment. Variables it doesn't mention are inherited.

Each line is `KEY = value`, where the value is one of:

| Value                          | What it is                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `development`, `"two words"`   | A plain value, written as is. Quote it if it has spaces or a `#`. A quoted value is always plain.                                                                         |
| `resource("<id>", "<output>")` | An output of a synced resource. It's read from the provider when you pull, so a rotated password comes through on the next pull. Secret manager values work the same way. |
| `secret("<NAME>")`             | An organization secret, stored encrypted by Infrawrench. The same secrets [workflows](./workflows.md) use.                                                                |

In the app, a named environment lists the variables it overrides and, read-only, the ones it inherits from `[env]`:

![The production environment: NODE_ENV, APP_URL, DATABASE_URL, the Upstash variables, STRIPE_SECRET_KEY and SESSION_SECRET override the shared values, while RESEND_API_KEY is inherited from Shared with an Override button](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/tab-production.png)

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

![The same dialog after picking the storefront-assets R2 bucket, listing its outputs: Bucket Name, S3-compatible Endpoint and Public r2.dev URL](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/resource-picker-outputs.png)

### Commit it

**Commit** writes the file to the repository as the Infrawrench GitHub App, either straight to the branch or as a pull request on a new branch. The file is checked first, so a file that doesn't parse is never committed. If someone changed the file on GitHub since you opened it, the commit is refused; reopen it and apply your change again.

![The Commit .infraenv dialog for northwind/storefront on main, with Open a pull request selected, the message "Update .infraenv" and an Open pull request button](https://agent-assets.infrawrench.com/docs-screenshots/features/env-files/commit-dialog.png)

This needs the [GitHub App](./github-issues.md) installed on the repository with **Contents** and **Pull requests** write access. If the installation hasn't accepted those permissions yet, you're shown the link where a GitHub owner approves them.

### Download a .env

**Download .env** resolves one environment and downloads the result. Values aren't shown on screen. A variable that couldn't be resolved is listed and left out of the file.

## Pull it from the command line

```bash
infrawrench env init --from .env      # write .infraenv with one secret("KEY") per variable, never the values
infrawrench env pull                  # resolve [env] into .env
infrawrench env pull --env production # resolve [env.production] over [env]
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

```bash
infrawrench env hooks install
```

This installs `post-checkout`, `post-merge` and `post-rewrite` git hooks that run `infrawrench env pull --quiet`, so switching to a branch whose `.infraenv` points at a different database gives you that database's `.env`. Existing hooks are kept: Infrawrench adds a marked block to them instead of replacing them, and `infrawrench env hooks uninstall` removes only that block. A failed pull never blocks the git command.

## Use it from an assistant

The [MCP server](./mcp.md) has the same tools: find resources to reference (`list_env_sources`), check a file (`describe_env_file`), read and commit it in a repository (`list_env_file_repos`, `read_env_file`, `commit_env_file`, a pull request by default) and resolve it (`resolve_env_file`, which always asks for your approval in chat because it returns secret values).

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
- A reference is to one resource by id. If the resource is deleted, `env check` and the editor flag the variable until you point it somewhere else.
- The mobile app doesn't edit or resolve environment files.
