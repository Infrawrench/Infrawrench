---
title: Offboarding
description: When someone leaves, see everything tied to them across your connected providers and Infrawrench on one checklist, revoke each item where the provider allows it, and export the result for your auditor.
sidebar_order: 14
---

When someone leaves, their access is spread across a dozen places: an IAM user here, a GitLab membership there, a Copilot seat, the API key a cron job uses, next week's on-call shift. Offboarding lines all of it up for one person, on one checklist you can work through over a few days and hand to an auditor at the end.

![The Offboarding tab on one person's checklist: the progress bar at 7 of 12, the aliases row with "jdoe-gh", and the Cloud access group showing a GitLab group member with a Remove button and an exact match, plus a possible Docker Hub match with "It's them" and "Not them" buttons](https://agent-assets.infrawrench.com/docs-screenshots/features/offboarding/checklist.png)

## Find it

Click **Offboarding** in the sidebar, on web or the desktop app (signed in to Infrawrench Cloud). You can also start one from **Settings > Team**: each member has a **Start offboarding** button.

## Start an offboarding

Enter the email address the person signed in with, plus any **aliases**: the names providers know them by, like a GitHub login, a GitLab username or an address at an old domain. Then click **Start offboarding**.

Infrawrench sweeps what it already knows and saves the result as a checklist. Nothing is changed in any provider until you act on a row. Starting again for someone who already has an open checklist takes you back to it.

## What it finds

| Group             | What                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infrawrench       | Their membership of your organization, their API keys and their SSH keys                                                                                          |
| Cloud access      | Principals from the [access review](./access-review.md): IAM users, organization and group memberships, personal tokens and keys                                  |
| Paid seats        | Seats from [SaaS seats](./saas-seats.md), matched by the seat's email or login                                                                                    |
| Resources         | Anything synced that names them in a field (a creator, an owner tag), and everything [ownership](../core-concepts/resource-ownership.md) records them as owner of |
| On-call           | [Rotations](./on-call.md) they sit in, and covers they haven't served yet                                                                                         |
| Leases and grants | [Leases](./resource-leases.md) they set, and [just-in-time](./just-in-time-access.md) grants they hold or have asked for                                          |

The sweep only reads what your accounts have already synced. It makes no extra provider calls, so it's quick to run again: click **Rescan** after a sync, or after adding an alias.

## How matching works

Every row says why it's on the list and how sure the sweep is:

- **Exact**: their email address.
- **Alias**: one of the aliases you listed.
- **Possible**: something weaker, like the part of their email before the `@`, the same name at another domain, or their full name.

A possible match offers no action until you confirm it. Click **It's them** to confirm or **Not them** to set it aside. Rows you set aside leave the checklist and its progress, but stay in the export with that decision. You can restore one from **Not them** at the bottom.

## Act on each row

Each row has the actions its provider allows:

| Row                     | Action                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Organization membership | **Remove from organization**, the same as on the team page (only an owner can remove an owner)                             |
| API key                 | **Revoke key**                                                                                                             |
| SSH key                 | **Delete key**                                                                                                             |
| Cloud access            | **Revoke** (the provider's own revoke, like deactivating a key or suspending a user) or **Remove** (removing a membership) |
| Paid seat               | **Remove seat**                                                                                                            |
| Resource                | **Transfer ownership** to another member                                                                                   |
| Rotation                | **Reassign** their slot to another member, or **Remove from rotation**                                                     |
| Cover                   | **Cancel cover**                                                                                                           |
| Lease                   | **Cancel lease**                                                                                                           |
| Just-in-time grant      | **Revoke grant**                                                                                                           |

Every action asks you to confirm first and is recorded in the [audit log](../team-and-billing/audit-log.md). Actions that reach a provider respect [change freezes](../team-and-billing/change-freeze.md).

If the provider refuses, the row is marked **Failed** with the provider's message, and you can try again. A row with no button is something the provider doesn't let Infrawrench do over its API: do it in the provider's console, then click **Mark done**. **Skip** is for a row that doesn't need doing.

When a later scan no longer finds a row (somebody removed it in the provider's console, say), it's marked **No longer found** and counts as resolved.

### Which providers can remove a member

**Remove** is offered on memberships where deleting removes the person's access and nothing else:

- [OpenAI](../plugins/openai.md): organization users and project users
- [Anthropic](../plugins/anthropic.md): organization users and workspace members
- [Docker Hub](../plugins/docker-hub.md): organization members
- [GitLab](../plugins/gitlab.md): group members and project members
- [Turso](../plugins/turso.md): organization members

**Revoke** is offered wherever the [access review](./access-review.md#revoke-access) offers it, such as Tailscale users, Datadog users, WorkOS memberships and many providers' API keys. Paid seats can be removed on every provider that [SaaS seats](./saas-seats.md#supported-providers) can remove them on.

## Finish and export

The progress bar counts done, skipped and no-longer-found rows. Click **Complete** when you're finished. A completed or cancelled offboarding is frozen as a record and isn't rescanned. You can **Reopen** it if you need to.

Click **Export CSV** for one row per item: what was found, why, what was decided, who did it and when. Cells are quoted and spreadsheet formulas neutralised. Exports are recorded in the audit log.

Offboardings also feed [compliance evidence](./compliance.md), under SOC 2 CC6.3 and ISO 27001 5.16 and 5.18. Access still open a week after someone's offboarding started is reported as a gap.

## Use the CLI

```sh
infrawrench offboard                                  # every offboarding, with progress
infrawrench offboard jane@example.com                 # their checklist, or what a sweep finds (not saved)
infrawrench offboard jane@example.com --alias jdoe-gh # include a handle
infrawrench offboard jane@example.com --start         # start (or rejoin) their checklist
infrawrench offboard jane@example.com --json
```

The CLI reads and starts checklists. You act on rows in the app, where each one shows exactly what it will do.

## Permissions

- Everything here needs `team:remove`, the permission that removes a member.
- Each action also needs the permission its own page asks for: `resources:write` to revoke cloud access, remove a seat, transfer ownership or cancel a lease; `resources:delete` to remove a membership; `apikeys:write` for API keys; `team:role:write` for someone else's SSH key; `org:settings:write` to change a rotation.

## Not available yet

- The mobile app doesn't show offboardings.
- Starting an offboarding automatically when your identity directory deprovisions someone. Checklists are ready for it (they're marked **From the directory** when started that way), and it arrives with directory sync.
- Provider accounts that aren't connected to Infrawrench aren't swept. Connect them first.
- Kubernetes RBAC, AWS access keys and GCP service-account keys aren't synced, so they aren't found (the [access review](./access-review.md#coverage) has the full list).
