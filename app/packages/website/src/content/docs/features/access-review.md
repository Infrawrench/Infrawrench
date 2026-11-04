---
title: Access review
description: See every principal in your connected clouds in one list (IAM users and roles, service accounts, app registrations, groups, bindings and long-lived keys), with stale, over-privileged, unrotated and unowned access flagged, and export a CSV for your auditor.
sidebar_order: 12
---

Someone left in March. Their IAM user is still there. So is the service account they made for a project that never shipped, and the API key a cron job has been using ever since. None of it shows up until an auditor asks, and then it takes a week of clicking through five provider consoles to answer.

The access review gives you that answer any time: every principal your connected accounts have synced, in one list, with the ones worth a conversation flagged.

![The Access review tab with the Findings view open, grouped by severity, showing a mix of stale, admin and unowned findings across at least two providers](https://agent-assets.infrawrench.com/docs-screenshots/features/access-review/findings-by-severity.png)

## Find it

Click **Access review** in the sidebar, on web or the desktop app. It's cloud-only, because some of its checks use your organization's ownership records and saved dismissals.

## Just-in-time grants that didn't end

At the top of the page you'll see any [just-in-time access](./just-in-time-access.md) grants that should have ended but may not have:

- a revoke that failed (with the provider's error)
- a grant the provider still reported after it was revoked
- a grant still marked as held more than ten minutes after its window closed

Each one is a person holding cloud access past what an approver agreed to. You can't dismiss these. They clear when the revoke succeeds.

## What counts as a principal

Anything that can hold standing access inside **your** clouds:

- **Users:** AWS IAM users, WorkOS and directory users, provider organization members, database users.
- **Groups:** directory groups that grant access through membership.
- **Roles:** AWS IAM roles, WorkOS environment roles, Postgres roles on a Neon branch.
- **Service accounts:** GCP service accounts, Azure app registrations and managed identities.
- **Keys:** long-lived API keys, tokens and database passwords.
- **Bindings:** the grant itself, like a WorkOS organization membership carrying a role.

Three related things are _not_ on this page:

| This page                                      | Not this page                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Principals inside your cloud accounts          | Your Infrawrench team's roles. See [Roles and permissions](../team-and-billing/roles-and-permissions.md)        |
| Access that exists in AWS, GCP, Azure, WorkOS… | The credentials Infrawrench stores for you. See [Credential hygiene](../team-and-billing/credential-hygiene.md) |
| Who can get in                                 | What is exposed. See [Posture checks](./posture-checks.md)                                                      |

## What gets flagged

Five checks, each raised only when there's evidence for it:

- **Unused beyond the window:** the principal has a _known_ last-use date older than the window you pick (30, 90, 180 or 365 days, 90 by default).
- **Administrative or wildcard permissions:** the principal holds a role or scope marked as privileged. A stale admin is raised one severity level higher, because that's the combination that actually gets exploited.
- **Past its rotation budget:** the credential is older than its rotation budget. This matches what the [expiry radar](./expiry-radar.md) shows, so the two never disagree.
- **No recorded owner:** nobody is named on the resource. You can't ask "do you still need this?" without an owner, so record one (see [Resource ownership](../core-concepts/resource-ownership.md)).
- **No multi-factor authentication:** a user signing in without a second factor. Only raised where the provider reports it.

## "Unknown" never counts as stale

Most providers don't report when a principal was last used without an extra API call for each one, and the review doesn't make extra calls. It only uses what your accounts already sync.

So when there's no last-use date, the row says **Unknown**, and it can never become a stale finding. For example, AWS doesn't return a last-use date for IAM roles in `ListRoles`, and GCP service accounts have no timestamps at all. Those principals are still listed, counted and checked against the rules that do have evidence.

The page footer tells you how many principals are in that position, so "we found nothing" and "we couldn't look" never look the same.

## Review your access

There are two views of the same data:

- **Findings:** only the principals with something raised, grouped by severity, account or kind. This is what you act on.
- **All principals:** the full list with last use, age, admin flag and owner. This is what you sign off.

Change the staleness window at the top and both views update straight away.

### Accept a finding

Some access is meant to look like this. A break-glass role really is admin. A shared key really is rotated by a pipeline. Dismiss the finding with a note, and it leaves the list and stops triggering alerts.

Dismissed findings aren't deleted. They're still checked, and they appear under **Dismissed** with your note and name for as long as they still match. They're included and labelled in exports. Click **Restore** to put one back. Dismissing needs the `resources:write` permission, so members can read the review but can't silence it.

![The Dismissed section expanded, showing an accepted admin finding with its note and the person who accepted it, and the Restore button](https://agent-assets.infrawrench.com/docs-screenshots/features/access-review/dismissed-expanded.png)

### Revoke access

Where the provider supports revoking through its API (like _Deactivate_ on a WorkOS membership, or _Deactivate key_ on an Anthropic key), the row has a **Revoke** button. It respects [change freezes](../team-and-billing/change-freeze.md) and is recorded in the [audit log](../team-and-billing/audit-log.md), like any other resource action.

If a row has no button, the provider either can't revoke over its API or only supports _rotation_ (a new secret for the same principal), which isn't the same as revoking.

## Export the evidence

Use the **CSV** or **JSON** buttons at the top of the page for one row per finding. Dismissed findings are included, labelled with the note and who accepted them, so your evidence shows both what you found and what you decided.

The CSV quotes every cell and neutralises leading `=`, `+`, `-` and `@`, so a principal name from your cloud can't run as a spreadsheet formula. Exports are recorded in the audit log.

## Alerts and the digest

Critical and high findings are included in the **posture alert**: the same daily message, the same Slack, Teams and push channels, and the same switch under **Settings > Alerts**.

The [weekly digest](./weekly-digest.md) includes an "Access review" line with the number of open findings.

## Coverage

Some providers give rich rows (last use, age, admin flag). Others only give a list entry and an owner check, depending on what that provider reports.

Not covered today:

- Kubernetes RBAC objects (roles and bindings)
- AWS access keys and GCP service-account keys
- Azure app-registration client secrets
- MFA enrolment, anywhere

Each of these would need an extra provider call per principal, which the review doesn't make.
