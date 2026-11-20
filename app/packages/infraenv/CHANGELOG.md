# Changelog

## 0.1.0

- `infraenv pull` and `infraenv check`, with the desktop CLI's flags: `--env`, `--file`, `--out`, `--var`, `--stdout`, `--force`, `--quiet`, `--json`, `--org`.
- `infraenv install`, `uninstall` and `status`: the git hooks, the same block `infrawrench env hooks` writes. Safe in a `prepare` script.
- `infraenv login`, `logout` and `whoami`: an API key from `INFRAWRENCH_API_KEY` or stored by `login`; the organization comes from the key.
- Without a key, `pull` and `check` run the desktop app's `infrawrench env` when it is installed.
- The `infraenv` agent skill in `skills/infraenv/`, and `infraenv skill [install]`.
