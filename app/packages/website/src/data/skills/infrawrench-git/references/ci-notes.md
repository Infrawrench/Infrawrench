# Notes from a CI job

A job of a repository on git.infrawrench.com leaves notes on the branch page of the commit it ran on by printing one line per note, to its output or its errors. Nothing else is needed: no token, no API call, no tool.

```
::must-fix file=src/db.ts,line=42,title=Unbounded query::This read has no LIMIT.
::doubt file=src/retry.ts,line=12::Is three attempts enough for a cold start?
```

The line starts at its first character with `::`, the command, a space and the parameters when there are any, `::`, then the message. An indented line, or a command in the middle of a line, is not read.

## Commands

| Command        | Becomes                                                            |
| -------------- | ------------------------------------------------------------------ |
| `::must-fix`   | A finding that must be fixed. While it is open it holds the merge. |
| `::should-fix` | A finding that should be fixed.                                    |
| `::note`       | A finding that is a note.                                          |
| `::doubt`      | A trace entry of kind `doubt`.                                     |
| `::decision`   | A trace entry of kind `decision`.                                  |
| `::step`       | A trace entry of kind `step`.                                      |
| `::evidence`   | A trace entry of kind `evidence`.                                  |

There is no `::ask` and no trace `note`: `::note` is the finding. Other names after `::` (`::group::`, `::error`) are other tools' commands and are left alone, so a typo in a command's name is silently not a note.

## Parameters

| Parameter    | Value                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`       | A path from the repository's root (`src/db.ts`). Not absolute, no `..`. Left out, the note is about the whole change.                        |
| `line`       | The line, from 1, in the file as it is at the run's commit. Needs `file`.                                                                    |
| `end_line`   | The last line of a range. Needs `line`, and is not before it.                                                                                |
| `title`      | A finding's title (up to 200 characters), or a bold first line on a trace entry. Without one, a finding's title is its message's first line. |
| `needs_code` | `true` or `false`: show the lines under the note's text. Left out, it is `true` when there is a `line`.                                      |

Parameters are separated by commas, each given once, in any order. All are optional. A finding with a `title` may have an empty message; a trace entry needs a message.

## Escapes

| Write | For                                        |
| ----- | ------------------------------------------ |
| `%25` | `%`                                        |
| `%0A` | A line break (`%0D` for a carriage return) |
| `%3A` | `:` in a parameter's value                 |
| `%2C` | `,` in a parameter's value                 |

Escape `%` first, then the others, whenever the text comes from a tool's output. A message needs only `%25`, `%0A` and `%0D`; a parameter's value needs all of them.

## What happens to them

- **Where.** On the open branch page of the run's commit, on the version that commit's push made. A run on a branch with no open page (the default branch, a schedule) leaves nothing, and so does a run of a commit the branch has been force pushed past.
- **Findings** are reported by the reviewer `ci:<pipeline>/<job>`, with a link to the line of the job's log that printed them.
- **The same finding on the next push is the same finding.** It is told apart by job, `file` and title, never by line. So keep titles stable: use the rule's id (`no-explicit-any`), not a sentence with a line number or a count in it. A finding a person dismissed stays dismissed.
- **A passing job marks fixed** what it reported before and did not print this time. A failing job fixes nothing, so a job that reports and then fails keeps its findings open until a later run passes without them.
- **Trace entries** of a job are replaced when the job runs again on the same commit. A run of a branch proposed from a fork leaves findings only.
- **A must-fix** holds the merge like any must-fix, and is sent to the agent that writes the branch as an instruction.

## Limits

- 100 notes per job, 1,000 per run. Print the worst first when a tool can report more.
- A message is at most 8 KiB after its escapes are read; a `file` at most 1,024 characters.
- A command over a limit, or a malformed one (a parameter not in the table, a `line` that is not a number, a `file` outside the repository, no message), leaves no note. The job's reason on the run's page counts them: `2 note commands ignored (2 malformed).` Check it after the first run of a new job.

## Secrets

The commands are read from the run's log as it is stored, where the organization's secrets are already `***`, and each note is masked again by shape before it is kept. Everyone who can read the repository reads the notes, so never print a secret, and do not print what one protects (a customer's record, a private URL).

## A linter's JSON as notes

On a Linux machine (`platform: linux`), whose image has `jq`:

```yaml
name: lint
on:
  pull-request: {}
jobs:
  eslint:
    platform: linux
    run: |
      npm ci
      status=0
      npx eslint . --format json --output-file eslint.json || status=$?
      jq -r --arg root "$PWD" '
        def esc: gsub("%"; "%25") | gsub("\r"; "%0D") | gsub("\n"; "%0A");
        def param: esc | gsub(":"; "%3A") | gsub(","; "%2C");
        .[]
        | (.filePath | ltrimstr($root + "/")) as $file
        | .messages[]
        | (if .severity == 2 then "must-fix" else "should-fix" end) as $command
        | (if .line then ",line=\(.line)" else "" end) as $line
        | "::\($command) file=\($file | param)\($line),title=\(.ruleId // "eslint" | param)::\(.message | esc)"
      ' eslint.json
      exit "$status"
```

In a sandboxed environment (`using: env:bash-node@24`), which has no `jq`, the same with Node:

```yaml
jobs:
  eslint:
    using: env:bash-node@24
    run: |
      status=0
      pnpm exec eslint . --format json --output-file eslint.json || status=$?
      node -e '
        const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
        const param = (s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
        const root = process.cwd() + "/";
        for (const file of JSON.parse(require("fs").readFileSync("eslint.json", "utf8"))) {
          const path = file.filePath.startsWith(root) ? file.filePath.slice(root.length) : file.filePath;
          for (const m of file.messages) {
            const command = m.severity === 2 ? "must-fix" : "should-fix";
            const line = m.line ? `,line=${m.line}` : "";
            console.log(`::${command} file=${param(path)}${line},title=${param(m.ruleId ?? "eslint")}::${esc(m.message)}`);
          }
        }
      '
      exit "$status"
```

Both print the notes whether or not the linter passed, then end with the linter's own status, so the job still fails when it should. Write the report to a file and read the file: in a sandboxed environment a pipe reports only its last command's status.
