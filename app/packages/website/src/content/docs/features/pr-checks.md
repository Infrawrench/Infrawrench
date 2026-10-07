---
title: Pull request checks
description: A GitHub check on every pull request that changes Terraform, with the estimated monthly cost change, the blast radius of each existing resource it touches, and right-sizing, tag policy and posture warnings.
sidebar_order: 21
---

Before an infrastructure change merges, the reviewer usually has two questions the diff cannot answer: what will this cost, and what else breaks if it goes wrong? Infrawrench answers both on the pull request itself. On every new commit of an open pull request in a repository you turn this on for, it posts a GitHub **check run** that says:

- the **estimated monthly cost change** of every Terraform resource the pull request adds, edits or removes, from the same [cost estimates](./cost-estimates.md) the create form and edit dialog show;
- the **blast radius** of each existing resource it edits or removes: how many resources depend on it, and the dashboards, probes and status pages that name it, from the same [blast radius](./blast-radius.md) report the delete dialog shows;
- **warnings** where Infrawrench already knows something: a resource flagged as [oversized](./right-sizing.md) being resized to something other than the recommendation, a new block that breaks your [tag policy](./tag-policy-and-showback.md), an edit that starts matching a [posture check](./posture-checks.md);
- a link back to Infrawrench.

Optionally it also keeps **one summary comment** on the pull request, edited in place on every push rather than posted again.

It runs on the same **GitHub App** your organization already connected for [GitHub issues](./github-issues.md), [git-triggered workflows](./workflows.md#connecting-github) and [agents](./agents.md). There is no token to paste and no webhook to configure.

<insert [A GitHub pull request's Checks tab showing the "Infrawrench: cost and blast radius" check with the summary table: two resources, their before and after monthly cost, the monthly change, and the blast radius column] here>

## Setting it up

Open **Settings → Pull Request Checks** on the web, or the Settings tab of the desktop app while signed in to your organization.

1. **Installations.** The page lists each connected GitHub account and what the app is allowed to do there. Checks need **Checks: read and write**, **Pull requests: read** (read and write if you turn the summary comment on) and **Contents: read**. If an installation has not approved them yet, the page says which are missing and links to the GitHub page where an owner of that account approves them.
2. **Add a repository.** Pick it from the list and choose **Turn on checks**. Open pull requests are checked within a minute; after that, every push gets a fresh check.
3. **Optional settings, per repository:**
   - **Also keep one summary comment** on the pull request.
   - **Cost threshold (per month).** When the estimated monthly increase is above it, the check concludes **Neutral** (flagged, not blocking) or **Failure** (blocks merging when the check is required by branch protection). An increase that could not be priced never trips the threshold.
   - **Only these directories.** For a monorepo, the path prefixes the check looks in, such as `infra/prod`. Empty covers the whole repository.
4. **Save.**

<insert [Settings → Pull Request Checks with one installation showing all permissions granted, a configured repository with the comment toggle on, a 500 cost threshold set to Failure, and the Recent checks list below] here>

To make the check required, add **Infrawrench: cost and blast radius** to the branch protection rule (or ruleset) of the target branch on GitHub. Pull requests that change no infrastructure still get a passing check, so a required check never leaves an unrelated pull request waiting.

## How the numbers are worked out

**Which files.** Terraform files (`.tf`) are read on both sides of the pull request, at the merge base and at the head commit, and compared per directory, so moving a block between two files of the same module is not a change, and a `moved` block reads as the rename Terraform will plan rather than a destroy and a create. Infrafiles and Kubernetes manifests are listed in the check as recognised but not analysed (see [what is not covered](#what-is-not-covered)).

**Which existing resource a block manages.** Through the Terraform state you uploaded on the [IaC page](./iac-reconciliation.md). If [GitHub issues](./github-issues.md) maps this repository to one state, that state is used; otherwise every uploaded state is searched, and an address found in two of them is not matched rather than guessed. Without an uploaded state the check still prices new and removed blocks from the code, but cannot say what an edit touches.

**Cost.** Each block's literal values (an instance type, a disk size, a region) are turned into the fields the provider's price lookup reads, by running the same mapping that powers [export to Terraform](./terraform-export.md) in reverse, so a provider that can export a resource type can usually price it here too. An edit to an existing resource is priced the way the edit dialog prices one: its current configuration, with only the values the pull request changes swapped in. A block with a literal `count` is multiplied by it.

**Not priced is not zero.** A value set from a variable or expression is never guessed, a resource type no connected provider describes has no price, and `for_each` makes the number of instances unknown. Those changes say why they are not priced, and the total reads "at least" when any change is missing from it.

<insert [The check run summary's lower half: the Blast radius section naming direct dependants of an edited database, the Warnings section with a right-sizing and a tag policy warning, and the collapsed "Why some changes are not priced" list] here>

## Previewing without posting

The settings page has a **Preview a pull request** box: pick a configured repository, enter a pull request number, and the same analysis runs without posting anything to GitHub.

From a terminal, the [CLI](./cli.md) runs it on your working tree before you even open the pull request:

```sh
infrawrench pr-check                          # working tree vs the default branch
infrawrench pr-check --base origin/release    # against another base
infrawrench pr-check --repo acme/infra --pr 42
infrawrench pr-check --json                   # the full report, for scripts
```

The local form sends only the infrastructure files that differ (Terraform, Infrafiles and Kubernetes-looking YAML, at most 50), uncommitted edits included. With `--repo`, or when the `origin` remote is a GitHub repository, that repository's threshold and Terraform state mapping apply.

## Managing it from Terraform

Each configured repository is an [`infrawrench_pr_check_repository`](./terraform-provider.md) resource in the Infrawrench Terraform provider, with every setting on this page.

## Permissions

Reading the settings, the recent checks and the preview needs `iac:read`, the same permission the IaC page needs, because the check reads the uploaded Terraform state. Adding, changing or removing a repository needs `org:settings:write`, since a threshold set to **Failure** can block merges.

## What is not covered

- **Infrafiles are never run.** An [Infrafile](./infrafile.md) is a program, and a pull request (possibly from a fork) is someone else's code; running it with your organization's accounts to see what it would change is not something a check should do. Run `infrawrench deploy --plan` yourself to see its planned changes.
- **Kubernetes manifests are listed, not priced.** Workload cost is [allocated from the cluster's nodes](./kubernetes-costs.md) after it runs, not from a manifest.
- **Modules are not expanded.** Resources declared inside a module call are not covered; the check says when a changed file calls modules.
- **Usage-based charges** (requests, data transfer, storage growth) are not in the estimate, the same as everywhere else estimates appear.
- There is no mobile view; the check lives on the pull request, and the settings on web and desktop.
