---
title: Git (git.infrawrench.com)
description: Claim your organization's namespace on git.infrawrench.com, set what new repositories start as, and see repositories and storage against your plan.
sidebar_order: 6
---

[git.infrawrench.com](https://git.infrawrench.com) is Infrawrench's Git forge: repositories, branches and their review, issues, [CI](./ci.md) and Terraform state. It is its own site with its own pages. The app does not embed it. It links to it, and keeps the few settings that belong to your organization in **Settings > Git**.

Using the forge itself is covered in [Get started on git.infrawrench.com](./git-getting-started.md) (signing in, SSH keys, access tokens, cloning), [Issues and branches](./git-branches.md) (branch pages, reviews, merging, protected branches, forks) and [Agents and MCP](./git-agents-and-mcp.md) (connecting Claude Code, Codex, Cursor or another agent).

> **Cloud only.** A namespace belongs to a cloud organization. The desktop app shows Git when it is signed in to one.

> **Beta.** Git is in beta: it is open to every organization, and parts of it are still changing.

## Open your repositories

The sidebar has a **Git** entry under **Delivery**. It opens your organization's page on git.infrawrench.com in your browser (the desktop app opens your system browser). If your organization has no namespace yet, it opens **Settings > Git** so you can claim one.

You sign in on git.infrawrench.com with the same account as the app, and your [role](../team-and-billing/roles-and-permissions.md) decides what you can do there: `git:read` reads every repository of the organization, `git:write` pushes and creates, `git:admin` changes repository settings and the namespace.

<insert [Web sidebar with the Delivery app expanded, showing the Git entry between CI and Delivery] here>

## Claim a namespace

A namespace is the first part of every repository address: `git.infrawrench.com/<namespace>/<repository>`. An organization has one.

1. Go to **Settings > Git**.
2. Type a name and click **Claim**.

You can also claim it on git.infrawrench.com itself, without opening the app: open the account menu there and go to **Settings > Organisations**, which lists every organization you belong to, and click **Claim** beside yours. Both places follow the same rules and write the same [audit log](../team-and-billing/audit-log.md) entry.

Names use letters, digits, dots, dashes and underscores, start with a letter, digit or underscore, are at most 39 characters, and cannot end in `.git`. Some names are reserved (`api`, `settings`, `explore` and similar). The page tells you which rule a name breaks as you type, and tells you when someone else already has it.

You need the `git:admin` permission. Admins and owners have it by default.

An organization's namespace needs a [paid plan](../team-and-billing/billing-and-plans.md#git). On the free plan, **Settings > Git** and the forge's **Settings > Organisations** show **Organisations on git.infrawrench.com need a paid plan** with a button to billing where the name field would be. Your own username on git.infrawrench.com needs no plan. A namespace your organization already has stays, and you can still rename it, if the plan later ends.

<insert [Settings > Organisations on git.infrawrench.com: one organization with its git.infrawrench.com link and a Create a repository button, one with the Name field filled in, "Available" under it and the Claim button, one that says to ask an administrator, and one on the free plan with the paid plan sentence and Open billing] here>

<insert [Settings > Git before a namespace is claimed: the Name field with git.infrawrench.com/ in front, a reserved name typed in and the "That name is reserved" message under it] here>

### Rename it

Type a new name in the same field and click **Rename**. Repositories keep their history, issues and branch pages, and nothing is copied. Every repository address changes, and the old addresses stop working, so update your remotes afterwards:

```
git remote set-url origin https://git.infrawrench.com/<new-namespace>/<repository>.git
```

## Default visibility

**New repositories > Default visibility** is what a new repository in your namespace starts as: **Private** (the default) or **Public**. Whoever creates a repository can still choose the other.

Anyone can read and clone a public repository, signed in or not. Only people with access can see a private one.

## Usage and plan limits

The **Usage** card shows what your namespace holds against your plan:

|                      | Free      | Paid                                         |
| -------------------- | --------- | -------------------------------------------- |
| Public repositories  | Unlimited | Unlimited                                    |
| Private repositories | 3         | Unlimited                                    |
| Private storage      | 1 GiB     | 10 GiB included, then metered, up to 100 GiB |

An organization claims its namespace on a paid plan; the Free column is what a namespace keeps if the plan later ends. Public repositories are free on every plan and count toward neither limit. Storage is the size of a repository's packs on the forge, measured after each push.

When you reach a limit:

- **Private repositories.** Creating another private repository, or making a public one private, is refused. Make it public, or [upgrade](../team-and-billing/billing-and-plans.md#upgrade).
- **Private storage.** Pushes to your private repositories are refused with `storage quota exceeded` until you are back under the limit. Cloning, fetching and pushes to public repositories keep working, and you can still delete branches and tags. Delete repositories you no longer need, make some public, or upgrade.

Nothing is ever deleted or hidden when you go over, including after a plan ends.

<insert [Settings > Git on the free plan: the Usage card showing 3 of 3 private repositories with a full red bar, 622 MiB of 1 GiB private storage, and the Upgrade button] here>

A personal namespace (your own username on git.infrawrench.com) is not part of any organization's plan. It includes 5 private repositories and 1 GiB of private storage. A member can [connect their own namespace to your organization](./git-getting-started.md#where-your-own-repositories-run) so their repositories run CI and review agents here: that uses your organization's CI and AI usage, and changes nothing about these limits or about who can read their repositories.

## Repositories

The table lists your organization's repositories, most recently pushed first: visibility, the latest [CI](./ci.md) run on the default branch, open branches, last push and size. Click a name to open the repository on git.infrawrench.com. **Open <namespace>** at the top opens your organization's page there.

Creating, renaming, transferring and deleting repositories, collaborators, protected branches and deploy keys are all on the forge, in each repository's settings.

<insert [Settings > Git on a paid plan: the Namespace, New repositories and Usage cards, and the Repositories table with CI status, open branches, last push and size columns] here>

## Other places

- **[CLI](./cli.md#git-repositories):** `infrawrench git` prints the namespace and usage, `infrawrench git repos` lists repositories. Both take `--json`.
- **[Mobile app](./mobile-app.md):** **Git** on the Resources tab shows the namespace, usage and repositories, read-only. Tapping a repository opens it in the browser.
- **API:** `GET /api/org/:orgId/git`, `PUT /git/namespace`, `PUT /git/settings` and `GET /git/repositories`, described in the [OpenAPI document](../team-and-billing/openapi.md).

## Permissions

| Permission  | What it allows here                                           | Default roles        |
| ----------- | ------------------------------------------------------------- | -------------------- |
| `git:read`  | See Settings > Git, the sidebar entry and the repository list | Member, Admin, Owner |
| `git:admin` | Claim or rename the namespace, set the default visibility     | Admin, Owner         |
