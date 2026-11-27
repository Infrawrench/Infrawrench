# git.infrawrench.com and Infrawrench CI

git.infrawrench.com is a Git forge where a branch is reviewed as a record of versions. Every push to a branch that is not the default branch makes a version, and the branch's page shows what there is to read about that version before its code: what the agent that wrote it recorded (its trace), what reviewers and CI jobs found (findings), and what reviewers sent back (instructions). There are no pull requests to open: a branch gets its page at its first push.

You are in such a repository when `git remote -v` names `git.infrawrench.com`. The user-facing guides are https://infrawrench.com/docs/features/git-branches and https://infrawrench.com/docs/features/git-agents-and-mcp. Read the files under `references/` when a step below says so.

## Connect

The forge's MCP server is `https://git.infrawrench.com/mcp`, usually added under the name `infrawrench-git`. If its tools (`record_trace`, `get_branch`, ...) are not available, tell the user how to add it: `references/connect.md` has the command for Claude Code, Codex and Cursor. Call `whoami` once when you are unsure whether you can write. Tools take a repository as `owner/name` and a branch by its name.

## When you write code on a branch

1. **Start.** Given a task with no branch yet, call `start_work` with the ask: it makes the branch and its page, as a draft. Then `git fetch origin && git switch <branch>`. If a branch already exists, check it out and call `get_branch` to see where it stands.
2. **Record as you work**, with `record_trace`, not only at the end. `references/trace.md` has the kinds and their fields. In short: one `ask`, a `step` for each piece of work, a `decision` when you chose between alternatives, `evidence` whenever you ran a check (the command, its exit code, the lines of output that show the result, failures too), and a `doubt` for anything you are unsure of, skipped or could not verify. Reviewers read doubts first.
3. **Record before you push.** Entries wait on the branch and are attached to the version the next push makes. Then `git push`.
4. **After a push**, call `get_branch` for the branch's state, `list_instructions` for what reviewers sent back and `list_findings` for what reviewers and CI found.
5. **Answer instructions.** For each one you take on: `mark_instruction_delivered`, do the work, record it, `mark_instruction_answered`, then push. If you decide not to do what was asked, record why (a `decision` or a `doubt`) and still mark it answered.
6. **Fix what must be fixed.** An open `must_fix` finding holds the branch's merge until it is fixed, dismissed by a person, or overridden by an administrator. You cannot dismiss or override one: fix it and push, or record a `doubt` saying why you think it is wrong.

## When you review a branch

Read the change with `get_branch` and `get_version_diff`, then call `report_finding`: a `severity` (`must_fix` only for what must not merge, `should_fix`, `note`), a short `title`, a `body`, the `path` and lines, and `evidence`. Set `complete: true` when the list is everything you find on that version, so your earlier findings that are not in it are marked fixed. Report under a `reviewer` name of your own (`claude-review`).

## Infrawrench CI

A repository's pipelines are the YAML files in `.infrawrench/ci/`. They run on every push and on each branch page's new version, and their results are on the branch's **Checks** tab. A pipeline has `name:`, `on:` (`push`, `pull-request`, `schedule`, `manual`) and `jobs:`; a job is one script (`run:`) in an environment (`using: env:bash-node@24`) or on a Linux machine (`platform: linux`). Do not guess the rest: the guide is https://infrawrench.com/docs/features/ci and every key is in `ci-runner/README.md` of the Infrawrench repository.

A CI job can put notes on the branch's page by printing lines, with no token and no API call:

```
::must-fix file=src/db.ts,line=42,title=Unbounded query::This read has no LIMIT.
::doubt file=src/retry.ts,line=12::Is three attempts enough for a cold start?
```

`::must-fix`, `::should-fix` and `::note` become findings; `::doubt`, `::decision`, `::step` and `::evidence` become trace entries. Read `references/ci-notes.md` before writing a job that prints them: it has the parameters, the escapes, the limits, what a passing job marks fixed, and a job that turns a linter's JSON report into notes. Use this when a check already runs in CI (a linter, a type checker, a test report); use `report_finding` when you are the reviewer yourself.

## Never

- **Never put a secret in a trace entry, a finding or a CI note.** Tokens, keys and passwords are masked before anything is stored, but masking recognises shapes and names, not every secret, and everyone who can read the repository reads the notes. Leave them out, and do not print what a secret protects.
- **Never report as one of the forge's own reviewers.** `general`, `security`, `tests`, `terraform` and `intent` are refused, and so is any name that starts with `ci:`, which is how Infrawrench CI names a job's findings (`ci:<pipeline>/<job>`). An agent kind of `ci` is refused for a trace in the same way.
- **Never mark an instruction answered for work you did not do**, and never push to the default branch to get around a branch's page.
- **Do not invent pipeline keys or note parameters.** An unknown parameter makes a note command malformed: it is ignored, and the job's reason on the run's page says how many were.
