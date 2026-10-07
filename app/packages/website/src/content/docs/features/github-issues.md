---
title: GitHub issues and pull requests
description: File savings findings as GitHub issues through your GitHub App, routed by cost centre or tag, deduplicated per finding, closed when the finding goes away, and fixed by a Terraform pull request when the change is mechanical.
sidebar_order: 20
---

Savings findings are work for an engineer: an unattached volume to delete, a machine to resize, a spike to explain, a reservation nobody is using. If that work lives in GitHub, Infrawrench can file each finding as a GitHub issue in the right repository, keep one issue per finding no matter how often it is filed, and close the issue once the finding goes away. For resources Terraform manages, it can also open the pull request that fixes them.

It runs on the same **GitHub App** your organization already connected for [git-triggered workflows](./workflows.md#connecting-github) and [agents](./agents.md). There is no token to paste: issues and pull requests are created by the app, as the app.

GitHub sits beside [Jira](./jira.md) and [Linear](./linear.md). With more than one connected, the file link reads **File an issue** and lets you pick the tracker per finding.

<insert [The Savings page Potential savings table with "Open PR" and "File in GitHub" links on one row and a filed "#42" link on another] here>

## What can be filed

From a row's file link: orphaned and idle resources, oversized machines, cost anomalies, and the posture, expiry and probe findings that Jira and Linear also take. Through [alert routing](#filing-new-findings-automatically): new orphaned and oversized resources, cost anomalies, and idle commitments.

Each issue's body carries the evidence as a table (resource, type, account, provider id, sizes, utilization, spend), the monthly cost, the detector's reason, remediation commands when the finding has them, a note when Terraform manages the resource (so the fix goes into the code rather than the console), and a link back to Infrawrench.

## Setting it up

Open **Settings → GitHub Issues** on the web, or the Settings tab of the desktop app while signed in to your organization.

1. **Installations.** The page lists each connected GitHub account and what the app is allowed to do there. If none is connected, **Connect a GitHub account or add repositories** runs the usual install flow.
2. **Filing.** Turn on **Allow findings to be filed as GitHub issues**, pick the **default repository**, and optionally the **labels** and **assignees** every issue gets. All three are pickers loaded from the repository; there is nothing to type.
3. **When a finding goes away.** Choose to close the issue with a comment, comment and leave it open, or do nothing.
4. **Save changes.**

<insert [Settings → GitHub Issues, showing one installation with all permissions granted, the default repository picker, labels and assignees, and the "When a finding goes away" choice] here>

### Granting the new permissions

Filing issues needs the app's **Issues: read and write** permission; pull requests also need **Contents: read and write** and **Pull requests: read and write**. GitHub only applies new permissions to an existing installation once an owner of that GitHub account approves them, so an installation made before this feature keeps working for workflows and agents but cannot file yet.

Until it is approved, the settings page shows which permissions are missing for each installation, and the file window shows a **Review permissions on GitHub** button instead of failing. An owner of the GitHub organization (or the personal account) opens it, reviews the request and accepts it. Filing works from the next attempt.

Self-hosting? Add those three repository permissions to your GitHub App on its settings page (**Permissions & events → Repository permissions**). Every installation is then asked to approve them.

## Routing to the right repository

A finding about a payments resource belongs in the payments repository. Under **Routes**, add a rule that sends findings to another repository by:

- **Cost centre**: the [cost centre](./tag-policy-and-showback.md) the resource is allocated to by your allocation rules (rules that match on service cannot be judged from a single resource and are skipped), or
- **Tag**: a tag key on the resource, with an optional value; leave the value empty to match any value.

Routes are evaluated top to bottom and the first match wins; anything unmatched goes to the default repository. Each route adds its own labels to the org-wide ones and can replace the assignees. The file window opens on the routed repository, and you can still change it there.

## One issue per finding

Every issue carries a hidden marker naming its finding. Filing the same finding again, from another page, another person, or a routing rule that raised it again, **comments on the open issue** instead of opening a second one. If the issue was closed on GitHub, the next filing opens a fresh issue. Filed rows show the issue number (`#42`) from then on, and a click opens it.

When a finding goes away, Infrawrench acts on its issue as you chose in settings:

- **Orphaned and oversized resources** are rescanned every six hours. A resource that was deleted, resized, or is in use again resolves its issue.
- **Cost anomalies** resolve when someone [explains them](./cost-anomaly-alerts.md).
- Idle commitments are not resolved automatically: next month's repeat comments on the same issue.

## Filing new findings automatically

Automatic filing is an [alert routing](./alert-routing.md) rule with the **GitHub issues** destination. Two triggers carry findings worth filing:

- **Savings findings**: one alert per _new_ orphaned, idle or oversized resource, from the six-hourly scan. Its amount is the monthly cost (or the monthly saving, for a resize).
- **Anomalies** and **Idle commitments**, as they already fire.

So "file every new finding above $200 a month" is a rule with the trigger **Savings findings**, **amount at least $200**, sending to **GitHub issues**. Savings findings are deliberately left out of the default "all alerts" rule and muted on phones by default, so nothing changes until you write a rule for them.

The first scan after the feature reaches your organization records what already exists without raising anything; the backlog stays on the Savings page for you to file by hand. Each scan raises at most 25 new findings per organization, most expensive first; the rest follow on the next scan.

<insert [The alert routing rule editor with trigger "Savings findings", amount at least $200, and the "GitHub issues (one per finding)" destination ticked] here>

## Terraform pull requests

When an oversized or orphaned resource is managed by Terraform, the fix belongs in the code. Infrawrench can propose it as a pull request when the change is **mechanical**:

- **Resize**: change the one attribute that holds the machine's size (for example `instance_type` or `size`) to the recommended value. The attribute is worked out from the provider's own Terraform mapping, the same one [Export to Terraform](./terraform-export.md) uses.
- **Remove**: delete the resource block of an orphan that is still flagged.

Anything else is refused with a reason rather than guessed at: a resource inside a module or created with `count`/`for_each`, a size set from a variable or expression, a block declared twice, or an orphan still referenced elsewhere in the module.

To turn it on, in **Settings → GitHub Issues → Terraform pull requests**:

1. Tick **Allow pull requests for IaC-managed findings**.
2. **Map a Terraform state to a repository**: choose the state (the [IaC page](./iac-reconciliation.md) states you uploaded, by account or organization-wide), the repository, the base branch, and the directory holding the root module's `.tf` files.

Rows on the Savings page then show **Open PR**. It reads the repository and shows the one-file diff first, or why this resource cannot be changed mechanically; **Open pull request** creates a branch, commits the change, and opens the pull request with the evidence in its description. Pull requests are never merged automatically, and the description reminds the reviewer to run `terraform plan`. If the finding has an open issue, the pull request is linked from it.

<insert [The Open PR window showing the diff that changes instance_type from "m5.xlarge" to "m5.large" in infra/prod/main.tf, with the Open pull request button] here>

The repository mapping here is also what [pull request checks](./pr-checks.md) use to match the Terraform in a pull request to the resources it manages, so those pull requests (and anyone else's) get a cost and blast-radius check too.

## Permissions

| Permission            | Grants                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `github-issues:read`  | See the settings and which findings have been filed. Members have it.                          |
| `github-issues:write` | File issues and open pull requests. Owners and admins; grant it to members with a custom role. |
| `org:settings:write`  | Change the settings, including turning pull requests on.                                       |

## From the CLI, MCP and Terraform

```bash
infrawrench github-issues            # filed findings, open first, with any pull request
infrawrench github-issues settings   # routing, Terraform sources and each installation's permissions
```

Both take `--json`. The [MCP server](./mcp.md) exposes `get_github_issue_settings`, `list_github_issue_links`, `file_github_issue`, `preview_iac_pull_request` and `open_iac_pull_request`. The settings document is the `infrawrench_github_issue_settings` resource in the [Terraform provider](./terraform-provider.md), and the routing destination is `github-issues` in `infrawrench_alert_routing`.

The mobile app shows filed issue numbers and can file a finding into its routed repository; settings and pull requests stay on the web and desktop apps.
