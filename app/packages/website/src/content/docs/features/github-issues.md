---
title: GitHub issues and pull requests
description: File savings findings as GitHub issues through your GitHub App, routed by cost centre or tag, one issue per finding, closed when the finding goes away, and fixed by a Terraform pull request when the change is mechanical.
sidebar_order: 20
---

Savings findings are work for an engineer: an unattached volume to delete, a machine to resize, a spike to explain, a reservation nobody is using. If your team works in GitHub, you can file each finding as a GitHub issue in the right repository. Infrawrench keeps one issue per finding, however often it's filed, and closes the issue when the finding goes away. For resources Terraform manages, it can also open the pull request that fixes them.

This uses the same **GitHub App** your organization already connected for [git-triggered workflows](./workflows.md#connecting-github) and [agents](./agents.md). There's no token to paste: the app creates issues and pull requests as itself.

GitHub works alongside [Jira](./jira.md) and [Linear](./linear.md). If you connect more than one, the link reads **File an issue** and you pick the tracker for each finding.

<insert [The Savings page Potential savings table with "Open PR" and "File in GitHub" links on one row and a filed "#42" link on another] here>

## What you can file

By hand, from a row's file link: orphaned and idle resources, oversized machines, cost anomalies, [budget alerts](./cloud-costs.md#filing-a-budget-alert-as-an-issue), and the posture, expiry and probe findings that Jira and Linear also take.

Automatically, through [alert routing](#file-new-findings-automatically): new orphaned and oversized resources, cost anomalies, idle commitments, and budget alerts. Private budgets are the exception, so their spend never lands in a shared repository.

Each issue includes:

- the evidence as a table (resource, type, account, provider id, sizes, utilization, spend)
- the monthly cost and the reason it was flagged
- remediation commands, when the finding has them
- a note when Terraform manages the resource, so the fix goes into code rather than the console
- a link back to Infrawrench

## Set it up

Open **Settings > GitHub Issues** on the web, or the Settings tab of the desktop app while signed in to your organization.

1. **Installations.** You'll see each connected GitHub account and what the app is allowed to do there. If none is connected, choose **Connect a GitHub account or add repositories**.
2. **Filing.** Turn on **Allow findings to be filed as GitHub issues** and pick the **default repository**. Optionally pick **labels** and **assignees** for every issue. All three are pickers loaded from the repository, so there's nothing to type.
3. **When a finding goes away.** Choose to close the issue with a comment, comment and leave it open, or do nothing.
4. Choose **Save changes**.

<insert [Settings → GitHub Issues, showing one installation with all permissions granted, the default repository picker, labels and assignees, and the "When a finding goes away" choice] here>

### Approve the new permissions

Filing issues needs the app's **Issues: read and write** permission. Pull requests also need **Contents: read and write** and **Pull requests: read and write**.

GitHub only applies new permissions to an existing installation once an owner of that GitHub account approves them. An older installation keeps working for workflows and agents, but can't file until then.

Until it's approved, the settings page shows which permissions each installation is missing, and the file window shows a **Review permissions on GitHub** button. An owner of the GitHub organization (or personal account) opens it and accepts the request. Filing works from the next attempt.

Self-hosting? Add those three repository permissions to your GitHub App on its settings page (**Permissions & events > Repository permissions**). Each installation is then asked to approve them.

## Send findings to the right repository

A finding about a payments resource belongs in the payments repository. Under **Routes**, add a rule that sends findings to another repository by:

- **Cost centre**: the [cost centre](./tag-policy-and-showback.md) your allocation rules assign the resource to. Rules that match on service are skipped, since they can't be judged from a single resource.
- **Tag**: a tag key on the resource, with an optional value. Leave the value empty to match any value.

Routes are checked top to bottom and the first match wins. Anything unmatched goes to the default repository. Each route adds its own labels to the org-wide ones and can replace the assignees. The file window opens on the routed repository, and you can still change it there.

## One issue per finding

Filing the same finding again, from another page, another person or an alert rule, **comments on the open issue** instead of opening a second one. If the issue was closed on GitHub, the next filing opens a fresh issue. Filed rows show the issue number (`#42`), and clicking it opens the issue.

When a finding goes away, Infrawrench acts on its issue the way you chose in settings:

- **Orphaned and oversized resources** are rescanned every six hours. A resource that was deleted, resized or is in use again resolves its issue.
- **Cost anomalies** resolve when someone [explains them](./cost-anomaly-alerts.md).
- **Idle commitments** aren't resolved automatically. Next month's repeat comments on the same issue.

## Live status

Each filed issue number is followed by the issue's state on GitHub: **Open**, **Closed** or **Closed as not planned**. Hover it to see the first assignee and the last change. You'll see this on rows, in the settings page's filed list, in the mobile app and in `infrawrench issues`.

<insert [A Savings row showing a filed "#42" link followed by a green dot and "Closed", next to the File in GitHub link offering to file again] here>

Statuses update in two ways:

- **Through the GitHub App's webhook**, when your server has one. Issue events (closed, reopened, assigned, transferred, deleted) show up within seconds.
- **By a regular check**, always: every 30 minutes for open issues and daily for closed ones, for issues filed in the last year. To check now, choose **Refresh statuses** under **Settings > GitHub Issues > Live status**. It checks up to 200 issues.

A closed issue counts as resolved for [one issue per finding](#one-issue-per-finding): the row shows its status and offers to file again. Reopening it on GitHub makes it the finding's open issue again, unless the finding has been filed since. If an issue is transferred, Infrawrench follows it to the new repository.

Turn on **Mark a cost anomaly explained when its GitHub issue is closed as completed** to record a note like "Resolved in GitHub as acme/infra#12 (Closed)" on the anomaly, and on the cost charts, when its issue is closed as completed. Issues closed as not planned don't count, and anomalies someone already explained are left alone.

You can also send status changes to your own systems as an [`issue.status_changed` event](./event-subscriptions.md).

### Turn on the webhook (self-hosting)

On Infrawrench Cloud the webhook is already on. If you run your own server, go to your GitHub App's settings page and:

1. Tick **Webhook > Active** and set the **Webhook URL** to `<your APP_URL>/api/issue-webhooks/github`.
2. Generate a random secret, put it in **Webhook secret**, and set the same value as `GITHUB_APP_WEBHOOK_SECRET` on the server.
3. Under **Permissions & events > Subscribe to events**, tick **Issues**. The app already has the Issues permission it needs.

Without the secret, statuses come only from the regular check. **Settings > GitHub Issues** tells you which one your server is using.

## File new findings automatically

To file findings without clicking, add an [alert routing](./alert-routing.md) rule with the **GitHub issues** destination. Two triggers carry findings worth filing:

- **Savings findings**: one alert per _new_ orphaned, idle or oversized resource, from the six-hourly scan. Its amount is the monthly cost (or the monthly saving, for a resize).
- **Anomalies** and **Idle commitments**, as they already fire.

For example, "file every new finding above $200 a month" is a rule with the trigger **Savings findings**, **amount at least $200**, sending to **GitHub issues**. Savings findings aren't part of the default "all alerts" rule and are muted on phones by default, so nothing changes until you write a rule for them.

The first scan only records what already exists, without raising anything. That backlog stays on the Savings page for you to file by hand. After that, each scan raises at most 25 new findings per organization, most expensive first, and the rest follow on the next scan.

<insert [The alert routing rule editor with trigger "Savings findings", amount at least $200, and the "GitHub issues (one per finding)" destination ticked] here>

## Terraform pull requests

When Terraform manages an oversized or orphaned resource, the fix belongs in the code. Infrawrench can propose it as a pull request when the change is **mechanical**:

- **Resize**: change the one attribute that holds the machine's size (for example `instance_type` or `size`) to the recommended value. It uses the same mapping as [Export to Terraform](./terraform-export.md).
- **Remove**: delete the resource block of an orphan that's still flagged.

Anything else is refused with a reason rather than guessed at: a resource inside a module or created with `count`/`for_each`, a size set from a variable or expression, a block declared twice, or an orphan still referenced elsewhere in the module.

To turn it on, go to **Settings > GitHub Issues > Terraform pull requests**:

1. Tick **Allow pull requests for IaC-managed findings**.
2. Under **Map a Terraform state to a repository**, choose the state (one of the states you uploaded on the [IaC page](./iac-reconciliation.md), by account or organization-wide), the repository, the base branch, and the directory holding the root module's `.tf` files.

Rows on the Savings page then show **Open PR**. It shows you the one-file diff first, or explains why this resource can't be changed mechanically. **Open pull request** creates a branch, commits the change and opens the pull request with the evidence in its description. Pull requests are never merged automatically, and the description reminds the reviewer to run `terraform plan`. If the finding has an open issue, the pull request is linked from it.

<insert [The Open PR window showing the diff that changes instance_type from "m5.xlarge" to "m5.large" in infra/prod/main.tf, with the Open pull request button] here>

[Pull request checks](./pr-checks.md) use the same repository mapping to match the Terraform in a pull request to the resources it manages, so those pull requests (and anyone else's) get a cost and blast-radius check too.

## Permissions

| Permission            | Grants                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `github-issues:read`  | See the settings and which findings have been filed. Members have it.                          |
| `github-issues:write` | File issues and open pull requests. Owners and admins; grant it to members with a custom role. |
| `org:settings:write`  | Change the settings, including turning pull requests on.                                       |

## Use it from the CLI, MCP and Terraform

```bash
infrawrench github-issues            # filed findings, open first, with status, assignee and any pull request
infrawrench issues github            # the same issues in the cross-tracker listing, unfinished first
infrawrench github-issues settings   # routing, Terraform sources and each installation's permissions
```

All of these take `--json`. The [MCP server](./mcp.md) offers `get_github_issue_settings`, `list_github_issue_links`, `file_github_issue`, `preview_iac_pull_request` and `open_iac_pull_request`. In the [Terraform provider](./terraform-provider.md), the settings are the `infrawrench_github_issue_settings` resource, and the routing destination is `github-issues` in `infrawrench_alert_routing`.

The mobile app shows filed issue numbers with their live status and can file a finding into its routed repository. Settings and pull requests stay on the web and desktop apps.
