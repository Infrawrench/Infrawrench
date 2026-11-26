---
title: Get started on git.infrawrench.com
description: Sign in to git.infrawrench.com, choose a username, add an SSH key or an access token, create a repository and clone it over HTTPS or SSH.
sidebar_order: 7
---

[git.infrawrench.com](https://git.infrawrench.com) hosts Git repositories with issues, a page for every branch, [CI](./ci.md) and [Terraform state](./git-terraform.md). This page takes you from signing in to your first push. For what an organization sets in the app (its namespace, default visibility and plan limits), see [Git in the app](./git.md).

## Sign in and choose a username

1. Open [git.infrawrench.com](https://git.infrawrench.com) and click **Sign in**. You sign in with your Infrawrench account, the same one as the app.
2. The first time, you are asked to **Choose a username**. It becomes your personal namespace: your own repositories live at `git.infrawrench.com/<username>/<repository>`. While Git is in early access, choosing a username needs membership of an organization that has Git turned on; otherwise the page says sign-ups are not open yet, and you can still browse public repositories.

Usernames use letters, digits, dots, dashes and underscores, are at most 39 characters, and cannot end in `.git`. The field tells you whether a name is available as you type.

You can change your username later under **Settings > Profile**. Addresses of your repositories change with it and the old ones stop working, so update your remotes afterwards.

<insert [The Choose a username page on git.infrawrench.com after the first sign-in: the Username field filled in with "Available" under it and the Continue button] here>

## Namespaces

A repository belongs to a namespace:

| Namespace         | Who it belongs to                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your username     | You. Created when you choose a username.                                                                                                                                                     |
| An organization's | An Infrawrench organization. Someone with `git:admin` claims it once, in the app under [**Settings > Git**](./git.md#claim-a-namespace), and it shows on the forge as an owner you can pick. |

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

The password of your Infrawrench account is never used for Git. Add an SSH key, an access token, or both.

### SSH keys

1. Open the account menu and go to **Settings > SSH keys**.
2. Click **Add key**, paste your **public** key (the contents of `~/.ssh/id_ed25519.pub`, for example) and give it a title.

Ed25519, ECDSA and RSA keys are accepted. A key identifies you everywhere you have access, so it can do whatever you can do. The list shows each key's fingerprint and when it was last used; **Delete** stops it working at once.

To check a key:

```
ssh -T git@git.infrawrench.com
```

It answers with your username and says that there is no shell access.

<insert [Settings > SSH keys with one key listed: its title, SHA256 fingerprint, key type, when it was added and last used, and the Delete button] here>

### Access tokens

A personal access token is what Git over HTTPS takes as a password. It is also what the [Terraform state backend](./git-terraform.md#state) takes.

1. Go to **Settings > Access tokens** and click **New token**.
2. Give it a name, tick its scopes and choose when it expires.
3. Copy the token. It starts with `iwg_` and is shown once.

| Scope        | Allows                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `repo:read`  | Clone and fetch the repositories you can read.                                                                                             |
| `repo:write` | Push to the repositories you can push to. For an administrator of a repository, also use its [Terraform state](./git-terraform.md#access). |

A token never does more than you can, and never administers a repository: a rule that only binds non-administrators still binds a push made with a token. **Revoke** stops a token working at once.

<insert [Settings > Access tokens right after creating a token: the new token shown once with a copy button and the note that it is the only time it is shown, above the list of tokens with scopes, expiry and last use] here>

An organization's Infrawrench [API key](../team-and-billing/api-keys.md) (`iwk_`) is also accepted as the password, for that organization's repositories and with the key's own role.

## Clone and push

The **Clone** button on a repository's page shows both addresses.

### HTTPS

```
git clone https://git.infrawrench.com/<owner>/<repository>.git
```

A public repository clones without credentials. For a private one, or to push, Git asks for a username and password: your username and an access token. A credential helper remembers them.

### SSH

```
git clone git@git.infrawrench.com:<owner>/<repository>.git
```

Push a very large history over SSH: a single HTTPS request is limited in size, and SSH is not.

### Push an existing repository

```
git remote add origin git@git.infrawrench.com:<owner>/<repository>.git
git push -u origin main
```

Branches and tags are what you can push. When a push is refused, Git prints the reason after `remote:` or beside the ref, for example a [protected branch](./git-branches.md#protected-branches) or a [storage limit](./git.md#usage-and-plan-limits).

## Browse a repository

<insert [A repository's Code tab: the branch picker, the file table with each entry's last commit, the README rendered below, and the About panel with stars, forks and size] here>

- **Code** lists files with the last commit that touched each one, and renders the README. Open a file for syntax highlighting, **Raw**, **Blame** and its **History**.
- The branch picker switches between branches and tags. **Branches** lists each branch by its [page](./git-branches.md#branches), and **Tags** lists the tags.
- **Commits** shows history. A commit's page shows its diff, unified or split.
- **Compare** shows what one branch or tag has that another does not.
- **Clone > Download ZIP** or **TAR.GZ** downloads the files at the branch or tag you are looking at.
- **Star** keeps a repository in your stars, under your name at the foot of the sidebar. **Explore** and the sidebar's search find public repositories and the private ones you can read.

<insert [A file's page on the Code tab: the path, the last commit, line numbers with syntax highlighting, and the Raw, Blame and History buttons] here>

## Repository settings

Administrators of a repository get a **Settings** tab:

| Section                    | What it holds                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **General**                | Name, description, topics, default branch, whether issues are on, merge methods, visibility, archive, transfer, delete. |
| **Collaborators**          | People added to this repository alone, each with a role: **Read**, **Triage**, **Write** or **Admin**.                  |
| **Branches**               | [Protected branches](./git-branches.md#protected-branches).                                                             |
| **Deploy keys**            | SSH keys that reach this one repository, for a server or a deploy script.                                               |
| **Labels**, **Milestones** | What issues and branch pages can be filed under.                                                                        |
| **CI**                     | Whether [Infrawrench CI](./ci.md) runs for this repository, and its pipelines.                                          |

Renaming or transferring a repository changes its address. Archiving makes it read-only for everyone until it is unarchived.

<insert [A repository's Settings > General page: the name and description fields, the default branch picker, the merge method checkboxes, and the danger zone with Make private, Archive, Transfer and Delete] here>

## Next

- [Home and your work](./git-home.md): the sidebar, the home page, and the Changes, Reviews and Mentions lists.
- [Issues and branches](./git-branches.md): branch pages, reviews, merging, protected branches and forks.
- [CI](./ci.md): pipelines in `.infrawrench/ci/` run on every push to an organization's repositories.
- [Terraform](./git-terraform.md): state, plans on branches and applies on merge.
