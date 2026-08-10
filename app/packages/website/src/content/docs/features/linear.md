---
title: Linear issues
description: Turn a cost anomaly, orphaned or oversized resource, posture finding, expiring credential, or failed probe into a tracked Linear issue, with the issue link kept on the finding.
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

The same six findings as Jira:

| Finding             | Where it lives                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Cost anomaly        | [Cost anomaly alerts](./cost-anomaly-alerts.md) — the Anomalies table on the Costs panel |
| Orphaned resource   | [Orphan finder](./orphan-finder.md) — Potential savings                                  |
| Oversized resource  | [Right-sizing](./right-sizing.md) — the Oversized section                                |
| Posture finding     | [Posture checks](./posture-checks.md)                                                    |
| Expiring credential | [Expiry radar](./expiry-radar.md)                                                        |
| Failed probe        | [Synthetic probes](./synthetic-probes.md)                                                |

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

<insert [Settings → Linear with the API key field filled in, the default team picker populated, and a green "Connected to Linear as ..." confirmation under the Verify button] here>

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

Settings → Linear also lists everything filed from this organization, newest first.

<insert [Settings → Linear "Filed issues" list showing several rows with Linear identifiers, source kinds like "cost anomaly" and "posture finding", and dates] here>

## Desktop and mobile

**Desktop** works exactly as the web app does: the same Settings → Linear section, and the
same file button on the Costs, Savings, and Posture tabs when you are signed in to a cloud
organization. Local (non-cloud) mode has no organization to file on behalf of, so the button
does not appear.

**Mobile** shows the issue identifier on an anomaly that has already been filed, and lets you
file a new one from the anomaly row with a native sheet — including the team picker, and the
tracker choice when both Jira and Linear are connected. Connecting Linear in the first place
is done from the web or desktop app.

## Rate limits

Linear allows an API key around 5,000 requests per hour. Filing findings by hand never gets
near that; if Linear does rate limit the key, Infrawrench reports it in the error rather than
failing silently, and the request can simply be retried later.

## Audit trail

Every change is recorded in the [audit log](../team-and-billing/audit-log.md):
`linear.configure` when the connection is saved, `linear.delete` when it is removed, and
`linear.issue.create` for each issue filed, naming the finding and the resulting identifier.
The API key never appears in any of them.

Issues are created by the one Linear user behind the key, so Linear attributes them all to
that user — Infrawrench's audit log is where you see which person actually filed which issue.
