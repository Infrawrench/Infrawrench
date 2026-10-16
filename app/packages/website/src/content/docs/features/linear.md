---
title: Linear issues
description: Turn a cost anomaly, budget alert, orphaned or oversized resource, posture finding, expiring credential, or failed probe into a tracked Linear issue, and see the issue's live status on the finding.
sidebar_order: 19
---

Infrawrench detects a lot of things a human has to act on: spend anomalies, resources nobody
is using, machines twice the size they need to be, security posture findings, credentials
about to expire, probes that keep failing. If your team's backlog lives in Linear, connect it
and any of those findings becomes a real issue there in one click. The link is kept on the
finding, so the row shows the issue identifier from then on instead of offering to file it
again.

Linear is the second tracker Infrawrench supports, alongside [Jira](./jira.md). You can
connect either, or both — with both connected, the file button reads **File an issue** and
lets you pick the tracker per finding, and a finding filed to both shows both identifiers.

<insert [The Costs panel Anomalies table with a "File in Linear" link on one row and a filed Linear identifier like ENG-123 on another] here>

## What can be filed

The same findings as Jira:

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

Each one prefills the issue for you: a title naming the finding, and a description carrying
the numbers behind it plus a link back into Infrawrench. Linear renders the description as
markdown, so it arrives formatted. Everything is editable before you file.

## Setting it up

Linear is connected once per organization, under **Settings → Linear**. You need one thing: a
**personal API key**, created in Linear under **Settings → Security & access → Personal API
keys**. There is no site URL to enter — Linear's API lives at one fixed address for every
workspace — and no account email, because the key is the whole credential.

Issues are created as the Linear user the key belongs to, so many teams create the key on a
service account rather than a personal one. When creating the key, restricting it to
**Create issues** plus **Read** is enough for everything Infrawrench does; you can also
restrict it to the teams findings should be filed into.

Press **Verify** and Infrawrench makes one authenticated call to Linear and tells you which
user answered. Do this before you rely on it — a mistyped or revoked key otherwise stays
invisible until the first time somebody tries to file something.

