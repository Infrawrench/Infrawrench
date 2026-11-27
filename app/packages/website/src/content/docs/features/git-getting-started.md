---
title: Get started on git.infrawrench.com
description: Sign in to git.infrawrench.com, choose a username and the organization your own repositories run CI in, create an access token, create a repository, and clone and push it over HTTPS.
sidebar_order: 7
---

[git.infrawrench.com](https://git.infrawrench.com) hosts Git repositories with issues, a page for every branch, [CI](./ci.md) and [Terraform state](./git-terraform.md). This page takes you from signing in to your first push. For what an organization sets in the app (its namespace, default visibility and plan limits), see [Git in the app](./git.md).

> **Beta.** git.infrawrench.com is in beta: anyone with an Infrawrench account can sign up, and parts of it are still changing.

## Sign in and choose a username

1. Open [git.infrawrench.com](https://git.infrawrench.com) and click **Sign in**. You sign in with your Infrawrench account, the same one as the app.
2. The first time, you are asked to **Choose a username**. It becomes your personal namespace: your own repositories live at `git.infrawrench.com/<username>/<repository>`.

3. Under **Run CI and review agents in**, pick one of your organizations, or **None**. Your own repositories then run [CI](./ci.md) and [review agents](./git-branches.md#review-agents) in that organization; see [Where your own repositories run](#where-your-own-repositories-run). When exactly one of your organizations is on a paid plan it is already selected; otherwise you choose.

Usernames use letters, digits, dots, dashes and underscores, are at most 39 characters, and cannot end in `.git`. The field tells you whether a name is available as you type.

A username of 6 characters or fewer costs $50, paid once. Longer usernames are free. When you type a short one the page shows the price and the button becomes **Continue to payment ($50)**. The name is kept for you for 30 minutes while you pay by card, and you come back to git.infrawrench.com with the username yours. If someone else gets the name before your payment goes through, the payment is refunded automatically.

<insert [The Choose a username page with a four-letter username typed: "Available" and "$50, paid once" under the field, and the button reading "Continue to payment ($50)"] here>

You can change your username later under **Settings > Profile**. Addresses of your repositories change with it and the old ones stop working, so update your remotes afterwards. Changing to a username of 6 characters or fewer costs $50 as well; keeping the one you have, or changing only its capitalization, costs nothing. Organization names are never charged for, whatever their length.

<insert [The Choose a username page on git.infrawrench.com after the first sign-in: the Username field filled in with "Available" under it, the "Run CI and review agents in" menu set to an organisation, and the Continue button] here>

### Where your own repositories run

A repository in your own namespace belongs to you, not to an organization, so on its own it has no plan to run CI on and no AI budget for review agents. Connecting your namespace to an organization you belong to gives it both:

- **CI** runs for your repositories on that organization's plan, which must be a paid one. The runs count toward its [CI usage](./ci.md#usage-and-billing) and appear in its **CI** tab in the app, where members who can see CI there can read them and their logs, including those of your private repositories.
- **Review agents** can be turned on in your repositories, and what they use counts toward that organization's [AI usage](../team-and-billing/billing-and-plans.md#ai-usage).
- **Secrets and variables** are your namespace's and your repositories' own. The organization's secrets never reach your repositories. They are edited in the organization's **CI** tab in the app, which the repository's **Settings > CI** links to.
- **Connections, SSH keys and resources** the organization lends to CI for every repository are not lent to yours. An administrator there can lend one to a repository of yours by adding it by name, `git.infrawrench.com/<username>/<repository>`, under [CI access](./ci.md#ci-access).

Nothing else changes: the repositories stay yours, members of the organization get no access to them, and your [private repository and storage allowance](./git.md#usage-and-plan-limits) is the same.

Change it at any time under **Settings > Profile**, in the **Infrawrench account** section: pick another organization, or **None** to stop. If you leave the organization, or are removed from it, your repositories stop running there at once.

<insert [Settings > Profile on git.infrawrench.com: the Infrawrench account section with the "Run CI and review agents in" row and its menu open, listing the person's organisations and None] here>

## Namespaces

A repository belongs to a namespace:

| Namespace         | Who it belongs to                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your username     | You. Created when you choose a username.                                                                                                                                                                                                                              |
| An organization's | An Infrawrench organization. Someone with `git:admin` claims it once, on the forge under **Settings > Organisations** or in the app under [**Settings > Git**](./git.md#claim-a-namespace), and it shows on the forge as an owner you can pick. It needs a paid plan. |

Members of an organization get access to its repositories from their [role](../team-and-billing/roles-and-permissions.md): `git:read` reads all of them, `git:write` pushes and creates, `git:admin` changes repository settings.

## Create a repository

1. Open the workspace menu at the top of the sidebar and choose to create a repository.
2. Pick the **Owner** (your username, or an organization you can create repositories in) and type a **Name**.
3. Choose the **Visibility**:
   - **Public**: anyone can read and clone it, signed in or not.
   - **Private**: only people with access can see it. To everyone else it does not exist: its pages, its API and its clone address all answer as a repository that is not there.
4. Leave **Initialise with a README** ticked to start with a first commit, or untick it to push an existing repository. An empty repository's page shows the commands to push to it.

<insert [The New repository page: Owner set to an organization, a name typed in, Private selected, and Initialise with a README ticked] here>

Public repositories are free and unlimited. Private repositories and private storage count against the owner's plan; the numbers are in [Usage and plan limits](./git.md#usage-and-plan-limits). A personal namespace includes 5 private repositories and 1 GiB of private storage.

## Credentials for Git

Git reaches git.infrawrench.com over HTTPS, with an access token as the password. The password of your Infrawrench account is never used for Git.

> **SSH is coming soon.** Cloning and pushing over SSH, SSH keys and deploy keys are not available yet. Use HTTPS for now; this page will say when SSH is on.

### Create an access token

A personal access token is what Git over HTTPS takes as a password. It is also what the [Terraform state backend](./git-terraform.md#state) takes.

1. Go to **Settings > Access tokens** and click **New token**.
2. Give it a name, tick its scopes and choose when it expires. To clone and push, tick both.
3. Copy the token. It starts with `iwg_` and is shown once.

| Scope        | Allows                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `repo:read`  | Clone and fetch the repositories you can read.                                                                                             |
| `repo:write` | Push to the repositories you can push to. For an administrator of a repository, also use its [Terraform state](./git-terraform.md#access). |

A token never does more than you can, and never administers a repository: a rule that only binds non-administrators still binds a push made with a token. **Revoke** stops a token working at once.

<insert [Settings > Access tokens right after creating a token: the new token shown once with a copy button and the note that it is the only time it is shown, above the list of tokens with scopes, expiry and last use] here>

An organization's Infrawrench [API key](../team-and-billing/api-keys.md) (`iwk_`) is also accepted as the password, for that organization's repositories and with the key's own role.

### Save the token in Git

The first time Git needs credentials for git.infrawrench.com it asks for a username and a password: type your username and paste the token. A credential helper stores them so Git does not ask again.

| System  | Helper                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS   | `git config --global credential.helper osxkeychain` (Git from Xcode or Homebrew already uses it). The token is kept in the login keychain. |
| Windows | Git for Windows comes with Git Credential Manager, which is on by default and keeps the token in Windows Credential Manager.               |
| Linux   | Git Credential Manager, or `git config --global credential.helper libsecret` where the libsecret helper is installed.                      |

To set the token without being asked, for example on a server or in a script:

```
printf 'protocol=https\nhost=git.infrawrench.com\nusername=<username>\npassword=<token>\n\n' | git credential approve
```

To replace a revoked or expired token, remove the stored one and push again; Git asks for the new one:

```
printf 'protocol=https\nhost=git.infrawrench.com\n\n' | git credential reject
```

A CI job or another automated client can also send the token as a header instead of storing it: `git -c http.extraHeader="Authorization: Bearer <token>" clone https://git.infrawrench.com/<owner>/<repository>.git`.

## Clone and push

The **Clone** button on a repository's page shows its address.

### Clone

```
git clone https://git.infrawrench.com/<owner>/<repository>.git
```

A public repository clones without credentials. A private one needs a token with `repo:read`.

### Push an existing repository

```
git remote add origin https://git.infrawrench.com/<owner>/<repository>.git
git push -u origin main
```

If the repository already has a remote pointing elsewhere, `git remote set-url origin https://git.infrawrench.com/<owner>/<repository>.git` points it here instead.

Branches and tags are what you can push. When a push is refused, Git prints the reason after `remote:` or beside the ref, for example a [protected branch](./git-branches.md#protected-branches) or a [storage limit](./git.md#usage-and-plan-limits).

### Push a long history

One push over HTTPS carries at most 100 MB. To bring over a repository with a long history, push it in parts, oldest first, each part a commit further along the branch:

```
git push origin <older-commit>:refs/heads/main
git push origin <later-commit>:refs/heads/main
git push -u origin main
```

`git rev-list --reverse main | awk 'NR % 2000 == 0'` lists every 2,000th commit, which is usually a good size for each part. Tags go last: `git push origin --tags`.

## Browse a repository

<insert [A repository's Code tab: the branch picker, the file table with each entry's last commit, the README rendered below, and the About panel with stars, forks and size] here>

- **Code** lists files with the last commit that touched each one, and renders the README. Open a file for syntax highlighting, **Raw**, **Blame** and its **History**.
- The branch picker switches between branches and tags. **Branches** lists each branch by its [page](./git-branches.md#branches), and **Tags** lists the tags.
- **Commits** shows history, with each commit's [author and co-authors](#who-a-commit-is-by). A commit's page shows its diff, unified or split.
- **Compare** shows what one branch or tag has that another does not.
- **Clone > Download ZIP** or **TAR.GZ** downloads the files at the branch or tag you are looking at.
- **Star** keeps a repository in your stars, under your name at the foot of the sidebar. **Explore** and the sidebar's search find public repositories and the private ones you can read.

<insert [A file's page on the Code tab: the path, the last commit, line numbers with syntax highlighting, and the Raw, Blame and History buttons] here>

## Who a commit is by

A commit carries a name and an email address, written by whoever made it. The forge shows the person behind the address instead of the written name, with their picture and a link to their page, wherever a commit is listed: the **Commits** tab, a commit's page, **Blame**, a file's last commit and a branch page. It reads the author, the committer and every `Co-authored-by:` line at the end of the message, and shows co-authors beside the author.

An address is matched in this order:

1. **A bot account.** Commits made with a coding tool carry the tool's own address, and are shown as that tool's account whatever name the commit wrote:

   | Account    | Address                  |
   | ---------- | ------------------------ |
   | **Claude** | `noreply@anthropic.com`  |
   | **Cursor** | `cursoragent@cursor.com` |

   A bot account has a page (`git.infrawrench.com/claude`, `git.infrawrench.com/cursor`) with a **Bot** badge and nothing else. Nobody can sign in as one, take its username, add it as a collaborator or mention it.

2. **The address on your Infrawrench account**, everywhere on the forge, once you have a username.
3. **A commit email you verified in the repository's organization**, described below.

An address that matches none of these is shown with the name the commit wrote.

<insert [A repository's Commits tab on git.infrawrench.com: one commit by a person with Claude as co-author showing both pictures and "jonas and Claude", one by Cursor alone, and one with two co-authors reading "mara and 2 others"] here>

<insert [The Claude bot account's page on git.infrawrench.com: the Claude icon, the name with a Bot badge, the username under it, and the line "Commits made with Claude are attributed to this account."] here>

### Commit emails in an organization

If some of your commits in an organization's repositories were made with another address, such as an old work address or the one on a laptop you no longer use, add it as a commit email in that organization:

1. Open the account menu and go to **Settings > Organisations**.
2. Under the organization, in **Commit emails in _organization_**, type the address and click **Add**. It is listed as **Pending**.
3. A message with a code is sent to the address, usually within a minute. It names you and the organization.
4. Type the code beside the address and click **Verify**. It is now **Verified**.

From then on, commits with that address are shown as yours in that organization's repositories. A few rules:

- **It applies in that organization only.** The same address in another organization's repositories, in your own namespace or in anyone else's is unaffected, and someone else can verify the same address in a different organization. A repository in your own namespace that [runs in the organization](#where-your-own-repositories-run) does not count as the organization's.
- **Nothing changes until the code is entered**, and only you can enter it, signed in. The code works once, for 24 hours, and for five wrong tries. **Send again** sends a new one, at most once a minute.
- **One member per address.** An address that is on another member's account, or that another member has verified, is refused. A bot account's address is refused too.
- **It stops when you leave.** If you leave the organization or are removed from it, your commit emails there stop applying at once.
- You can have up to 10 in each organization. **Remove** takes one away, verified or not.

Commit emails need an organization with a [namespace](#namespaces). They are set from a signed-in browser, not with an access token.

<insert [Settings > Organisations on git.infrawrench.com: an organisation's row with "Commit emails in Acme" under it, one address marked Verified, one marked Pending with its code field, Verify and Send again buttons, and the field to add another address] here>

## Repository settings

Administrators of a repository get a **Settings** tab:

| Section                    | What it holds                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **General**                | Name, description, topics, default branch, whether issues are on, merge methods, visibility, archive, transfer, delete. |
| **Collaborators**          | People added to this repository alone, each with a role: **Read**, **Triage**, **Write** or **Admin**.                  |
| **Branches**               | [Protected branches](./git-branches.md#protected-branches).                                                             |
| **Labels**, **Milestones** | What issues and branch pages can be filed under.                                                                        |
| **CI**                     | Whether [Infrawrench CI](./ci.md) runs for this repository, and its pipelines.                                          |

Renaming or transferring a repository changes its address. Archiving makes it read-only for everyone until it is unarchived.

<insert [A repository's Settings > General page: the name and description fields, the default branch picker, the merge method checkboxes, and the danger zone with Make private, Archive, Transfer and Delete] here>

## Skills for your coding agent

Two skills teach a coding agent to work here. Add them from their cards: **Add it to your agent** shows the files for Claude Code, Cursor, GitHub Copilot and Codex.

- **git.infrawrench.com and CI** covers connecting the [MCP server](./git-agents-and-mcp.md), working on a branch page, recording its work, answering reviewers, and the [notes a CI job can leave](./ci.md#notes-on-a-branch-page) on a branch page.

<skill id="infrawrench-git" />

- **Migrate from GitHub Actions** moves a repository's workflows to [Infrawrench CI](./ci.md); see [Migrate from GitHub Actions](./ci-migrate-from-github-actions.md).

<skill id="migrate-github-actions" />

## Next

- [Home and your work](./git-home.md): the sidebar, the home page, and the Changes, Reviews and Mentions lists.
- [Issues and branches](./git-branches.md): branch pages, reviews, merging, protected branches and forks.
- [CI](./ci.md): pipelines in `.infrawrench/ci/` run on every push to an organization's repositories.
- [Terraform](./git-terraform.md): state, plans on branches and applies on merge.
