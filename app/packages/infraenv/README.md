# @infrawrench/infraenv

Load a committed `.infraenv` into `process.env`, or keep `.env` in step with it, in plain Node.

A project that uses [Infrawrench](https://infrawrench.com) commits `.infraenv` instead of `.env`. It lists every environment variable and says where its value comes from (a literal, an output of a resource in your infrastructure, or an organization secret), so it is reviewed and versioned like code and never holds a secret value. `infraenv pull` resolves it through Infrawrench into the `.env` your app reads. The format is described in the [env files guide](https://infrawrench.com/docs/features/env-files).

This package loads it straight into `process.env` from your code, dotenv style, and is the small, fast way to pull: from git hooks, from CI, or by hand. It needs Node 20 or later and has no dependencies. If you have the Infrawrench desktop app, its CLI (`infrawrench env pull`) does the same thing.

## Install

```sh
npm install --save-dev @infrawrench/infraenv
```

(a regular dependency instead when your code imports it, below)

## Use it in your code

Install it as a regular dependency when your code imports it (`npm install @infrawrench/infraenv`), then load the environment once, at startup:

```js
import { config } from "@infrawrench/infraenv";

await config(); // process.env now has what .infraenv describes
```

Or as a side effect, before anything that reads `process.env`:

```js
import "@infrawrench/infraenv/config";
```

```sh
node --import @infrawrench/infraenv/config app.js
```

CommonJS cannot wait for a promise at load time, so it gets a synchronous version, which **blocks** while it resolves in a child process:

```js
require("@infrawrench/infraenv").configSync();
// or, as a side effect:
require("@infrawrench/infraenv/config");
```

`config()` finds the nearest `.infraenv` the way `infraenv pull` does and assigns each value into `process.env`, keeping any variable that is already set (like dotenv). It returns `{ keys, skipped, problems, environment, source }`: which keys it assigned and which it left alone, never the values. `load()` takes the same options and returns `{ values, problems, environment, source }` without touching `process.env`.

Where the values come from (`source: "auto"`, the default):

- **With credentials** (the `apiKey` option, `INFRAWRENCH_API_KEY`, or the key `infraenv login` stored), from the Infrawrench API. Each call is an audited `secrets:read` resolve, so call it once at startup, not per request; on serverless, every cold start resolves.
- **Without**, from the `.env` that `infraenv pull` or its git hooks wrote, and only when it carries Infrawrench's generated header and was pulled for the same environment. A hand-written `.env` is refused. This is the everyday development case: the hooks keep `.env` current and your code needs no key.
- Otherwise it throws, saying to set `INFRAWRENCH_API_KEY`, run `infraenv login` or run `infraenv pull`.

| Option        | Default                                                    | What it does                                                                                        |
| ------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `environment` | `INFRAENV_ENVIRONMENT`, else `[env]` alone                 | The `[env.<name>]` section to lay over `[env]`.                                                     |
| `override`    | `false`                                                    | Replace variables that are already set (`config` and `configSync` only).                            |
| `required`    | none                                                       | Keys that must be set afterwards; throws naming the missing ones.                                   |
| `strict`      | `false`                                                    | Throw when a variable does not resolve. Otherwise problems are returned and written once to stderr. |
| `quiet`       | `false`                                                    | Do not write problems to stderr.                                                                    |
| `source`      | `"auto"`                                                   | `"api"` or `"file"` forces one of the two sources above.                                            |
| `cwd`         | `process.cwd()`                                            | Where to look for `.infraenv` from.                                                                 |
| `file`        | the nearest `.infraenv`                                    | A path to the file.                                                                                 |
| `vars`        | none                                                       | Substitutions for `${name}` in references, like `--var`.                                            |
| `org`         | `INFRAWRENCH_ORG_ID`, the file's `org`, the key's own      | The organization to resolve in.                                                                     |
| `apiKey`      | `INFRAWRENCH_API_KEY`, else the stored login               | An `iwk_` key.                                                                                      |
| `baseUrl`     | `INFRAWRENCH_BASE_URL`, else `https://app.infrawrench.com` | Another Infrawrench server.                                                                         |
| `timeout`     | `120000`                                                   | `configSync` only: how long to block, in milliseconds.                                              |

`@infrawrench/infraenv/config` reads its options from the environment: `INFRAENV_ENVIRONMENT`, `INFRAENV_FILE`, `INFRAENV_OVERRIDE=1` and `INFRAENV_STRICT=1`.

Errors are `InfraenvError`s, with `problems` and `missing` for `strict` and `required` failures. Nothing in this package prints or throws a value, and the library never writes a file: `load()` keeps the values in memory.

## Pull from git hooks

To keep a `.env` on disk for tools that read one, install the git hooks from your `prepare` script, the way Husky does:

```json
{
  "scripts": {
    "prepare": "infraenv install"
  }
}
```

Every `npm install` now adds a block to `post-checkout`, `post-merge`, `post-rewrite` and `post-commit` that pulls again when a commit changes `.infraenv`, or when `.env` is missing. A checkout that does not touch `.infraenv` costs one `git diff`. The pull runs in the background (output in `.git/infraenv.log`), so git returns at once; set `INFRAENV_HOOK_FOREGROUND=1` to wait for it instead.

`infraenv install` does nothing, successfully, outside a Git repository, in CI (`CI` set), or with `INFRAENV_SKIP_INSTALL=1`. It keeps hooks you already have and appends its block to them; a hook in another language (Python, Node) is skipped with a warning. With Husky, run it after Husky: `"prepare": "husky && infraenv install"`, since Husky rewrites its hook directory.

## Commands

| Command                                                                                              | What it does                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infraenv pull [-e <env>] [-f <file>] [--out <path>] [--var k=v] [--stdout] [--force] [-q] [--json]` | Resolve the nearest `.infraenv` (up to the repository root) and write `.env`, mode 0600. Never replaces a `.env` without Infrawrench's generated header unless `--force`. Exits 1 if a variable failed. |
| `infraenv check [-f <file>] [--var k=v] [--json]`                                                    | What every reference points at, and every problem (missing resources, secrets without a value, unknown outputs). Reads no secret values. Exits 1 on a problem.                                          |
| `infraenv install [-f <file>]` / `uninstall` / `status`                                              | The git hooks.                                                                                                                                                                                          |
| `infraenv login [--key-stdin]` / `logout` / `whoami`                                                 | The API key this machine uses.                                                                                                                                                                          |
| `infraenv skill [install]`                                                                           | The bundled agent skill (below).                                                                                                                                                                        |

`pull` and `check` also take `--org <id>`. Every command takes `--help`. In text mode nothing prints a secret value; `pull --stdout` and `pull --json` do, on purpose.

- `-e, --env <name>` lays `[env.<name>]` over `[env]`; without it, `[env]` alone.
- `--var name=value` (repeatable) fills a `${name}` substitution in a reference, over the file's `[vars]`.
- `--out <path>` writes somewhere else than the file's `output` setting (default `.env` beside the file).

## Credentials

`infraenv` uses an Infrawrench API key (`iwk_...`, created under Settings > API keys; pulling needs `secrets:read`):

1. `INFRAWRENCH_API_KEY`, when set.
2. Otherwise the key `infraenv login` stored in `~/.config/infrawrench/infraenv.json` (`$XDG_CONFIG_HOME` honoured; `%APPDATA%\infrawrench` on Windows), mode 0600. `login` asks for the key without echoing it, or reads it from standard input with `--key-stdin`, and checks it before storing it.

A key belongs to one organization, which Infrawrench reports, so you never type an organization id. To aim at a specific one anyway, the order is `--org`, then `INFRAWRENCH_ORG_ID`, then the file's `[infrawrench] org`, then the organization stored at login, then the key's own.

`INFRAWRENCH_BASE_URL` points it at another Infrawrench server (default `https://app.infrawrench.com`).

Without a key, `pull` and `check` run the desktop app's `infrawrench env pull` / `check` when it is on your PATH (it is signed in as you), and say so once. Otherwise they ask you to run `infraenv login` or set `INFRAWRENCH_API_KEY`.

## CI

Set `INFRAWRENCH_API_KEY` as a secret in your CI and pull before the build. Any CI works; nothing needs installing first:

```sh
npx @infrawrench/infraenv pull --env production
```

GitHub Actions:

```yaml
- name: Pull .env
  run: npx @infrawrench/infraenv pull --env production
  env:
    INFRAWRENCH_API_KEY: ${{ secrets.INFRAWRENCH_API_KEY }}
```

`infraenv install` skips itself in CI, so a `prepare` script is harmless there.

## Agent skill

The package ships an Agent Skills skill in `skills/infraenv/` that teaches coding agents the `.infraenv` format, these commands, and how to migrate a `.env` without copying a secret. Tools that look for skills in `node_modules` pick it up on their own: `npx skills-npm` or `npx @tanstack/intent install`. Or link it yourself:

```sh
npx infraenv skill install
```

That links it into `.agents/skills/infraenv` and, when the repository has a `.claude` directory, `.claude/skills/infraenv` (a copy on Windows), and never replaces anything it did not create. `infraenv skill` prints where the bundled copy is. The same skill is on the website at https://infrawrench.com/skills/infraenv.md.

## Exit codes

`0` success, `1` a failure or a variable that did not resolve, `2` a command line that does not parse.

## License

MIT
