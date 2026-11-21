# The .infraenv format

A dotenv file with INI sections. Lines before any section belong to `[env]`, so a `.env` of plain values is already a valid `.infraenv`. `#` starts a comment line.

## Sections

| Section         | Holds                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `[infrawrench]` | Optional settings: `output = .env` (where pull writes, relative to the file), `org = <id>` (pins the org; avoid). |
| `[vars]`        | Substitutions for every environment: `name = value`. Never environment variables themselves.                      |
| `[env]`         | Variables every environment gets.                                                                                 |
| `[vars.<name>]` | Substitutions for one environment, over `[vars]`.                                                                 |
| `[env.<name>]`  | Variables for one environment, over `[env]`. Variables it does not mention are inherited.                         |

Environment names use letters, digits, `-` and `_`. Variable and substitution names use letters, digits and `_`, not starting with a digit.

## Values

| Written as                                                    | Meaning                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `development`, `"two words"`, `'raw $text'`                   | A literal. Quote it if it has spaces or `#`. A quoted value is always a literal, even `"secret(\"x\")"`.              |
| `resource("<plugin>/<type>", "<name>", "<output>")`           | An output of the synced resource with that plugin id, resource type id and display name, in the pulling organization. |
| `resource("<plugin>/<type>@<account>", "<name>", "<output>")` | The same, in the account with that display name. Use when two accounts have a resource of that name.                  |
| `resource("<id>", "<output>")`                                | An output of one resource by its id (`plugin:account:external-id`). Only resolves in the organization that owns it.   |
| `secret("<NAME>")`                                            | The organization secret with that name (the same store Infrawrench workflows use).                                    |

Arguments are double-quoted strings with `\"` and `\\` escapes. Plugin ids, type ids and output keys come from `list_env_sources` (or the Infrawrench app's picker); never invent them.

## Substitutions

`${name}` inside the arguments of `resource()` and `secret()` is replaced before lookup. Values, lowest first: `[vars]`, the built-in `environment` (the environment being pulled), `[vars.<environment>]`, then `--var name=value`. A name with no value is a problem on that variable. Substitution never applies to literals: `HINT = ${HOME}` stays as written. `$${` is a literal `${` inside a reference.

## Resolution

- Pulling `--env production` gives `[env]` with `[env.production]` laid over it; no `--env` gives `[env]` alone.
- A variable whose source fails (no match, several matches, no value, a provider error) is reported with its line and left out of `.env`; the rest are written.
- In Infrawrench CI, a job's `env-file:` key loads the file, but only resources the repository is granted and the repository's CI secrets resolve there.
