---
title: Jira issues
description: Turn a cost anomaly, budget alert, orphaned or oversized resource, posture finding, expiring credential, or failed probe into a tracked Jira issue, and see the issue's live status on the finding.
sidebar_order: 18
---

Infrawrench detects a lot of things a human has to act on: spend anomalies, resources nobody
is using, machines twice the size they need to be, security posture findings, credentials
about to expire, probes that keep failing. Left alone, all of that lives in Infrawrench and
nowhere else — which means it competes for attention with whatever is already in your tracker,
and usually loses.

Connect Jira and any of those findings becomes a real issue in your team's backlog, in one
click. The link is kept on the finding, so the row shows the issue key from then on instead of
offering to file it again.

If your backlog lives in Linear instead — or as well — see [Linear issues](./linear.md). The
two trackers work side by side: an organization with both connected chooses the tracker each
time it files, and a finding filed to both shows both issue links.

<insert [The Costs panel Anomalies table with a "File in Jira" link on one row and a filed issue key like OPS-412 on another] here>

## What can be filed

| Finding             | Where it lives                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Cost anomaly        | [Cost anomaly alerts](./cost-anomaly-alerts.md) — the Anomalies table on the Costs panel    |
| Orphaned resource   | [Orphan finder](./orphan-finder.md) — Potential savings                                     |
| Oversized resource  | [Right-sizing](./right-sizing.md) — the Oversized section                                   |
| Posture finding     | [Posture checks](./posture-checks.md)                                                       |
| Expiring credential | [Expiry radar](./expiry-radar.md)                                                           |
| Failed probe        | [Synthetic probes](./synthetic-probes.md)                                                   |
| Extended support    | [Extended support findings](./extended-support.md) — the Costs panel section                |
| Budget alert        | [Budgets](./cloud-costs.md#filing-a-budget-alert-as-an-issue), each firing on a budget card |

Each one prefills the issue for you: a summary naming the finding, and a description carrying
the numbers behind it — the day and the baseline for an anomaly, the current and recommended
size for an oversized machine, the rule and severity for a posture finding — plus a link back
into Infrawrench. Orphaned and oversized findings also carry their
[remediation commands](./remediation-commands.md), one code block per command, so whoever picks
up the ticket can run the fix without opening Infrawrench. Everything is editable before you file, because the sentence worth adding is
usually "this is the one paging us".

## Setting it up

Jira is connected once per organization, under **Settings → Jira**. You need three things.

**Your site URL** — the address you sign in at, like `https://your-company.atlassian.net`.
Pasting a board or issue URL works too; only the site part is kept. Infrawrench only accepts
Atlassian Cloud addresses (`.atlassian.net`, or `.jira.com` for older sites).

**An Atlassian account email** — the account issues will be created as.

**An API token** — create one at
[id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security).
Use a token, not your password; Atlassian has deprecated passwords for API access.

Press **Verify** and Infrawrench makes one authenticated call to Jira and tells you which
account answered. Do this before you rely on it — a mistyped email or a revoked token
otherwise stays invisible until the first time somebody tries to file something.

![Settings → Jira with the site URL, account email and API token fields filled in, and a green "Connected to Jira as Acme Ops Bot." confirmation shown after pressing Verify](https://agent-assets.infrawrench.com/docs-screenshots/features/jira/settings-connected-verified.png)

The token is encrypted before it is stored and is never sent back to any client — the settings
page shows only the last few characters of it. Leaving the token field blank when you save
keeps the stored one, so you can change the default project without re-pasting the token.

### Defaults

Pick a default **project** and **issue type** and the file-issue window opens with them
already selected. Both are dropdowns filled from your Jira site: there is no project key or
issue type id to look up, and no way to typo one.

The issue type list is the one that project actually accepts, not a global list — a type that
project's scheme does not have would be rejected by Jira at creation time. Subtasks are left
out, since a subtask needs a parent issue and a finding has none.

## Permissions

Two permissions control this, and they are deliberately split:

- **`jira:read`** — see whether Jira is connected, and see which findings have already been
  filed. Members have this by default. Without it, the "already filed" markers would be
  invisible to most of the team, which is exactly how a finding gets filed twice.
- **`jira:write`** — connect or disconnect Jira, and file issues. Owners and admins have
  this; members do not, because filing writes into a third-party tracker under the
  organization's single shared Atlassian credential and cannot be undone from Infrawrench.

If you want your engineers filing their own findings, grant `jira:write` to members through a
[custom role](../team-and-billing/roles-and-permissions.md).

The file button only appears when Jira is connected **and** you hold `jira:write`. If you
cannot see it, one of those two is missing.

There is a second gate you also control: the Atlassian account behind the API token needs
**Browse Projects** and **Create Issues** on the project being filed into. If it does not,
Jira refuses and Infrawrench shows you Jira's own explanation rather than a bare error.

## Already filed

Once a finding has been filed, its row shows the issue key and links straight to the issue in
Jira instead of offering the button again. Disconnecting Jira does not erase these — the links
are kept, so a reconnection picks up where you left off.

Settings → Jira also lists everything filed from this organization, newest first, each with its
current status.

![Settings → Jira "Filed issues" list showing several rows with issue keys, source kinds like "cost anomaly" and "posture finding", and dates](https://agent-assets.infrawrench.com/docs-screenshots/features/jira/settings-filed-issues.png)

## Live status

Next to every filed issue key, Infrawrench shows where the issue stands in Jira: its status
(`To Do`, `In Review`, `Done`, whatever your workflow calls it), a coloured dot for whether that
means not started, in progress or finished, and the assignee and last change when you hover it.
You can see at a glance which anomalies somebody is already working on and which ones were filed
and forgotten.

<insert [A Costs panel Anomalies row showing a filed issue key OPS-412 followed by a blue dot and "In Review", with the hover tooltip "Assigned to Sam Lee · Updated 16/10/2026, 09:12"] here>

Statuses arrive two ways:

- **A webhook** keeps them current within seconds. Under **Settings → Jira → Live status**,
  press **Set up webhook**. Infrawrench registers a webhook in your Jira site for issue updates
  and deletions, signed with a secret only Infrawrench and Jira know. Jira only lets
  administrators create webhooks through its API, so if the connected account is not a Jira
  admin, Infrawrench shows you the webhook URL and a secret instead: a Jira admin pastes them
  into **Jira settings → System → WebHooks** (events: issue updated and issue deleted). The
  secret is shown once; if you lose it, set the webhook up again. **Add it by hand** goes
  straight to that path.
- **A periodic check** runs whether or not there is a webhook: every 30 minutes for issues that
  are not finished, daily for finished ones (issues get reopened), for issues filed in the last
  year. It is also the safety net for a webhook somebody deleted. **Refresh statuses** asks Jira
  about up to 200 issues right now.

<insert [Settings → Jira Live status card showing "Webhook on", "Created in Jira by Infrawrench. Last delivery 16/10/2026, 09:14.", and the Recreate webhook, Remove webhook and Refresh statuses buttons] here>

The settings section shows when the last signed delivery arrived, which is how you tell a
working webhook from one a Jira admin removed. Removing the webhook in Infrawrench also deletes it
in Jira when Infrawrench created it, and disconnecting Jira removes it too.

A moved issue keeps its status (Infrawrench follows Jira's issue id, not the key). An issue
deleted in Jira shows as **Deleted**.

### Marking anomalies resolved

Turn on **Mark a cost anomaly explained when its Jira issue is done** and, when an issue filed
for a cost anomaly moves into a done status, Infrawrench records the anomaly as explained with
the note "Resolved in Jira as OPS-412 (Done)". Like any
[explanation](./cost-anomaly-alerts.md), that note also appears on every cost chart covering
the anomaly's day. It only applies to anomalies nobody has explained yet, and only on a move
into done, never to issues that were already done when status sync first saw them. It is off by
default. The other findings have no resolved state of their own, so for them the status is
shown and nothing else changes.

Every status change can also be sent to your own systems as an
[`issue.status_changed` event](./event-subscriptions.md).

## Desktop and mobile

**Desktop** works exactly as the web app does: the same Settings → Jira section, and the same
file button on the Costs, Savings, and Posture tabs when you are signed in to a cloud
organization. Local (non-cloud) mode has no organization to file on behalf of, so the button
does not appear.

**Mobile** shows the issue key and its live status on an anomaly that has already been filed
(and on budget alerts filed from the web or desktop app), and lets you file a new anomaly from
the anomaly row with a native sheet, including the project and issue type pickers. Connecting Jira in the first place is done from the web or desktop app; entering a
site URL and an API token on a phone is not a good use of a phone.

## Audit trail

Every change is recorded in the [audit log](../team-and-billing/audit-log.md):
`jira.configure` when the connection is saved, `jira.delete` when it is removed, and
`jira.issue.create` for each issue filed, naming the finding and the resulting issue key, and
`jira.webhook.configure` / `jira.webhook.delete` when the live-status webhook is set up or
removed. The API token and the webhook secret never appear in any of them.

`infrawrench issues` lists every filed issue across Jira, Linear and GitHub with its status and
assignee, unfinished first (`infrawrench issues jira` for Jira only; `--json` for scripts).

Issues are created by the one Atlassian account behind the token, so Jira attributes them all
to that account — Infrawrench's audit log is where you see which person actually filed which
issue.

Prefer GitHub for this work? The same findings can be filed as [GitHub issues](./github-issues.md), with repository routing, one issue per finding, and Terraform pull requests.
