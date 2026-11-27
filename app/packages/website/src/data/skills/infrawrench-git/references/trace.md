# Recording a trace

`record_trace` takes `repository` (`owner/name`), `branch` (not the default branch) and one or more `entries`, in the order they happened. Send several in one call. The branch does not have to exist yet.

## Kinds

| Kind       | Record it when                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `ask`      | Once, at the start: what you were asked to do, in the person's words.                                |
| `step`     | After each meaningful piece of work: what you changed and why, with `anchors` to the files.          |
| `decision` | You chose between alternatives: what you chose, what you rejected and why.                           |
| `evidence` | You ran tests, a build, a linter or any check: the command, its exit code, the output. Failures too. |
| `doubt`    | You are unsure, skipped something, or could not verify something. Reviewers read these first.        |
| `note`     | Anything else a reviewer should know.                                                                |

## An entry

| Field        | Value                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `kind`       | One of the kinds above.                                                                                                       |
| `body`       | Markdown, a few sentences: what and why. At most 32 KB.                                                                       |
| `anchors`    | The files and lines the entry is about: `[{ "path": "src/db.ts", "start_line": 40, "end_line": 48 }]`. Lines are optional.    |
| `needs_code` | `true` only when a reader has to see the code at the anchor to understand the entry. Defaults to `true` when a line is given. |
| `evidence`   | For `evidence`: `command`, `exit_code`, `output` (an excerpt; past 16 KB its start and end are kept), `ci_run_id` or `url`.   |

```json
{
  "repository": "acme/infra",
  "branch": "feature/rate-limits",
  "entries": [
    { "kind": "ask", "body": "Limit sign-in attempts to five a minute per address." },
    {
      "kind": "decision",
      "body": "Counted in Postgres, not in memory: the API runs on several instances.",
      "anchors": [{ "path": "src/auth/limits.ts", "start_line": 12, "end_line": 30 }],
      "needs_code": false
    },
    {
      "kind": "evidence",
      "body": "The new tests pass.",
      "evidence": {
        "command": "pnpm test src/auth",
        "exit_code": 0,
        "output": "Tests  14 passed (14)"
      }
    },
    {
      "kind": "doubt",
      "body": "Addresses behind one proxy share a limit. I did not change how the address is read."
    }
  ]
}
```

## How it reaches the page

- Entries wait on the branch and are attached to the version the branch's **next push** makes. Record first, push after. Entries recorded after a push belong to the next one.
- A branch holds at most 1,000 entries waiting for a push, and entries nobody pushes after are dropped after 30 days.
- A note shows the lines it is about under its text when `needs_code` is true. Most decisions and doubts stand on their own: leave it `false` for those, even when they have an anchor. Every entry with an anchor hangs on its lines in the file's diff either way.
- Recording needs write access to the repository.

## Secrets

Every entry is masked before it is stored: known token formats, private key blocks, passwords in URLs, `Authorization` and `Cookie` headers, values given to names such as `TOKEN` or `PASSWORD`. That catches mistakes; it cannot know a secret that has no shape and no name. Do not paste a command's output without reading it, and never record a secret on purpose.

## Instructions

`list_instructions` lists what is still to do (`queued` and `delivered`). An instruction is a review comment, a finding or a reviewer's own words, written out as it was when sent. For each one: `mark_instruction_delivered` when you take it on, then do the work, record it, and call `mark_instruction_answered` just before you push (leave `version` out and it is tied to the version that push makes). A `must_fix` finding on a branch you are named as the agent of arrives as an instruction on its own, whether a reviewer or a CI job raised it.
