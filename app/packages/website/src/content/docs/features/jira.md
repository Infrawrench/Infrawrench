---
title: Jira issues
description: Turn a cost anomaly, budget alert, orphaned or oversized resource, posture finding, expiring credential, or failed probe into a tracked Jira issue, and see the issue's live status on the finding.
sidebar_order: 18
---

Infrawrench finds plenty of things a person has to act on: spend anomalies, unused resources, oversized machines, posture findings, expiring credentials, failing probes. If they only live in Infrawrench, they compete with everything already in your tracker, and usually lose.

Connect Jira and you can turn any of those findings into a real issue in your team's backlog in one click. The finding remembers its issue, so the row shows the issue key from then on instead of offering to file it again.

Use Linear instead, or as well? See [Linear issues](./linear.md). With both connected, you choose the tracker each time you file, and a finding filed to both shows both links.

<insert [The Costs panel Anomalies table with a "File in Jira" link on one row and a filed issue key like OPS-412 on another] here>

## What you can file

| Finding             | Where to find it                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Cost anomaly        | [Cost anomaly alerts](./cost-anomaly-alerts.md): the Anomalies table on the Costs panel     |
| Orphaned resource   | [Orphan finder](./orphan-finder.md): Potential savings                                      |
| Oversized resource  | [Right-sizing](./right-sizing.md): the Oversized section                                    |
| Posture finding     | [Posture checks](./posture-checks.md)                                                       |
| Expiring credential | [Expiry radar](./expiry-radar.md)                                                           |
| Failed probe        | [Synthetic probes](./synthetic-probes.md)                                                   |
| Extended support    | [Extended support findings](./extended-support.md): the Costs panel section                 |
| Budget alert        | [Budgets](./cloud-costs.md#filing-a-budget-alert-as-an-issue), each firing on a budget card |

The issue comes prefilled: a summary naming the finding, and a description with the numbers behind it (the day and baseline for an anomaly, the current and recommended size for an oversized machine, the rule and severity for a posture finding) plus a link back to Infrawrench. Orphaned and oversized findings also include their [remediation commands](./remediation-commands.md), one code block per command, so whoever picks up the ticket can run the fix without opening Infrawrench. You can edit everything before you file. Often the line worth adding is "this is the one paging us".

## Connect Jira

You connect Jira once per organization, under **Settings > Jira**. You need three things:

1. **Your site URL**: the address you sign in at, like `https://your-company.atlassian.net`. A board or issue URL works too; only the site part is kept. Only Atlassian Cloud addresses are accepted (`.atlassian.net`, or `.jira.com` for older sites).
2. **An Atlassian account email**: the account issues will be created as.
3. **An API token**: create one at [id.atlassian.com > Security > API tokens](https://id.atlassian.com/manage-profile/security). Use a token, not your password; Atlassian has deprecated passwords for API access.

Press **Verify** to check the connection. Infrawrench tells you which Jira account answered. Do this before you rely on it, or a mistyped email or revoked token goes unnoticed until someone tries to file.

![Settings → Jira with the site URL, account email and API token fields filled in, and a green "Connected to Jira as Acme Ops Bot." confirmation shown after pressing Verify](https://agent-assets.infrawrench.com/docs-screenshots/features/jira/settings-connected-verified.png)

Your token is encrypted before it's stored and is never sent back to any browser or app. The settings page only shows its last few characters. If you leave the token field blank when you save, the stored token is kept, so you can change the default project without pasting it again.

### Set defaults

Pick a default **project** and **issue type**, and the file-issue window opens with them already selected. Both are dropdowns filled from your Jira site, so there's no project key or issue type id to look up.

The issue type list shows only the types that project accepts. Subtasks are left out, since a subtask needs a parent issue.

## Permissions

Two permissions control this:

- **`jira:read`**: see whether Jira is connected and which findings have already been filed. Members have this by default, so everyone can see what's filed and nothing gets filed twice.
- **`jira:write`**: connect or disconnect Jira, and file issues. Owners and admins have this; members don't, because filing writes into Jira under the organization's shared Atlassian account and can't be undone from Infrawrench.

To let engineers file their own findings, grant `jira:write` to members with a [custom role](../team-and-billing/roles-and-permissions.md).

The file button only appears when Jira is connected **and** you hold `jira:write`. If you can't see it, one of those is missing.

The Atlassian account behind the token also needs **Browse Projects** and **Create Issues** on the project you file into. If it doesn't have them, Jira refuses and Infrawrench shows you Jira's own explanation.

## See what's already filed

Once a finding is filed, its row shows the issue key and links straight to the issue in Jira. Disconnecting Jira doesn't erase these links, so reconnecting picks up where you left off.

**Settings > Jira** also lists everything filed from your organization, newest first, each with its current status.

![Settings → Jira "Filed issues" list showing several rows with issue keys, source kinds like "cost anomaly" and "posture finding", and dates](https://agent-assets.infrawrench.com/docs-screenshots/features/jira/settings-filed-issues.png)

## Live status

Next to every filed issue key you'll see where the issue stands in Jira: its status (`To Do`, `In Review`, `Done`, whatever your workflow calls it), a coloured dot for not started, in progress or finished, and the assignee and last change when you hover it. At a glance, you can tell which anomalies someone is working on and which were filed and forgotten.

<insert [A Costs panel Anomalies row showing a filed issue key OPS-412 followed by a blue dot and "In Review", with the hover tooltip "Assigned to Sam Lee · Updated 16/10/2026, 09:12"] here>

Statuses update in two ways:

- **A webhook** keeps them current within seconds. Under **Settings > Jira > Live status**, press **Set up webhook**. Infrawrench creates a signed webhook in your Jira site for issue updates and deletions. Jira only lets administrators create webhooks this way, so if the connected account isn't a Jira admin, you'll get a webhook URL and a secret instead. A Jira admin pastes them into **Jira settings > System > WebHooks** (events: issue updated and issue deleted). The secret is shown once; if you lose it, set the webhook up again. **Add it by hand** goes straight to that option.
- **A regular check** runs either way: every 30 minutes for unfinished issues and daily for finished ones (issues get reopened), for issues filed in the last year. It also covers you if someone deletes the webhook. **Refresh statuses** checks up to 200 issues right now.

<insert [Settings → Jira Live status card showing "Webhook on", "Created in Jira by Infrawrench. Last delivery 16/10/2026, 09:14.", and the Recreate webhook, Remove webhook and Refresh statuses buttons] here>

The settings section shows when the last webhook delivery arrived, so you can tell whether the webhook still works or a Jira admin removed it. Removing the webhook in Infrawrench also deletes it in Jira if Infrawrench created it, and disconnecting Jira removes it too.

A moved issue keeps its status even if its key changes. An issue deleted in Jira shows as **Deleted**.

### Mark anomalies resolved

Turn on **Mark a cost anomaly explained when its Jira issue is done**. Then, when an issue filed for a cost anomaly moves into a done status, Infrawrench marks the anomaly explained with a note like "Resolved in Jira as OPS-412 (Done)". Like any [explanation](./cost-anomaly-alerts.md), the note also appears on every cost chart covering that day.

It's off by default. It only applies to anomalies nobody has explained yet, and only when an issue moves into done, never to issues that were already done when Infrawrench first saw them. Other findings have no resolved state of their own, so for them you just see the status.

You can also send every status change to your own systems as an [`issue.status_changed` event](./event-subscriptions.md).

## Desktop and mobile

**Desktop** works just like the web app: the same **Settings > Jira** section, and the same file button on the Costs, Savings and Posture tabs when you're signed in to a cloud organization. Local (non-cloud) mode has no organization to file for, so the button doesn't appear.

**Mobile** shows the issue key and live status on an anomaly that's already been filed (and on budget alerts filed from the web or desktop app). You can file a new anomaly from its row, with the project and issue type pickers. Connect Jira from the web or desktop app; typing a site URL and API token on a phone is no fun.

## Audit trail and CLI

Every change is recorded in the [audit log](../team-and-billing/audit-log.md):

- `jira.configure` when the connection is saved, and `jira.delete` when it's removed
- `jira.issue.create` for each issue filed, naming the finding and the issue key
- `jira.webhook.configure` and `jira.webhook.delete` when the live-status webhook is set up or removed

The API token and webhook secret never appear in any of them.

All issues are created by the one Atlassian account behind the token, so Jira credits them all to that account. Infrawrench's audit log shows which person actually filed each one.

`infrawrench issues` lists every filed issue across Jira, Linear and GitHub with its status and assignee, unfinished first. Use `infrawrench issues jira` for Jira only, and `--json` for scripts.

Prefer GitHub? You can file the same findings as [GitHub issues](./github-issues.md), with repository routing, one issue per finding, and Terraform pull requests.
