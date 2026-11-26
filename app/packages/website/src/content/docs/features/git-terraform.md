---
title: Terraform on git.infrawrench.com
description: Keep Terraform state on git.infrawrench.com, plan every pull request and apply on merge with your connected accounts, and see on each resource which repository manages it.
---

A repository on git.infrawrench.com that holds Terraform (or OpenTofu) gets an **Infrastructure** tab. From there the forge is your state backend, runs your plans and applies on [Infrawrench CI](./ci.md) with the accounts you have already connected, and tells the app which repository and directory manage each of your resources.

<insert [The Infrastructure tab of a repository with two workspaces, prod and staging: each row shows its root directory, the last run's status, the resource count and the monthly cost] here>

## Workspaces

A **workspace** is one Terraform root directory with one state. Open **Infrastructure**, choose **Add workspace**, and pick a directory: the forge lists the directories in your default branch that look like roots (they declare a backend or a provider, and nothing else in the repository calls them as a module).

Each workspace has:

| Setting                  | What it does                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Name**                 | Lowercase letters, digits, `-` and `_`. It is part of the state address.                                                 |
| **Directory**            | The root module, from the top of the repository.                                                                         |
| **Branch**               | The branch whose merges apply, and that pull requests are planned against. The default branch unless you choose another. |
| **Version**              | The Terraform or OpenTofu release its runs use. Leave it empty for the default.                                          |
| **Accounts**             | The connected Infrawrench accounts whose credentials its runs get. Nothing is written to the repository.                 |
| **Plan on pull request** | Plan every pull request into the branch that touches this workspace.                                                     |
| **Apply on merge**       | With **Apply requires approval** off, a merge applies at once. Otherwise the apply waits for someone to approve it.      |

<insert [The Add workspace dialog: the directory picker listing detected Terraform roots, the name field, and the connected accounts picker with two accounts ticked] here>

Linking an account is what lends it: a workspace's runs get short-lived credentials for the accounts linked here, and only those. That includes the plan of every pull request opened from a branch of the repository, which runs that branch's Terraform code, so link accounts with the people who can push to the repository in mind. Linking takes admin access to the repository and `accounts:read` in the organization, and every lend is in the [audit log](../team-and-billing/audit-log.md).

## State

Every workspace has an HTTP state backend at:

```
https://git.infrawrench.com/<owner>/<repo>/terraform/<workspace>/state
```

Runs on the forge use it without any configuration: whatever backend the root declares is overridden for the run. An admin of the repository can use the same state from their own machine: copy the block the workspace's State tab shows and put a [personal access token](#access) with `repo:write` in `TF_HTTP_PASSWORD`:

```hcl
terraform {
  backend "http" {
    address        = "https://git.infrawrench.com/acme/infra/terraform/prod/state"
    lock_address   = "https://git.infrawrench.com/acme/infra/terraform/prod/state/lock"
    unlock_address = "https://git.infrawrench.com/acme/infra/terraform/prod/state/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    username       = "you"
  }
}
```

- **Locking** works as with any backend: a second `plan` or `apply` waits for the first (`-lock-timeout`) and is told who holds the lock.
- **Every version is kept.** The workspace page lists them with who or which run wrote each one. **Restore** makes an old version current again by writing it as a new version, so nothing in the history is rewritten, and **Download** gives you the document. Both take admin access.
- **Force unlock** releases a lock left behind by a run that died. It takes admin access.

<insert [A workspace's State tab: the list of state versions with serial, size, resource count and the run that wrote each, the current version marked, and the Restore and Download actions on an older row] here>

### Access

A state holds every secret its workspace manages, and whoever writes it decides what the next apply destroys. Every member of an organization can write its repositories, so using a state takes more than that: it takes admin access to the repository.

| You have                                                          | State                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| Read or write access (a public repository gives everyone read)    | Nothing. Requests answer 403.                          |
| Admin access, and a personal access token with `repo:write`       | Read, lock and write, through the backend.             |
| Admin access, signed in on git.infrawrench.com                    | Download a version, restore one, and force unlock.     |
| Admin access through an organization API key that has `git:admin` | Everything the backend serves, deleting the state too. |

The backend takes tokens only. A personal access token never deletes the state or forces a lock open.

A run's job gets a token of its own. It works for that workspace's state and that run's plan until the run ends, and for nothing else: it cannot clone the repository, push to it or call the API. A plan's token reads the state and takes the lock; only an apply's writes.

## Plans on pull requests

When a pull request is opened or gets new commits, the forge plans each workspace the change touches: files under the workspace's directory, or under a local module it uses. The pull request shows each plan's result as a check named `Infrawrench Terraform / <workspace>` and an entry in its timeline:

```
Plan: 2 to add, 1 to change, 0 to destroy.
```

The run's page lists the resources that change and which attributes differ. **Values are never stored**: the plan is read once for its summary and thrown away, so nothing sensitive in it ends up on the pull request.

<insert [A pull request's Infrastructure box showing the prod workspace's plan: 2 to add, 1 to change, 0 to destroy, the list of changed resources, and the estimated monthly cost change of +$48.20] here>

The **monthly cost change** is priced from the plan itself, through the accounts the workspace links, with the same estimator the app's create forms use. A change that cannot be priced is counted as unpriced and never as zero. You need `costs:read` in the organization to see it.

To require a plan before merging, add `Infrawrench Terraform / <workspace>` to the branch's required checks.

**Pull requests from forks are never planned.** A plan runs the pull request's code with your cloud credentials, so the run is recorded as skipped with that reason instead.

## Applies

A merge into the workspace's branch records an apply. The apply plans again at the merge commit, posts that plan, and applies exactly that plan file, so what was applied is on record.

- With **Apply on merge** on and **Apply requires approval** off, it starts at once.
- Otherwise it waits. An admin of the repository, or anyone with `ci:approve` in the organization, approves it from the run's page.
- A newer merge replaces an apply that is still waiting for approval.

<insert [An apply run waiting for approval: the merge commit, the workspace name, the Approve and Discard buttons, and the note that it applies the plan it makes at this commit] here>

You can also start a plan or an apply by hand from the workspace page. An apply started by someone who may approve it needs no second approval.

Runs appear in the organization's CI tab and count toward CI usage like any other run. Their logs are the CI run's logs. On git.infrawrench.com a run's output takes write access to the repository, because Terraform prints the values of attributes that are not marked sensitive; anyone who can read the repository still sees the run, its jobs and the plan's summary.

## What a workspace manages

After each apply, the resources in the workspace's state are matched to the resources Infrawrench has synced from your accounts. The Infrastructure tab then lists what each workspace manages, links each resource to its page in the app, and shows what it cost over the last thirty days.

<insert [A workspace's Resources tab: Terraform addresses in the first column, the matched Infrawrench resource with its provider icon in the second, and the monthly cost in the third, with two unmatched addresses at the bottom] here>

In the app, a resource's **Ownership** tab says where it is managed:

> Managed by acme/infra (network/prod)

The link opens the workspace on git.infrawrench.com. A workspace of a private repository is named only to people who can read the organization's repositories there (`git:read` or more).

<insert [A resource page in the app, Ownership tab, with the line "Managed by acme/infra (network/prod)" above the owner picker] here>

Costs follow the same rules as everywhere else in Infrawrench: you need `costs:read`, and if your view of costs is limited to some accounts or cost centers, a workspace's total is the part you may see.

## Personal namespaces

A repository in your own namespace gets the state backend, with locking, versions and restore. Plans and applies run for an organization's repositories only, since they use the organization's connected accounts and CI.

## Limits

- Runs use a Linux machine on Infrawrench CI and reach public addresses only, so a provider that needs a private endpoint cannot plan.
- A root with a `cloud` block is not supported: Terraform does not accept a `cloud` block and a `backend` block together.
- A state document is at most 32 MiB.
- Matching uses each resource's provider id, so a resource Infrawrench has not synced yet shows as unmatched until it is.
