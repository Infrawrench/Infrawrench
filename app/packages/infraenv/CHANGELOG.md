# Changelog

## 0.2.1

- The first release published from CI with npm trusted publishing, so it carries provenance. No code changes from 0.2.0, which was published by hand to create the package.

## 0.2.0

- A library, dotenv style: `config()` resolves `.infraenv` and assigns into `process.env` without replacing what is set (`override: true` does); `load()` returns the values instead; `configSync()` does `config()`'s work for CommonJS, blocking in a child process.
- `@infrawrench/infraenv/config` runs it on import (`import`, `node --import`, or `require`), with options from `INFRAENV_ENVIRONMENT`, `INFRAENV_FILE`, `INFRAENV_OVERRIDE` and `INFRAENV_STRICT`.
- With credentials the values come from the API; without, from the `.env` a pull or the git hooks generated (never a hand-written one).
- Options: `environment`, `file`, `cwd`, `vars`, `org`, `apiKey`, `baseUrl`, `override`, `required`, `strict`, `quiet`, `source`, and `timeout` for `configSync`.
- The package now has `exports` for ESM and CommonJS, with types. The CLI is unchanged.

## 0.1.0

- `infraenv pull` and `infraenv check`, with the desktop CLI's flags: `--env`, `--file`, `--out`, `--var`, `--stdout`, `--force`, `--quiet`, `--json`, `--org`.
- `infraenv install`, `uninstall` and `status`: the git hooks, the same block `infrawrench env hooks` writes. Safe in a `prepare` script.
- `infraenv login`, `logout` and `whoami`: an API key from `INFRAWRENCH_API_KEY` or stored by `login`; the organization comes from the key.
- Without a key, `pull` and `check` run the desktop app's `infrawrench env` when it is installed.
- The `infraenv` agent skill in `skills/infraenv/`, and `infraenv skill [install]`.
