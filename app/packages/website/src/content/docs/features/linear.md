---
title: Linear issues
description: Turn a cost anomaly, budget alert, orphaned or oversized resource, posture finding, expiring credential, or failed probe into a tracked Linear issue, and see the issue's live status on the finding.
sidebar_order: 19
---

Infrawrench finds lots of things someone has to act on: spend anomalies, resources nobody uses, machines twice the size they need to be, security posture findings, credentials about to expire, probes that keep failing. If your team's backlog lives in Linear, connect it and any of those findings becomes a real Linear issue in one click. The finding keeps the link, so from then on its row shows the issue identifier instead of offering to file it again.

You can connect Linear, [Jira](./jira.md), or both. With both connected, the button reads **File an issue** and lets you pick the tracker for each finding. A finding filed to both shows both identifiers.

<insert [The Costs panel Anomalies table with a "File in Linear" link on one row and a filed Linear identifier like ENG-123 on another] here>

## What you can file

| Finding             | Where it lives                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Cost anomaly        | [Cost anomaly alerts](./cost-anomaly-alerts.md): the Anomalies table on the Costs panel     |
| Orphaned resource   | [Orphan finder](./orphan-finder.md): Potential savings                                      |
| Oversized resource  | [Right-sizing](./right-sizing.md): the Oversized section                                    |
| Posture finding     | [Posture checks](./posture-checks.md)                                                       |
| Expiring credential | [Expiry radar](./expiry-radar.md)                                                           |
| Failed probe        | [Synthetic probes](./synthetic-probes.md)                                                   |
| Extended support    | [Extended support findings](./extended-support.md): the Costs panel section                 |
| Budget alert        | [Budgets](./cloud-costs.md#filing-a-budget-alert-as-an-issue), each firing on a budget card |

Each issue comes prefilled with a title naming the finding and a description with the numbers behind it and a link back to Infrawrench. The description is formatted as markdown in Linear. You can edit everything before you file.

## Connect Linear

Linear is connected once per organization, under **Settings > Linear**. All you need is a **personal API key**, created in Linear under **Settings > Security & access > Personal API keys**. There's no site URL or email to enter.

Issues are created as the Linear user who owns the key, so many teams create the key on a service account. Restricting the key to **Create issues** plus **Read** is enough for everything Infrawrench does. You can also restrict it to the teams findings should go to.

Press **Verify** and Infrawrench checks the key with Linear and tells you which user it belongs to. Do this before you rely on it, so a mistyped or revoked key doesn't go unnoticed until someone tries to file something.

![Settings > Linear with the API key field filled in, the default team picker populated, and a green "Connected to Linear as Acme Ops Bot." confirmation shown after pressing Verify](https://agent-assets.infrawrench.com/docs-screenshots/features/linear/settings-connected-verified.png)

The key is encrypted when stored and never shown again. The settings page only shows its last few characters. Leave the key field blank when you save to keep the current key, for example when you're only changing the default team.

### Default team

Every Linear issue belongs to one team, so the file window always asks for one. Pick a default team and it's preselected. The list is filled from your Linear workspace, so there's no team id to look up.

## Permissions

- **`linear:read`:** see whether Linear is connected and which findings have already been filed. Members have this by default, so everyone can see what's already filed and avoid filing it twice.
- **`linear:write`:** connect or disconnect Linear, and file issues. Owners and admins have this. Members don't, because filing writes into Linear under your organization's shared API key and can't be undone from Infrawrench.

To let engineers file their own findings, give members `linear:write` through a [custom role](../team-and-billing/roles-and-permissions.md).

The file button only appears when a tracker is connected **and** you have that tracker's `:write` permission. Jira and Linear permissions are separate, so someone can be allowed to file into one and not the other.

## Already filed

Once a finding is filed, its row shows the issue identifier (like `ENG-123`) and links straight to the issue in Linear. If the same finding was also filed to Jira, both identifiers appear. Disconnecting Linear keeps these links, so reconnecting picks up where you left off.

**Settings > Linear** also lists everything filed from your organization, newest first, with each issue's current status.

![Settings > Linear "Filed issues" list showing several rows with Linear identifiers, source kinds like "cost anomaly" and "posture finding", and dates](https://agent-assets.infrawrench.com/docs-screenshots/features/linear/settings-filed-issues.png)

## Live status

Next to every filed identifier, you see the issue's state in Linear (`Backlog`, `In Progress`, `Done`, or your team's own names) with a coloured dot for not started, in progress, finished or cancelled. Hover it to see the assignee and the last change.

<insert [A Costs panel Anomalies row showing a filed Linear identifier ENG-123 followed by a green dot and "Done", with the hover tooltip naming the assignee] here>

Statuses update in two ways:

- **A webhook** keeps them current within seconds. Under **Settings > Linear > Live status**, press **Set up webhook** and Infrawrench creates a signed webhook for issue changes on all public teams. Only Linear workspace admins can create webhooks, so if the key belongs to someone else, choose **Add it by hand**. Infrawrench shows a URL, a Linear admin creates a webhook for **Issues** under **Settings > API > Webhooks** with it, and you paste the signing secret Linear shows back into Infrawrench. Every delivery is checked against that secret and must be less than a minute old.
- **A regular check** runs either way: every 30 minutes for unfinished issues and daily for finished ones, for issues filed in the last year. **Refresh statuses** checks up to 200 issues right away.

The settings section shows when the last webhook delivery arrived. Removing the webhook in Infrawrench also deletes it in Linear if Infrawrench created it, and disconnecting Linear removes it too. An issue moved to another team keeps its status. A deleted issue shows as **Deleted**.

### Mark anomalies resolved automatically

Turn on **Mark a cost anomaly explained when its Linear issue is done**. When an issue filed for a cost anomaly moves to a completed state, the anomaly is marked explained with a note like "Resolved in Linear as ENG-123 (Done)", which also appears on every cost chart covering that day. Cancelled and duplicate issues don't count. This only applies to anomalies nobody has explained yet, and it's off by default. Other findings don't have a resolved state, so for them you just see the status.

You can also send every status change to your own systems as an [`issue.status_changed` event](./event-subscriptions.md).

## Desktop and mobile

**Desktop** works just like the web app: the same **Settings > Linear** section, and the same file button on the Costs, Savings and Posture tabs when you're signed in to a cloud organization. In local (non-cloud) mode, the button doesn't appear.

**Mobile** shows the issue identifier and live status on anomalies that are already filed (and on budget alerts filed from web or desktop). You can also file a new issue from an anomaly row, with the team picker and the tracker choice when both Jira and Linear are connected. Connecting Linear in the first place happens on web or desktop.

## Rate limits

Linear allows an API key around 5,000 requests per hour. Filing by hand won't get near that. If Linear does rate limit the key, you'll see it in the error and can try again later.

## Audit trail

Every change is recorded in the [audit log](../team-and-billing/audit-log.md):

- `linear.configure` when the connection is saved
- `linear.delete` when it's removed
- `linear.issue.create` for each issue filed, naming the finding and the issue identifier
- `linear.webhook.configure` / `linear.webhook.delete` for the live status webhook

The API key and webhook secret never appear in the log.

`infrawrench issues linear` lists every filed Linear issue with its status and assignee (`--json` for scripts).

Linear credits every issue to the user who owns the key. Infrawrench's audit log shows which person actually filed each one.

Prefer GitHub? The same findings can be filed as [GitHub issues](./github-issues.md), with repository routing, one issue per finding, and Terraform pull requests.
