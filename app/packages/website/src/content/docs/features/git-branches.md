---
title: Issues and branches
description: Track work with issues, review and merge each branch on its page, protect branches and propose changes from forks on git.infrawrench.com.
sidebar_order: 8
---

Every repository on [git.infrawrench.com](./git-getting-started.md) has **Issues** and **Branches**. Issues can be switched off under the repository's **Settings > General**.

## Issues

Click **New issue**, give it a title and describe it in Markdown (**Preview** shows how it renders). Images from other sites in Markdown are loaded through git.infrawrench.com, so the site hosting an image never sees who is reading. Anyone signed in can open an issue on a repository they can read, and comment on it.

The sidebar of an issue sets its **Assignees**, **Labels** and **Milestone**. Labels and milestones are created under the **Labels** and **Milestones** links at the top of the list. The list filters by author, label, milestone and assignee, and its search box takes the same filters as text, such as `is:closed`.

<insert [A repository's Issues tab: the Open and Closed counts, the Author, Label, Milestone, Assignee and Sort filters, and two open issues with their numbers and comment counts] here>

### Close an issue from a commit

A commit message that names an issue after a closing word closes it when the commit reaches the default branch:

```
Document farewell

Fixes #12
```

`close`, `fix` and `resolve` work, with their `-s` and `-d` forms. The issue's timeline links to the commit. A squash merge puts the branch's description in its commit message, so `Closes #12` in a branch's description closes the issue when the branch is squashed.

### Import issues from GitHub

An administrator of a repository can bring in the issues of a GitHub repository under **Settings > Import**. Enter the GitHub repository as `owner/name`, paste a token and click **Start**. The import runs in the background, and the page shows what it is reading and how much it has written. **Cancel** stops it and keeps what it has written so far.

<insert [A repository's Settings > Import page: the GitHub repository field filled with "acme/widgets", the masked Token field with its hint, the Start button, and below it one import marked Running with "Reading comments" and its counts of issues, comments, labels and milestones, with a Cancel button] here>

**The token** only has to read. Create a fine-grained personal access token on GitHub with access to that one repository and the repository permissions **Issues: Read-only** and **Metadata: Read-only**. It is kept encrypted while the import runs, removed when the import ends (finished, failed or cancelled), and never shown again.

**What is imported**:

- Every issue, open and closed, with its title, its description as written, its labels, its milestone, whether it is locked, and when it was opened, last updated and closed. An issue closed as not planned or as a duplicate is closed as not planned here.
- Every comment on those issues, with when it was written.
- The repository's labels and milestones. A label this repository already has by that name is left as it is. A milestone is matched by its title and takes the state, due date and description it has on GitHub.

**Pull requests are not imported**, and neither are their comments. Merged ones are already in the history you pushed. Reactions and the events between comments (who labelled or closed an issue, and when) are not imported either.

**Numbers.** An issue keeps its GitHub number when nothing here has that number yet, so `#12` in an old description or commit message still points at the same issue. Issues and branch pages share one sequence of numbers, so if a number is already taken, the imported issue gets a new one, placed after the highest number the GitHub repository uses, and its page says **#12 on GitHub**. The numbers that were pull requests on GitHub stay unused: new issues and branch pages are numbered after everything that was imported.

**Authors.** An issue or a comment is shown as written by an account on git.infrawrench.com when either of these is true:

- The email address on the author's public GitHub profile is the address of an account here, or a [commit email](./git-getting-started.md#who-a-commit-is-by) that someone has verified for this repository's organization or, in a person's own repositories, for themselves.
- The author's GitHub username is the username of someone who already has access to the repository: its owner, a member of the organization that owns it, or a collaborator.

Assignees are matched the same way, and one with no account here is left off. Everything else is shown as **name on GitHub**, linked to the original, and every imported issue links to its page on GitHub. Nobody is notified by an import, and `@mentions` in imported text notify nobody.

**Run it again** whenever you like, with a new token each time. A second import of the same GitHub repository adds nothing twice: it reads what changed on GitHub since the last finished import began, updates those issues and comments to match GitHub, and adds the new ones. An issue keeps the number it was given the first time. Only one import runs in a repository at a time.

If GitHub's rate limit is reached, the import waits until the limit resets and carries on from the page it stopped at. If GitHub refuses the token or the repository cannot be found, the import fails and says so, and nothing it wrote is removed.

## Branches

Every branch of a repository other than its default branch has a page, where it is read, reviewed and merged. The first push of a branch opens its page as a draft against the default branch, titled after the commit when there is one, or after the branch's name. Edit its title and description and click **Ready for review** when it is. A page you close is not opened again by the next push.

The **Branches** tab lists the pages of the repository, open, merged and closed, one line each: where its review stands, its title, its branch, its labels, the people on it and when it last moved. The search box and the filters work as they do for issues. The same tab is where the repository's branches themselves are managed.

<insert [A repository's Branches tab on git.infrawrench.com: the top bar reading "acme / infra" with a lock and Branches current, the open, merged and closed filter, two one-line rows of open branches with their state icons, and one row marked "from fork"] here>

A branch's page is at its name: `git.infrawrench.com/acme/infra/branches/feature/rate-limits`. From the top it shows the title, what the branch needs next, the ask it was started from, its versions (one for each push), the notes on the picked version, and its changed files with a tree of them beside. Findings, the merge box and the conversation follow, with the agent, instructions, reviewers and labels beside them. The page has three tabs:

| Tab         | What it shows                                                           |
| ----------- | ----------------------------------------------------------------------- |
| **Review**  | The versions, the notes, the files, the merge box and the conversation. |
| **Commits** | The commits it would merge.                                             |
| **Checks**  | [CI](./ci.md) runs and commit statuses for its latest commit.           |

<insert [A branch's page on git.infrawrench.com: the title and the line under it with the branch and its base, the version strip with three versions, the notes with "Doubts and decisions" first, the list of files all closed with the file tree beside it, and below it the merge box showing "1 of 1 required approval" and "No conflicts with main"] here>

Each push to the branch makes a new version and updates the page: its commits, its diff and whether it still merges cleanly. The diff can show the whole change, what one version changed, or everything since the version you last marked as reviewed.

### Notes before the code

Above the files, the page lists what there is to read about the version, so you can follow the change before opening any of it:

| Group                    | What it holds                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Doubts and decisions** | What the agent was unsure of, then the choices it made. They come first and are marked down the side. |
| **Findings**             | What reviewers and CI jobs found on this version, open ones first.                                    |
| **Comments**             | Review comments on lines of this diff.                                                                |
| **Steps**                | The rest of the agent's record, in the order it was written: the ask, steps, evidence and notes.      |

A note about a file names it, with its lines when it has them: `modules/network/main.tf:101` or `modules/network/main.tf:97-103`. Click that to open the file at those lines.

A note a CI job printed is in the same groups, marked **CI** with the job's name: see [Notes from CI](#notes-from-ci).

A note shows the lines it is about under its text when the code is needed to follow it. An agent says so when it records the note; when it does not say, a note on a line shows its code and a note on a whole file or on nothing does not. Review comments always show their lines.

<insert [The notes on a version of a branch page: under "Doubts and decisions" a doubt with only its text and the label "modules/network/main.tf:108-118", a doubt with three lines of code under it, and a decision marked in another colour with the lines 120 to 125 it is about] here>

### Files

Every file starts closed, as one line: its path, how many notes it has, and its added and removed lines. Files with something to settle come first: the ones with an open must-fix finding, then the files of the agent's record in the order it went through them, then other files with a finding or a comment, then the rest by path. The tree beside them puts a dot on a file with notes, red when one must be fixed.

Click a file's line to open it, or pick it in the tree. **Expand all** and **Collapse all** do it for every file. What you open stays open while you are on the page, across versions and layouts.

A file with notes opens on the lines they are about, with three lines around each. The rest is counted, not shown:

- The bar under the file's name says how much you are looking at, such as **Showing 52 of 77 changed lines**, and **Show full diff** shows all of it. **Show less** goes back.
- Between two parts, a row such as **25 more changed lines** stands for the changed lines left out there. Click it to show them.
- Every note about a file hangs in it too, whether or not its card shows code: an agent's entry above the lines it explains, a finding or a comment under its line, and a note on the whole file at the file's top.

A file with no notes opens whole. Commenting on a line never closes what you had open around it.

<insert [A file opened on a branch page: the bar reading "Showing 52 of 77 changed lines" with the "Show full diff" button, an agent's step above line 131, a row reading "25 more changed lines" with "Show" between two parts of the diff, a finding marked CI under line 174, a doubt above line 181, and four more files closed below with their note counts] here>

### Review

In the diff, click the button beside a line's number to comment on it, or drag it over several lines for a range. **Add single comment** posts it at once. **Start a review** keeps it pending with the comments that follow, until you click **Finish review** and choose a verdict:

- **Comment**: feedback with no verdict.
- **Approve**: counts toward the approvals a protected branch requires.
- **Request changes**: blocks the merge on a protected branch that requires approvals, until you approve or the review is dismissed.

**Review changes** submits a verdict without inline comments. You cannot approve or request changes on a branch you wrote. Each thread has **Reply** and **Resolve**, and the page counts the ones still unresolved.

### Review agents

A repository's administrator can turn on review agents in its settings. From then on, each push to an open branch is read by the reviewers the repository chose:

| Reviewer      | What it looks for                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| **General**   | Whether the change is correct. Also whether the authoring agent's own account matches the diff and the checks. |
| **Security**  | What the change makes exploitable, and how.                                                                    |
| **Tests**     | Whether the tests exercise what changed, and whether CI ran them.                                              |
| **Terraform** | What the plan would destroy, replace or expose.                                                                |
| **Intent**    | Whether the change does what the branch's description asked for.                                               |

A reviewer leaves findings on the lines they are about, each **must fix**, **should fix** or a **note**, with its evidence: the code, a command that reproduces it, or the failing check and its log line. A finding with no evidence is shown folded, as a question. Reviewers never approve or merge.

- An open must-fix finding holds the merge until it is fixed, dismissed, or an administrator overrides it with a reason. A repository can turn the hold off in its settings.
- Dismiss a finding with a reason and it stays dismissed on later pushes. A finding the next push resolves is marked fixed in that version.
- When an agent is named as the branch's author, a must-fix finding is sent back to it as an instruction.
- A branch proposed from a fork is not reviewed on its own: someone with write access asks for the review.

Review agents run for repositories an organization owns, and what they use counts toward that organization's [AI usage](../team-and-billing/billing-and-plans.md#ai-usage). A repository in a personal namespace gets them once its owner [connects the namespace to an organization](./git-getting-started.md#where-your-own-repositories-run), and they count toward that organization's usage in the same way. When the organization has reached its AI budget for the month, a review is skipped and says so. A reviewer of your own can report findings through the API under its own name, in any repository: its findings are listed on the branch's page whether or not review agents are turned on.

### Notes from CI

A job in [Infrawrench CI](./ci.md) can put notes on the branch's page by printing a line for each. They land on the version its run was of, in the same cards and the same places in the diff as any other note, and the findings count in the page's tally.

```
::must-fix file=src/db.ts,line=42,title=Unbounded query::This read has no LIMIT.
::doubt file=src/retry.ts,line=12::Is three attempts enough for a cold start?
```

| Command        | What it becomes                                                                 |
| -------------- | ------------------------------------------------------------------------------- |
| `::must-fix`   | A **must fix** finding. While it is open it holds the merge, like any must-fix. |
| `::should-fix` | A **should fix** finding.                                                       |
| `::note`       | A **note** finding.                                                             |
| `::doubt`      | A doubt, under **Doubts and decisions**.                                        |
| `::decision`   | A decision, under **Doubts and decisions**.                                     |
| `::step`       | A step, under **Steps**.                                                        |
| `::evidence`   | Evidence, under **Steps**.                                                      |

`file`, `line`, `end_line`, `title` and `needs_code` say where a note goes and how it is shown. [Notes on a branch page](./ci.md#notes-on-a-branch-page) in the CI guide has the parameters, the escapes for line breaks, commas and colons, the limits, and a job that turns a linter's report into notes.

<insert [The notes on a version of a branch page with two notes from CI: under "Doubts and decisions" a doubt marked "CI terraform/lint" beside the label "modules/network/main.tf:176", and under "Findings" a Should fix finding titled "DNS is allowed over UDP only" marked "CI terraform/lint" where a reviewer's name would be, with the label "modules/network/main.tf:165-174"] here>

- **Where it came from.** A note from CI shows **CI** and `<pipeline>/<job>`. Click it to open the run's log at the line that printed the note.
- **Fixed by a passing job.** When the job passes without printing a finding it reported before, the finding is marked fixed in that version. A job that fails, is skipped or is cancelled leaves its findings open.
- **Dismissing and overriding** work as for a reviewer's finding: a dismissed finding stays dismissed when the job prints it again, and an administrator can let a merge past an open must-fix with a reason.
- **Sent to the agent.** A must-fix from CI on a branch an agent writes is sent to it as an instruction.
- **Forks.** A run of a branch proposed from a fork leaves findings only. It cannot mark another reviewer's findings fixed, since a job only ever answers for what it printed itself.
- **One repository.** A job writes on a page of the repository it ran for. A fork's own CI never writes on the page its branch has in the original repository.

The names are CI's own: a reviewer that reports through the API cannot call itself `ci:` anything, and an agent cannot record a trace as `ci`.

### Merge

The merge box lists what stands in the way: missing approvals, failing required checks, conflicts with the base branch, open must-fix findings. When the base has moved on, **Update branch** brings it into the branch.

| Method           | What lands on the base branch                                           |
| ---------------- | ----------------------------------------------------------------------- |
| **Merge commit** | The branch's commits, joined by a merge commit.                         |
| **Squash**       | One commit with all the changes, titled with the page's title.          |
| **Rebase**       | The branch's commits replayed on top of the base, with no merge commit. |

You can edit the commit title and message before confirming a merge commit or a squash. **Delete branch after merge** removes the branch. An administrator chooses which methods a repository offers, and the default, under **Settings > General**.

### Merged without the merge box

A branch doesn't have to be merged from its page. When a push brings everything a branch changes into the branch its page is against, the page is marked merged and the branch is deleted, however the change got there: a squash, merge or rebase made on your machine, a cherry-pick, or a fast-forward. The forge goes by the content: the branch counts as merged when merging it again would change nothing, or when one commit makes the same change as the whole branch (the same files, the same lines removed and added), so a squash still counts after later commits edited around it. The page names who pushed and the commit that brought the change in, and keeps its versions, review comments and findings like any merged page.

The branch stays when:

- it was pushed to after the commits the forge checked,
- a protection rule doesn't allow deleting it,
- it is a fork's branch, which is the fork owner's to delete.

A squash that changed the branch on the way in (a conflict resolved differently, a fix-up added) is neither, so it reads as not merged. Merge or close that page yourself.

Deleting a branch ends its page too: merged if its changes are already in the base, closed if not. To carry on with a closed one, restore the branch from its page and reopen it.

### After a merge

A merged branch keeps its page, and the page keeps the record of the work: every version, the trace the agent recorded, the review comments, and every finding with how it was settled. A finding says whether it was fixed and in which version, dismissed and by whom with their reason, still open when the branch was merged, or merged past by an administrator with their reason.

The same record is on the default branch, where the code is:

| Where                 | What it shows                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The merged commit** | A **Review** section: the ask, how many versions the branch went through, and its findings by severity, each with how it was settled.                  |
| **Blame**             | A dot beside the lines a merged branch's findings were about. Hover it for the severity and how the finding was settled; click it to open the finding. |
| **A file**            | **Review history**: the findings merged branches left on that file, the most recent merge first.                                                       |

<insert [A merged commit's page on git.infrawrench.com: the commit header, then the Review section with "2 versions", the ask, and findings grouped under Must fix, Should fix and Note, one marked "Fixed in v2", one "Merged past it" with the administrator's reason, one "Dismissed" with its reason] here>

Blame marks a line only when it can tell the line is the one the finding was about. A finding whose lines have changed since is counted in the file's header instead, and listed under **Review history**.

Thirty days after a branch is merged or deleted, the commits of its versions stop being kept. The versions stay in the strip with everything recorded on them. The newest version of a merged branch still shows the whole change, read from the commit it was merged as. An older version's own diff says that its commits are no longer kept.

## Protected branches

A rule under **Settings > Branches** protects every branch its pattern matches (`main`, or a glob such as `release/*`).

| Setting                                               | Effect                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Changes arrive through a branch page only**         | A direct push to the branch is refused.                                                          |
| **Required approvals**                                | 0 to 10 approving reviews before a merge. Requiring any also requires a branch page.             |
| **A push dismisses approvals of the older commits**   | New commits need a fresh approval.                                                               |
| **Required checks**                                   | Commit statuses that must pass, such as `Infrawrench Terraform / prod`.                          |
| **Allow force pushes**, **Allow deleting the branch** | Both are refused on a protected branch unless ticked.                                            |
| **Only chosen people may push or merge**              | Limits the branch to the people you pick.                                                        |
| **Administrators are bound by this rule too**         | Without it, an administrator of the repository can push to the branch and merge without waiting. |

A refused push says why, for example:

```
! [remote rejected] main -> main (protected branch: changes must arrive through a branch page)
```

Administrators are exempt unless **Administrators are bound by this rule too** is ticked: they see **Merge without waiting for the requirements** in the merge box and can push over SSH. An [access token](./git-getting-started.md#access-tokens) never administers, so a push over HTTPS with a token is bound by the rule even when the token is an administrator's.

<insert [Settings > Branches with the Add rule form open: the pattern "main", Changes arrive through a branch page only ticked, Required approvals set to 1, and the Required checks picker] here>

## Forks

**Fork** copies a repository into a namespace you can create repositories in. The fork has its own branches and settings and shares nothing with the original afterwards. Its page links back to where it came from.

A fork's branches get no page of their own when they are pushed. To propose a change to the original repository:

1. Push a branch to your fork.
2. Open the branch in your fork and click **Propose to <original>**, where `<original>` is the repository the fork came from.

The branch's page then lives in the original repository, among its branches with a "from fork" marker, and is reviewed and merged like any other. Its address names the fork: `git.infrawrench.com/acme/infra/branches/you/infra:feature/a`.

<insert [A branch of a fork on git.infrawrench.com with the Propose to acme/infra button, and the branch's page in acme/infra afterwards with the "from fork" marker beside the branch name] here>

A fork of a private repository stays private and within the reach of the same owner. A fork made under the same owner starts with the original's collaborators and their roles; after that, each repository's list changes on its own. A branch proposed from a fork never gets the original repository's CI secrets, and its Terraform changes are [never planned](./git-terraform.md#plans-on-branches).

## CI and Terraform on branches

- Repositories of an organization on a paid plan run [Infrawrench CI](./ci.md) on every push from the pipelines in `.infrawrench/ci/`. Results show on a branch's **Checks** tab, beside each commit, and under the repository's **CI** tab. A job can also put [notes on the branch's page](#notes-from-ci). Repositories in a personal namespace run CI once their owner [connects the namespace to an organization](./git-getting-started.md#where-your-own-repositories-run) on a paid plan. When the organization is on the free plan, the repository's **CI** tab, its **Settings > CI** and a branch's **Checks** tab say **Infrawrench CI is part of Pro**, with an **Upgrade to Pro** link to the organization's billing page in the app for its members. A personal namespace that is connected to no organization is pointed to **Settings > Profile** instead.
- A repository with [Terraform workspaces](./git-terraform.md) plans each branch that touches one and shows the plan on the branch's page.
- An agent that works in the repository can learn the branch workflow and the CI note commands from the [git.infrawrench.com and CI skill](./git-agents-and-mcp.md#a-skill-for-your-agent).
