---
title: Home and your work on git.infrawrench.com
description: The sidebar, the home page, and the lists of your work on git.infrawrench.com, in the branch page layout and in classic, and how to switch between the two.
sidebar_order: 8
---

When you are signed in to [git.infrawrench.com](./git-getting-started.md), a sidebar runs down the left of every page. What it holds depends on your layout: this page describes the default one first, then [classic](#the-classic-sidebar). In the default layout the site opens on your work: the branches that are active in your repositories, the ones waiting on you, and what happened lately.

<insert [The git.infrawrench.com home page for an organisation: the sidebar with Home, Your work and the organisation's repositories, the headline "Your team has 15 active branches", the Your changes and Team changes cards side by side, and Suggested for your review underneath] here>

## The sidebar

- **Workspace**, at the top, is the namespace the home page and the lists are of: one of your organisations, your own namespace, or a namespace you collaborate in. Pick another from its menu. The same menu opens the namespace's page, creates a repository and opens **Explore**. The magnifier beside it searches repositories.
- **Home** is the page described below.
- **Your work** holds **Changes**, **Reviews** and **Mentions**.
- Each namespace you have repositories in is a group that lists them. The current workspace's group is open; click a group's name to fold or unfold it.
- Your name, at the foot, opens your repositories, your stars, **Settings**, the layout switch and **Sign out**.

On a narrow window the sidebar is behind the menu button in the top bar.

## Inside a repository

A repository has no header of its own in this layout. The top bar says where you are, as namespace / repository / page, with a lock beside a private repository's name. To the right are the repository's sections: **Code**, **Issues**, **Branches**, **CI**, **Infrastructure** and **Settings** (on a narrow window, their icons). The star and the fork, each with its count, are at the end of the bar.

**Branches** is the repository's pull requests, one line each: where its review stands, its title, its number and branch, its labels, the people on it and when it last moved. The search box and the filters work as they do for issues. It is called **Pull requests** in the classic layout.

<insert [A repository's Branches list on git.infrawrench.com in the sidebar layout: the top bar reading "acme / infra" with a lock, the sections Code, Issues, Branches, CI, Infrastructure and Settings with Branches current, the star and fork counts, and two one-line rows of open branches] here>

## Home

The headline counts the open pull requests in the workspace. The sentence under it names the repositories that were pushed to in the range picked in the top bar (**Last 24 hours**, **Last 7 days** or **Last 30 days**). The top bar also says how many agents are working, when any is.

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
| **Merged**            | The pull request was merged.                                                       |
| **Closed**            | The pull request was closed without merging.                                       |

A row shows the first line of the pull request's description. A branch that has none shows its head commit's short id instead.

## Changes, Reviews and Mentions

- **Changes** lists every branch of the workspace. Filter by **Open**, **Merged** or **All**, and by **Everyone**, **Mine** or **Team**.
- **Reviews** lists the open branches you have a part in (you wrote it, are assigned, reviewed it, or connected its agent) that have a version you have not marked as reviewed, the longest wait first. A row opens on what changed since the version you reviewed.
- **Mentions** lists comments and review comments by other people that name you with `@username`, in the repositories you have a tie to.

<insert [The Changes page on git.infrawrench.com: the list of a workspace's open branches, each with its state icon, title, first line of the description, repository, author and age, with the Everyone / Mine / Team and Open / Merged / All filters in the top bar] here>

## Branch page or classic

The sidebar described above, this home page and the [branch page](./git-agents.md) are the default layout. **Classic** keeps a sidebar and changes what is in it and beside it: a home page of your repositories and recent pushes, a repository's own header and tabs, and pull requests as conversation, commits, checks and files. Both show the same data at the same addresses.

Switch in any of three places:

- Your name at the foot of the sidebar, under **Open pull requests as**, in either layout.
- The top bar of a branch page, beside the repository's sections.
- **Settings > Review**.

<insert [The account menu at the foot of the git.infrawrench.com sidebar, open: Your repositories, Your stars, Settings, then "Open pull requests as" with Branch page ticked and Classic, then Infrawrench app and Sign out] here>

The choice is yours alone and follows your account. Signed-out visitors see a top navigation bar and no sidebar.

## The classic sidebar

- **Home** is your repositories, recent pushes to them and the repositories you starred.
- **Pull requests** holds **Created** (the ones you opened), **Review requested** (open ones with a version you have not marked as reviewed) and **Assigned**.
- **Issues** holds **Assigned**, **Created** and **Mentioned** (issues whose description or comments name you with `@username`).
- **Explore** lists public repositories.
- Each namespace you have repositories in is a group that lists them, with how many there are and a **+** that creates a repository there.
- Your name, at the foot, opens the same menu as in the default layout.

The pull request and issue lists span every repository you own, collaborate on or reach through an organisation. Each row names its repository. **Open**, **Closed** and **All** in the top bar filter by state. The top bar of other pages has the repository search and **New**.

<insert [git.infrawrench.com in the classic layout: the sidebar with Home, Pull requests (Created, Review requested, Assigned), Issues (Assigned, Created, Mentioned), Explore and the Acme group with its count and plus button, beside the Issues list on the Created view with rows from several repositories] here>
