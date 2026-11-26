---
title: Home and your work on git.infrawrench.com
description: The sidebar, the home page, and the lists of your work on git.infrawrench.com.
sidebar_order: 8
---

A sidebar runs down the left of every page of [git.infrawrench.com](./git-getting-started.md). When you are signed in, the site opens on your work: the branches that are active in your repositories, the ones waiting on you, and what happened lately.

<insert [The git.infrawrench.com home page for an organisation: the sidebar with Home, Your work and the organisation's repositories, the headline "Your team has 15 active branches", the Your changes and Team changes cards side by side, and Suggested for your review underneath] here>

## The sidebar

- **Workspace**, at the top, is the namespace the home page and the lists are of: one of your organisations, your own namespace, or a namespace you collaborate in. Pick another from its menu. The same menu opens the namespace's page, creates a repository and opens **Explore**. The magnifier beside it searches repositories.
- **Home** is the page described below.
- **Your work** holds **Changes**, **Reviews** and **Mentions**.
- Each namespace you have repositories in is a group that lists them. The current workspace's group is open; click a group's name to fold or unfold it.
- The repository you are in opens under its name: **Recent issues**, its five most recently updated open issues, and **Recently edited branches**, the five branches with the latest changes. Each folds like a group.
- Your name, at the foot, opens your repositories, your stars, **Settings** and **Sign out**.

On a narrow window the sidebar is behind the menu button in the top bar.

### Signed out

Someone who is not signed in gets a shorter sidebar: the site's name, **Explore**, the public repository they are reading, and **Sign in** at the foot.

<insert [A public repository on git.infrawrench.com while signed out: the sidebar with the site's name, Explore and the repository, and Sign in at the foot, beside the repository's Code tab] here>

## Inside a repository

A repository has no header of its own. The top bar says where you are, as namespace / repository / page, with a lock beside a private repository's name. To the right are the repository's sections: **Code**, **Issues**, **Branches**, **CI**, **Infrastructure** and **Settings** (on a narrow window, their icons). The star and the fork, each with its count, are at the end of the bar.

**Branches** lists the repository's branch pages, one line each. [Issues and branches](./git-branches.md) has what a branch page holds.

## Home

The headline counts the open branches in the workspace. The sentence under it names the repositories that were pushed to in the range picked in the top bar (**Last 24 hours**, **Last 7 days** or **Last 30 days**). The top bar also says how many agents are working, when any is.

- **Your changes** are the open branches you wrote, or connected an [agent](./git-agents.md) to. **Team changes** are everyone else's. Each card shows the five most recently active, and **See all** opens the full list.
- **Suggested for your review** are other people's open branches, out of draft, with a version you have not marked as reviewed and that you have not already approved. A row says why it is there (you are assigned, you reviewed or commented on an earlier version, or you push to that repository) and roughly how long the change takes to read, from its size.
- **Workspace activity** lists versions pushed, reviews submitted, review runs that found something, and merges, newest first.

A row's icon is the branch's state:

| State                 | When                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| **Agent working**     | An instruction is with the branch's agent, or it has recorded work not pushed yet. |
| **Changes requested** | The newest verdict asks for changes, or a must-fix finding is open.                |
| **Approved**          | The newest verdict approves.                                                       |
| **Needs review**      | None of the above. A draft shows a dashed ring.                                    |
| **Merged**            | The branch was merged.                                                             |
| **Closed**            | The branch's page was closed without merging.                                      |

A row shows the first line of the branch's description. A branch that has none shows its head commit's short id instead.

## Changes, Reviews and Mentions

- **Changes** lists every branch of the workspace. Filter by **Open**, **Merged** or **All**, and by **Everyone**, **Mine** or **Team**.
- **Reviews** lists the open branches you have a part in (you wrote it, are assigned, reviewed it, or connected its agent) that have a version you have not marked as reviewed, the longest wait first. A row opens on what changed since the version you reviewed.
- **Mentions** lists comments and review comments by other people that name you with `@username`, in the repositories you have a tie to.

<insert [The Changes page on git.infrawrench.com: the list of a workspace's open branches, each with its state icon, title, first line of the description, repository, author and age, with the Everyone / Mine / Team and Open / Merged / All filters in the top bar] here>
