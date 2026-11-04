---
title: Credential hygiene
description: Find API keys nobody uses, SSH keys nothing references, and members holding write permissions they never use. Nothing to install.
sidebar_order: 5
---

Credentials pile up. A key made for a migration two quarters ago, an SSH key belonging to someone who changed teams, an admin role granted for one afternoon and never narrowed. None of it shows up on its own.

**Settings > Credential Hygiene** finds it for you. Every finding comes from data Infrawrench already has. There are no provider calls, no agent, and nothing to turn on.

![The Credential Hygiene settings page showing the summary card with the 90d window selected and a list of findings: one high-severity wildcard API key, two medium unused keys, and a member with unexercised permissions](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/credential-hygiene/findings-90d.png)

## What it looks for

**API keys**

- **Unrestricted scope:** a key holding `*`. It can do anything its owner can, and it gains every future widening of their role. High severity.
- **Never used:** created more than two weeks ago and has never authenticated.
- **Idle:** last authenticated before the start of the window. Revoke it, or find out what stopped calling it.
- **Expired but not revoked:** it can no longer authenticate, so this is tidying up rather than a risk.
- **Carries scopes it never uses:** the key is live, but some of its write scopes have never been used.

**SSH keys**

Keys with no recorded use during the window. Recorded uses include terminal sessions, [fan-out](../features/ssh-fanout.md) runs, agent forwarding and the `ssh_exec` tool. A key whose private half is stored in Infrawrench ranks higher than an imported public key, since it is a live credential.

Deleting an SSH key here does not revoke it on the host. It removes Infrawrench's copy. You still need to remove the matching line from the host's `authorized_keys`.

**Members**

People whose role grants write permissions they have never used. The finding names the specific permissions, so you know exactly what to narrow.

## What it does not claim

**Only writes are tracked.** The audit log records writes, not reads like listing resources, opening a dashboard or querying costs. So the report only says "granted but unused" about permissions the audit log can see. It will never tell you a read permission looks unused.

Two reads are the exception: reading a credential (`secrets:read`) and watching a [recorded session](../features/session-recording.md) (`session-recordings:read`) are audit-logged, so they are judged like writes.

**Too little history is not a pass.** If your organization has less than 30 days of audit history, unused-permission findings are held back, and the page tells you so.

**Owners are skipped.** Every organization needs at least one owner, and the role is `*` by definition. Every other role (admin, member, custom) is included.

## Choose a window

Pick 30, 90, 180 or 365 days on the page. A shorter window finds more. A longer one finds fewer, but each finding is harder to argue with. The default is 90 days, about a quarter.

## Fix a finding

Each row has a **Fix** button that takes you to where the item lives: [API Keys](./api-keys.md), [SSH Keys](./ssh-keys.md) or [Team](./organizations-and-invites.md). The report never revokes anything itself. That call is yours.

For an over-permissioned member, the usual fix is a narrower role plus [break-glass access](./break-glass-access.md) for the occasional exception.

## Permissions

You need `audit:read`, and nothing else. Everything in the report is already visible to anyone who can read the audit log.

## Use the CLI

```
infrawrench hygiene
infrawrench hygiene --days 180
infrawrench hygiene --json
```

Use `--json` to run it on a schedule and feed the results into whatever your team already reviews.
