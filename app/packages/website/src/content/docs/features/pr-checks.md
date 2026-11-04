---
title: Pull request checks
description: A GitHub check on every pull request that changes Terraform, with the estimated monthly cost change, the blast radius of each existing resource it touches, and right-sizing, tag policy and posture warnings.
sidebar_order: 21
---

Before an infrastructure change merges, a reviewer usually wants to know two things the diff can't tell them: what will this cost, and what else breaks if it goes wrong? Infrawrench answers both on the pull request. On every new commit to an open pull request in a repository you turn this on for, it posts a GitHub **check run** with:

- the **estimated monthly cost change** of every Terraform resource the pull request adds, edits or removes, using the same [cost estimates](./cost-estimates.md) as the create form and edit dialog;
- the **blast radius** of each existing resource it edits or removes: how many resources depend on it, and the dashboards, probes and status pages that name it, the same as the [blast radius](./blast-radius.md) report in the delete dialog;
- **warnings** where Infrawrench already knows something: a resource flagged as [oversized](./right-sizing.md) being resized to something other than the recommendation, a new block that breaks your [tag policy](./tag-policy-and-showback.md), or an edit that starts matching a [posture check](./posture-checks.md);
- a link back to Infrawrench.

You can also have it keep **one summary comment** on the pull request, updated on every push instead of posted again.

It uses the same **GitHub App** your organization already connected for [GitHub issues](./github-issues.md), [git-triggered workflows](./workflows.md#connecting-github) and [agents](./agents.md). There's no token to paste and no webhook to set up.

<insert [A GitHub pull request's Checks tab showing the "Infrawrench: cost and blast radius" check with the summary table: two resources, their before and after monthly cost, the monthly change, and the blast radius column] here>

## Set it up

Open **Settings > Pull Request Checks** on the web, or the Settings tab of the desktop app while signed in to your organization.

1. **Check installations.** The page lists each connected GitHub account and what the app can do there. Checks need **Checks: read and write**, **Pull requests: read** (read and write if you turn on the summary comment) and **Contents: read**. If an installation hasn't approved them yet, the page says which are missing and links to the GitHub page where an owner of that account can approve them.
2. **Add a repository.** Pick it from the list and choose **Turn on checks**. Open pull requests are checked within a minute, and every push after that gets a fresh check.
3. **Choose optional settings for each repository:**
   - **Also keep one summary comment** on the pull request.
   - **Cost threshold (per month).** When the estimated monthly increase is above it, the check ends as **Neutral** (flagged, not blocking) or **Failure** (blocks merging when the check is required by branch protection). Changes that couldn't be priced never trip the threshold.
   - **Only these directories.** For a monorepo, the path prefixes to look in, such as `infra/prod`. Leave empty to cover the whole repository.
4. **Save.**

<insert [Settings > Pull Request Checks with one installation showing all permissions granted, a configured repository with the comment toggle on, a 500 cost threshold set to Failure, and the Recent checks list below] here>

To make the check required, add **Infrawrench: cost and blast radius** to the branch protection rule (or ruleset) for the target branch on GitHub. Pull requests that don't change infrastructure still get a passing check, so a required check never holds up an unrelated pull request.

## How the numbers are worked out

**Which files.** Terraform files (`.tf`) are compared between the merge base and the head commit, per directory. Moving a block between two files in the same module isn't counted as a change, and a `moved` block reads as a rename, the way Terraform will plan it. Infrafiles and Kubernetes manifests are listed as recognised but not analysed (see [what isn't covered](#what-is-not-covered)).

**Which existing resource a block manages.** This comes from the Terraform state you uploaded on the [IaC page](./iac-reconciliation.md). If [GitHub issues](./github-issues.md) maps this repository to one state, that state is used. Otherwise every uploaded state is searched, and an address found in two of them is left unmatched rather than guessed. Without an uploaded state, the check still prices new and removed blocks, but can't tell what an edit touches.

**Cost.** Each block's literal values (an instance type, a disk size, a region) are priced the same way Infrawrench prices resources elsewhere. If a provider can [export a resource type to Terraform](./terraform-export.md), it can usually price it here too. An edit to an existing resource is priced like the edit dialog does it: the current configuration with only the changed values swapped in. A block with a literal `count` is multiplied by it.

**Not priced doesn't mean zero.** Values set from a variable or expression are never guessed, a resource type no connected provider describes has no price, and `for_each` makes the number of instances unknown. Those changes say why they weren't priced, and the total reads "at least" when anything is missing.

<insert [The check run summary's lower half: the Blast radius section naming direct dependants of an edited database, the Warnings section with a right-sizing and a tag policy warning, and the collapsed "Why some changes are not priced" list] here>

## Preview without posting

The settings page has a **Preview a pull request** box. Pick a configured repository, enter a pull request number, and the same analysis runs without posting anything to GitHub.

From a terminal, the [CLI](./cli.md) runs it on your working tree before you even open the pull request:

```sh
infrawrench pr-check                          # working tree vs the default branch
infrawrench pr-check --base origin/release    # against another base
infrawrench pr-check --repo acme/infra --pr 42
infrawrench pr-check --json                   # the full report, for scripts
```

Locally, only the infrastructure files that differ are sent (Terraform, Infrafiles and Kubernetes-looking YAML, at most 50), including uncommitted edits. With `--repo`, or when your `origin` remote is a GitHub repository, that repository's threshold and Terraform state mapping apply.

## Manage it from Terraform

Each configured repository is an [`infrawrench_pr_check_repository`](./terraform-provider.md) resource in the Infrawrench Terraform provider, with every setting on this page.

## Permissions

- Viewing the settings, recent checks and preview needs `iac:read`, the same as the IaC page, because the check reads your uploaded Terraform state.
- Adding, changing or removing a repository needs `org:settings:write`, since a threshold set to **Failure** can block merges.

## What is not covered

- **Infrafiles are never run.** A pull request may come from a fork, and running someone else's code with your accounts isn't something a check should do. Run `infrawrench deploy --plan` yourself to see an [Infrafile](./infrafile.md)'s planned changes.
- **Kubernetes manifests are listed, not priced.** Workload cost is [allocated from the cluster's nodes](./kubernetes-costs.md) after it runs.
- **Modules aren't expanded.** Resources declared inside a module call aren't covered. The check tells you when a changed file calls modules.
- **Usage-based charges** (requests, data transfer, storage growth) aren't in the estimate, the same as everywhere else estimates appear.
- There's no mobile view. The check lives on the pull request, and the settings are on web and desktop.
