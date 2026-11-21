# @infrawrench/cli

The `infrawrench` command without the desktop app. It talks to Infrawrench
Cloud, so you can read costs, resources, dashboards, alerts and environment
files from a terminal, a CI job or a server.

```sh
npm install -g @infrawrench/cli
infrawrench login
infrawrench costs
```

Or run it once without installing anything:

```sh
npx @infrawrench/cli whoami
```

It needs Node.js 22 or newer and has no dependencies. If you don't want Node,
the same CLI comes as a single executable and as a Debian package:

```sh
curl -fsSL https://infrawrench.com/cli/install.sh | sh
```

See the [CLI documentation](https://infrawrench.com/docs/features/cli) for
every command, and `infrawrench help` for the full list.

## The standalone CLI and the desktop app

This package is the same CLI the desktop app installs as its shell command,
built to run on its own. It keeps its own sign-in, in
`~/.config/infrawrench-cli` (`~/Library/Application Support/infrawrench-cli` on
macOS, `%APPDATA%\infrawrench-cli` on Windows, or `INFRAWRENCH_CONFIG_DIR`).
Two things need the desktop app: local accounts (`--local`) and `apps`.

## License

Business Source License 1.1. See `LICENSE`.