![Settings → Linear with the API key field filled in, the default team picker populated, and a green "Connected to Linear as Acme Ops Bot." confirmation shown after pressing Verify](https://agent-assets.infrawrench.com/docs-screenshots/features/linear/settings-connected-verified.png)

The key is encrypted before it is stored and is never sent back to any client — the settings
page shows only the last few characters of it. Leaving the key field blank when you save
keeps the stored one, so you can change the default team without re-pasting the key.

### Default team

Every Linear issue belongs to exactly one team, so the file-issue window always asks for one.
Pick a default team and it opens preselected. The list is a dropdown filled from your Linear
workspace: there is no team id to look up, and no way to typo one.

## Permissions

Two permissions control this, split the same way as Jira's and for the same reasons:

- **`linear:read`** — see whether Linear is connected, and see which findings have already
  been filed. Members have this by default. Without it, the "already filed" markers would be
  invisible to most of the team, which is exactly how a finding gets filed twice.
- **`linear:write`** — connect or disconnect Linear, and file issues. Owners and admins have
  this; members do not, because filing writes into a third-party tracker under the
  organization's single shared API key and cannot be undone from Infrawrench.

If you want your engineers filing their own findings, grant `linear:write` to members through
a [custom role](../team-and-billing/roles-and-permissions.md).

The file button only appears when a tracker is connected **and** you hold that tracker's
`:write`. The Jira and Linear permissions are independent — someone can be allowed to file
into one and not the other, and the button offers only what they can actually use.

## Already filed

Once a finding has been filed, its row shows the issue identifier (like `ENG-123`) and links
straight to the issue in Linear instead of offering the button again. If the same finding was
also filed to Jira, both identifiers appear. Disconnecting Linear does not erase these — the
links are kept, so a reconnection picks up where you left off.

Settings → Linear also lists everything filed from this organization, newest first, each with
its current status.

![Settings → Linear "Filed issues" list showing several rows with Linear identifiers, source kinds like "cost anomaly" and "posture finding", and dates](https://agent-assets.infrawrench.com/docs-screenshots/features/linear/settings-filed-issues.png)

## Live status

Next to every filed identifier, Infrawrench shows the issue's workflow state in Linear
(`Backlog`, `In Progress`, `Done`, or your team's own names), a coloured dot for whether that
means not started, in progress, finished or canceled, and the assignee and last change when you
hover it.

<insert [A Costs panel Anomalies row showing a filed Linear identifier ENG-123 followed by a green dot and "Done", with the hover tooltip naming the assignee] here>

Statuses arrive two ways:

- **A webhook** keeps them current within seconds. Under **Settings → Linear → Live status**,
  press **Set up webhook**: Infrawrench creates a webhook for issue changes on all public teams,
  signed with a secret Infrawrench generates. Linear lets only workspace admins create webhooks,
  so if the key belongs to someone else, choose **Add it by hand**: Infrawrench shows the URL, a
  Linear admin creates a webhook for **Issues** under **Settings → API → Webhooks** with it, and
  you paste the signing secret Linear then shows back into Infrawrench. Every delivery is checked
  against that secret and must be less than a minute old.
- **A periodic check** runs whether or not there is a webhook: every 30 minutes for issues that
  are not finished, daily for finished ones, for issues filed in the last year. **Refresh
  statuses** asks Linear about up to 200 issues right now.

The settings section shows when the last signed delivery arrived. Removing the webhook in
Infrawrench also deletes it in Linear when Infrawrench created it, and disconnecting Linear
removes it too. An issue moved to another team keeps its status (Infrawrench follows Linear's
issue id, not the identifier); a deleted one shows as **Deleted**.

### Marking anomalies resolved

Turn on **Mark a cost anomaly explained when its Linear issue is done** and, when an issue
filed for a cost anomaly moves into a completed state, Infrawrench records the anomaly as
explained with the note "Resolved in Linear as ENG-123 (Done)", which also appears on every cost
chart covering the anomaly's day. Canceled and duplicate issues do not count. It only applies to
anomalies nobody has explained yet, and is off by default. Other findings have no resolved
state of their own, so for them the status is shown and nothing else changes.

Every status change can also be sent to your own systems as an
[`issue.status_changed` event](./event-subscriptions.md).

## Desktop and mobile

**Desktop** works exactly as the web app does: the same Settings → Linear section, and the
same file button on the Costs, Savings, and Posture tabs when you are signed in to a cloud
organization. Local (non-cloud) mode has no organization to file on behalf of, so the button
does not appear.

**Mobile** shows the issue identifier and its live status on an anomaly that has already been
filed (and on budget alerts filed from the web or desktop app), and lets you
file a new one from the anomaly row with a native sheet, including the team picker and the
tracker choice when both Jira and Linear are connected. Connecting Linear in the first place
is done from the web or desktop app.

## Rate limits

Linear allows an API key around 5,000 requests per hour. Filing findings by hand never gets
near that; if Linear does rate limit the key, Infrawrench reports it in the error rather than
failing silently, and the request can simply be retried later.

## Audit trail

Every change is recorded in the [audit log](../team-and-billing/audit-log.md):
`linear.configure` when the connection is saved, `linear.delete` when it is removed, and
`linear.issue.create` for each issue filed, naming the finding and the resulting identifier,
and `linear.webhook.configure` / `linear.webhook.delete` for the live-status webhook. The API
key and the webhook secret never appear in any of them.

`infrawrench issues linear` lists every filed Linear issue with its status and assignee
(`--json` for scripts).

Issues are created by the one Linear user behind the key, so Linear attributes them all to
that user — Infrawrench's audit log is where you see which person actually filed which issue.

Prefer GitHub for this work? The same findings can be filed as [GitHub issues](./github-issues.md), with repository routing, one issue per finding, and Terraform pull requests.
