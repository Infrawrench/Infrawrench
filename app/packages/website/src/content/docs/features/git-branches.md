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

## Branches

Every branch of a repository other than its default branch has a page, where it is read, reviewed and merged. The first push of a branch opens its page as a draft against the default branch, titled after the commit when there is one, or after the branch's name. Edit its title and description and click **Ready for review** when it is. A page you close is not opened again by the next push.

The **Branches** tab lists the pages of the repository, open, merged and closed, one line each: where its review stands, its title, its branch, its labels, the people on it and when it last moved. The search box and the filters work as they do for issues. The same tab is where the repository's branches themselves are managed.

<insert [A repository's Branches tab on git.infrawrench.com: the top bar reading "acme / infra" with a lock and Branches current, the open, merged and closed filter, two one-line rows of open branches with their state icons, and one row marked "from fork"] here>

A branch's page is at its name: `git.infrawrench.com/acme/infra/branches/feature/rate-limits`. From the top it shows the title, what the branch needs next, the ask it was started from, its versions (one for each push), and the diff with the changed files beside it. Findings, the merge box and the conversation follow, with the agent, instructions, reviewers and labels beside them. The page has three tabs:

| Tab         | What it shows                                                         |
| ----------- | --------------------------------------------------------------------- |
| **Review**  | The versions, the diff, findings, the merge box and the conversation. |
| **Commits** | The commits it would merge.                                           |
| **Checks**  | [CI](./ci.md) runs and commit statuses for its latest commit.         |

<insert [A branch's page on git.infrawrench.com: the title and the line under it with the branch and its base, the version strip with three versions, the diff with the file tree beside it and an inline comment thread, and below it the merge box showing "1 of 1 required approval" and "No conflicts with main"] here>

Each push to the branch makes a new version and updates the page: its commits, its diff and whether it still merges cleanly. The diff can show the whole change, what one version changed, or everything since the version you last marked as reviewed.

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

Review agents run for repositories an organization owns, and what they use counts toward that organization's [AI usage](../team-and-billing/billing-and-plans.md#ai-usage). When the organization has reached its AI budget for the month, a review is skipped and says so. A reviewer of your own can report findings through the API under its own name, in any repository: its findings are listed on the branch's page whether or not review agents are turned on.

### Merge

The merge box lists what stands in the way: missing approvals, failing required checks, conflicts with the base branch, open must-fix findings. When the base has moved on, **Update branch** brings it into the branch.

| Method           | What lands on the base branch                                           |
| ---------------- | ----------------------------------------------------------------------- |
| **Merge commit** | The branch's commits, joined by a merge commit.                         |
| **Squash**       | One commit with all the changes, titled with the page's title.          |
| **Rebase**       | The branch's commits replayed on top of the base, with no merge commit. |

You can edit the commit title and message before confirming a merge commit or a squash. **Delete branch after merge** removes the branch. An administrator chooses which methods a repository offers, and the default, under **Settings > General**.

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

- Repositories of an organization on a paid plan run [Infrawrench CI](./ci.md) on every push from the pipelines in `.infrawrench/ci/`. Results show on a branch's **Checks** tab, beside each commit, and under the repository's **CI** tab. Repositories in a personal namespace do not run CI.
- A repository with [Terraform workspaces](./git-terraform.md) plans each branch that touches one and shows the plan on the branch's page.
