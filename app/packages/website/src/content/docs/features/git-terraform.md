---
title: Terraform on git.infrawrench.com
description: Keep Terraform state on git.infrawrench.com, plan every branch and apply on merge with your connected accounts, and see on each resource which repository manages it.
---

A repository on git.infrawrench.com that holds Terraform (or OpenTofu) gets an **Infrastructure** tab. It lists every Terraform configuration in the repository with an estimate of what it costs a month, before you set anything up. From there the forge can be your state backend, run your plans and applies on [Infrawrench CI](./ci.md) with the accounts you have already connected, and tell the app which repository and directory manage each of your resources.

<insert [The Infrastructure tab of a repository with two workspaces, prod and staging: each row shows its root directory, the last run's status, the resource count and the monthly cost] here>

## Detected configurations

The forge reads the Terraform files of your default branch and lists every **root**: a directory you would run `terraform plan` in, as opposed to a module that other directories call. A directory is a root when it declares a backend, when it configures a provider, or when it declares resources and nothing else in the repository calls it as a module. Directories under `modules/`, and directories that only hold variables or outputs, are modules.

Nothing is run to do this. The forge reads `.tf`, `.tf.json`, `.tofu` and `.tfvars` files and `.terraform.lock.hcl` as text, and for each root shows:

- the **backend** it declares and its plain settings (bucket, key, region), or **Local state** when it declares none. Credentials in a backend block are never read;
- its **providers**, with the source and version each one is pinned to;
- its **modules**: modules in the same repository link to their directory, registry and Git modules show their source and version;
- how many **resources** and **data sources** it declares, its own and its local modules', with the most common types;
- its variables that have no default, its outputs, whether the lock file is committed, its `.tfvars` files, and whether it reads `terraform.workspace`;
- an **estimate** of its monthly cost (below).

Everyone who can read the repository sees the list. A root that already has a workspace links to it.

<insert [The Infrastructure tab's Configurations panel listing infra/terraform and infra/ci-runners: path, Local state, the aws, google and oci providers, 74 resources, and the estimated monthly cost of each, with infra/terraform expanded to show its providers, top resource types, the priced lines and what could not be priced] here>

The scan is cached by the commit's tree, so opening the tab again costs nothing until a push changes a file. A very large repository is read up to a limit (20,000 directories, 3,000 Terraform files, 8 MiB of text, 1 MiB per file); past it the tab says the list may be incomplete. A file that cannot be parsed is named, and the rest of its directory is still read.

### Using git.infrawrench.com for state

Expand a configuration to see what moving it here takes, filled in for that directory:

1. **The backend block.** Put it in the root (in place of its current `backend` block, if it has one). The workspace name is the root's existing workspace, or a free name made from its path.
2. **Your credentials.** The backend takes a [personal access token](#access) with `repo:write` as the password, over HTTPS: `export TF_HTTP_PASSWORD=<token>`. The username is yours. Using a state takes admin access to the repository.
3. **Move the state.** Run `terraform init -migrate-state` in the directory. Terraform copies the state it has now (local, or from the old backend) to the forge and asks before it does.
4. **Add the workspace.** An admin of the repository chooses **Add workspace** on the configuration. That is what turns on [plans on branches](#plans-on-branches): the workspace has **Plan on branches** on by default, and its runs need the connected accounts its providers use.

## Workspaces

A **workspace** is one Terraform root directory with one state. An admin of the repository adds one with **Add workspace** on a detected configuration.

Each workspace has:

| Setting              | What it does                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Name**             | Lowercase letters, digits, `-` and `_`. It is part of the state address.                                            |
| **Directory**        | The root module, from the top of the repository.                                                                    |
| **Branch**           | The branch whose merges apply, and that branches are planned against. The default branch unless you choose another. |
| **Version**          | The Terraform or OpenTofu release its runs use. Leave it empty for the default.                                     |
| **Accounts**         | The connected Infrawrench accounts whose credentials its runs get. Nothing is written to the repository.            |
| **Plan on branches** | Plan every branch that merges into the workspace's branch and touches this workspace.                               |
| **Apply on merge**   | With **Apply requires approval** off, a merge applies at once. Otherwise the apply waits for someone to approve it. |

<insert [The Add workspace dialog: the directory picker listing detected Terraform roots, the name field, and the connected accounts picker with two accounts ticked] here>

Linking an account is what lends it: a workspace's runs get short-lived credentials for the accounts linked here, and only those. That includes the plan of every branch of the repository, which runs that branch's Terraform code, so link accounts with the people who can push to the repository in mind. Linking takes admin access to the repository and `accounts:read` in the organization, and every lend is in the [audit log](../team-and-billing/audit-log.md).

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

## Plans on branches

When a branch's page is opened or the branch gets new commits, the forge plans each workspace the change touches: files under the workspace's directory, or under a local module it uses. The branch's page shows each plan's result as a check named `Infrawrench Terraform / <workspace>` and an entry in its timeline:

```
Plan: 2 to add, 1 to change, 0 to destroy.
```

The run's page lists the resources that change and which attributes differ. **Values are never stored**: the plan is read once for its summary and thrown away, so nothing sensitive in it ends up on the branch's page.

<insert [A branch page's Infrastructure box showing the prod workspace's plan: 2 to add, 1 to change, 0 to destroy, the list of changed resources, and the estimated monthly cost change of +$48.20] here>

The **monthly cost change** is priced from the plan itself, through the accounts the workspace links, with the same estimator the app's create forms use. A change that cannot be priced is counted as unpriced and never as zero. You need `costs:read` in the organization to see it.

To require a plan before merging, add `Infrawrench Terraform / <workspace>` to the branch's required checks.

### Cost changes without a workspace

A branch that changes the Terraform files of a configuration with no plan for its head still gets a cost change on its page: the forge estimates the configuration at the branch's head and at the commit it branched from (see [estimates from configuration](#estimates-from-configuration)) and shows the monthly difference with the resources that changed it. When a workspace's plan of that head exists, the plan's cost card is shown instead, so a configuration never has two numbers on one page.

<insert [A branch page's Infrastructure box with an estimate from configuration for infra/terraform: +$24.53 a month, the line aws_instance.session going from 2 to 3 t4g.medium instances, and one resource that could not be priced] here>

**Branches proposed from forks are never planned.** A plan runs the branch's code with your cloud credentials, so the run is recorded as skipped with that reason instead.

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

## Estimates from configuration

Each detected configuration has an estimated monthly cost, worked out from its files alone: no state, no plan and no connected account are needed. It is an **estimate from configuration with list prices**, never a bill.

- **What is priced.** Servers, databases and caches whose price follows from their size: `aws_instance`, `aws_db_instance` and Aurora instances, ElastiCache, DocumentDB, Neptune, Redshift, MemoryDB, OpenSearch and EKS node groups, `google_compute_instance`, Azure virtual machines and scale sets, `hcloud_server`, `alicloud_instance`, Oracle Cloud fixed shapes and IBM Cloud virtual servers. Prices are the providers' public on-demand list prices from the same data as [instances.infrawrench.com](https://instances.infrawrench.com), for 730 hours a month, in US dollars.
- **With a connected account**, other resources whose price follows from their settings (a NAT gateway, a load balancer, a volume) are priced through it with the same estimator the app's create forms use. Without one they are listed as not priced, with that reason.
- **Counts and values.** `count` and `for_each` are read when they come from literals, from a variable's `default` or from a `terraform.tfvars` or `*.auto.tfvars` file committed in the root, from `locals`, and from simple expressions over those (conditionals, comparisons, `length`, `toset`, `lookup`, `merge`). Values passed to a local module are followed into it, with its `count` or `for_each`. A variable marked `sensitive`, and anything named like a credential, is never read.
- **Region** comes from the provider block (or the resource's own `zone` or `location`).

What could not be priced is listed plainly next to the total, with the reason: a size or a count that depends on another resource, a data source or a variable with no default; a region that is not set; a type with no list price in that region; a resource priced through a connected account when there is none; a module from a registry or Git, which is not read. The total is marked as partial whenever anything is missing from it. Resources billed by what they do (requests, bytes stored, invocations) and those with no charge of their own (IAM, routes, security groups) are counted separately and never priced.

Variables set only outside the repository (a `.tfvars` file that is not committed, `TF_VAR_*` in CI) are not seen, so a configuration whose resources are switched on by such a variable can estimate at less than it costs. Resources whose `count` or `for_each` is zero with the repository's values are listed as **switched off** next to the estimate rather than left out silently: a run that sets the variable would create them. Once a workspace has a plan, the plan's own cost change is the better number.

## Personal namespaces

A repository in your own namespace gets the state backend, with locking, versions and restore. Plans and applies run for an organization's repositories only, since they use the organization's connected accounts and CI.

## Limits

- Runs use a Linux machine on Infrawrench CI and reach public addresses only, so a provider that needs a private endpoint cannot plan.
- A root with a `cloud` block is not supported: Terraform does not accept a `cloud` block and a `backend` block together.
- A state document is at most 32 MiB.
- Matching uses each resource's provider id, so a resource Infrawrench has not synced yet shows as unmatched until it is.
- Estimates from configuration read up to 2,000 resources per configuration and 200 module instances; past either the estimate is marked partial.
