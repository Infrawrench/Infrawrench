---
title: Issues and pull requests
description: Track work with issues, review and merge pull requests, protect branches and work from forks on git.infrawrench.com.
sidebar_order: 8
---

Every repository on [git.infrawrench.com](./git-getting-started.md) has **Issues** and **Pull requests** tabs. Either can be switched off under the repository's **Settings > General**.

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

`close`, `fix` and `resolve` work, with their `-s` and `-d` forms. The issue's timeline links to the commit. A squash merge puts the pull request's description in its commit message, so `Closes #12` in a description closes the issue when the pull request is squashed.

## Pull requests

Push a branch, then open **Pull requests > New pull request** (or **Compare** on a branch) and pick the **base** branch to merge into and the branch to **compare**. The page says whether it merges without conflicts and shows the commits and the diff before you create anything. Tick **Draft** for a pull request that is not ready to merge.

<insert [A pull request's Conversation tab: the description, an approving review with two inline comment threads on changed lines, the merge box showing "1 of 1 required approval" and "No conflicts with main", and the Reviewers sidebar] here>

A pull request has four tabs:

| Tab               | What it shows                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| **Conversation**  | The description, comments, reviews, events and the merge box.                                          |
| **Commits**       | The commits it would merge.                                                                            |
| **Checks**        | [CI](./ci.md) runs and commit statuses for its latest commit.                                          |
| **Files changed** | The diff, unified or split, with a file tree, **Hide whitespace** and a **Viewed** tick for each file. |

### Review

On **Files changed**, click a line's number to comment on it. **Add single comment** posts it at once. **Start a review** keeps it pending with the comments that follow, until you click **Finish review** and choose a verdict:

- **Comment**: feedback with no verdict.
- **Approve**: counts toward the approvals a protected branch requires.
- **Request changes**: blocks the merge on a protected branch that requires approvals, until you approve or the review is dismissed.

**Review changes** on the Conversation tab submits a verdict without inline comments. You cannot approve or request changes on your own pull request. Each thread has **Reply** and **Resolve**, and the sidebar counts the ones still unresolved.

<insert [A pull request's Files changed tab in split view: the file tree on the left with comment counts, an inline comment thread under a changed line with Reply and Resolve, and the Finish review button showing two pending comments] here>

### Merge

The merge box lists what stands in the way: missing approvals, failing required checks, conflicts with the base branch. When the base has moved on, **Update branch** brings it into the pull request.

| Method           | What lands on the base branch                                                     |
| ---------------- | --------------------------------------------------------------------------------- |
| **Merge commit** | The pull request's commits, joined by a merge commit.                             |
| **Squash**       | One commit with all the changes, titled with the pull request's title and number. |
| **Rebase**       | The pull request's commits replayed on top of the base, with no merge commit.     |

You can edit the commit title and message before confirming a merge commit or a squash. **Delete branch after merge** removes the head branch. An administrator chooses which methods a repository offers, and the default, under **Settings > General**.

A push to the head branch updates the pull request: its commits, its diff and whether it still merges cleanly.

## Protected branches

A rule under **Settings > Branches** protects every branch its pattern matches (`main`, or a glob such as `release/*`).

| Setting                                               | Effect                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Changes arrive by pull request only**               | A direct push to the branch is refused.                                                                    |
| **Required approvals**                                | 0 to 10 approving reviews before a merge. Requiring any also requires a pull request.                      |
| **A push dismisses approvals of the older commits**   | New commits need a fresh approval.                                                                         |
| **Required checks**                                   | Commit statuses that must pass, such as `Infrawrench CI / pull request` or `Infrawrench Terraform / prod`. |
| **Allow force pushes**, **Allow deleting the branch** | Both are refused on a protected branch unless ticked.                                                      |
| **Only chosen people may push or merge**              | Limits the branch to the people you pick.                                                                  |
| **Administrators are bound by this rule too**         | Without it, an administrator of the repository can push to the branch and merge without waiting.           |

A refused push says why:

```
! [remote rejected] main -> main (protected branch: changes must be made through a pull request)
```

Administrators are exempt unless **Administrators are bound by this rule too** is ticked: they see **Merge without waiting for the requirements** in the merge box and can push over SSH. An [access token](./git-getting-started.md#access-tokens) never administers, so a push over HTTPS with a token is bound by the rule even when the token is an administrator's.

<insert [Settings > Branches with the Add rule form open: the pattern "main", Changes arrive by pull request only ticked, Required approvals set to 1, and the Required checks picker] here>

## Forks

**Fork** copies a repository into a namespace you can create repositories in. The fork has its own branches and settings and shares nothing with the original afterwards. Its page links back to where it came from.

To propose a change from a fork:

1. Push a branch to your fork.
2. On the original repository, open **Compare**, switch the head repository to your fork and pick the branch. The head reads `you:branch`.
3. Click **Create pull request**.

The pull request lives in the original repository, where it is reviewed and merged like any other.

A fork of a private repository stays private and within the reach of the same owner. A fork made under the same owner starts with the original's collaborators and their roles; after that, each repository's list changes on its own. A pull request from a fork never gets the base repository's CI secrets, and its Terraform changes are [never planned](./git-terraform.md#plans-on-pull-requests).

<insert [The Compare page of a repository with the head repository switched to a fork: base main, head "second/hello" and branch "divide", "Merges cleanly", one commit and its diff, and the Create pull request button] here>

## CI and Terraform on pull requests

- Repositories of an organization on a paid plan run [Infrawrench CI](./ci.md) on every push and pull request from the pipelines in `.infrawrench/ci/`. Results show on the **Checks** tab, beside each commit, and under the repository's **CI** tab. Repositories in a personal namespace do not run CI.
- A repository with [Terraform workspaces](./git-terraform.md) plans each pull request that touches one and shows the plan in the timeline.
