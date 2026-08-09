---
title: Credential hygiene
description: API keys nobody uses, SSH keys nothing references, and members holding write permissions they never exercise — from data Infrawrench already holds, with nothing to install.
sidebar_order: 5
---

Credentials accumulate. A key minted for a migration two quarters ago, an SSH key belonging to someone who changed teams, an admin role granted for one afternoon of work that nobody ever narrowed. None of it announces itself, and nobody opens a settings page to go looking.

**Settings → Credential Hygiene** does the looking. Every finding is derived from data Infrawrench already holds — no provider call, no agent, nothing to enable.

<insert [The Credential Hygiene settings page showing the summary card with the 90d window selected and a list of findings: one high-severity wildcard API key, two medium unused keys, and a member with unexercised permissions] here>

## What it looks for

**API keys.**

- **Unrestricted scope** — a key holding `*`. It can do anything its owner can, and it inherits every future widening of their role. High severity.
- **Never used** — created more than two weeks ago and has never authenticated. A credential nobody uses is one nobody would notice the loss of, in either direction.
- **Idle** — last authenticated before the start of the window. Either revoke it or find out what stopped calling; both answers beat the current one.
- **Expired but not revoked** — it can no longer authenticate, so this is tidiness rather than exposure. But a key list full of dead entries is a key list nobody reads.
- **Carries scopes it never uses** — the key is live, but some of its write scopes have never been exercised.

**SSH keys.** Keys with no recorded use over the window. Recorded uses cover terminal sessions, [fan-out](../features/ssh-fanout.md) runs, agent forwarding, and the `ssh_exec` tool. A key whose _private_ half is stored server-side is ranked higher than an imported public key — the first is a live credential sitting in a database.

Note that deleting an SSH key here does not revoke it on the host. It removes Infrawrench's copy; the corresponding line in the host's `authorized_keys` is yours to remove.

**Members.** People whose role grants write permissions they have never exercised. The finding names the specific permissions, so "narrow this role" is an actionable sentence rather than a vague one.

## What it deliberately does not claim

**The audit log only records writes.** Reading a resource list, opening a dashboard, querying costs — none of those leave an audit row, by design. So an absence of evidence says something real about `resources:delete` and nothing at all about `resources:read`.

The report is built to respect that. It only ever draws "granted but unused" conclusions about permissions the audit log can actually witness, and it says so on the page. It will never tell you a read permission looks unused, because it does not know.

Two exceptions, both deliberate: reading a credential (`secrets:read`) and watching a [recorded session](../features/session-recording.md) (`session-recordings:read`) _are_ audit-logged, precisely because both are disclosures. Those two reads are judged like writes.

**Not enough history is not a pass.** An organization three days old has three days of audit history, and "unused in 90 days" means nothing against it. Below 30 days the unused-permission findings are withheld and the page says they were withheld — rather than reporting a clean bill of health it has not earned.

**Owners are skipped.** An organization must have at least one, the role is `*` by definition, and "the owner did not exercise `billing:write` this quarter" is not something anyone can act on. Every other role — admin, member, custom — is included.

## The window

30, 90, 180 or 365 days, switchable on the page. A shorter window finds more; a longer one finds fewer but is harder to argue with. 90 days is the default because it spans a quarter — long enough that a genuinely-needed permission has had an occasion to be used.

## Acting on a finding

Each row has a **Fix** button that jumps to the page where the thing lives: [API Keys](./api-keys.md), [SSH Keys](./ssh-keys.md), or [Team](./organizations-and-invites.md). The report never revokes anything itself. Deciding that a key is dead is a judgement call with a blast radius, and a report that made that call automatically would eventually take out something load-bearing at three in the morning.

For an over-permissioned member, the usual fix is a narrower role plus [break-glass access](./break-glass-access.md) for the occasional exception — that is the pairing this report is pointing at.

## Permissions

The report needs `audit:read`, and nothing else. Every fact in it is already reachable by hand for anyone who can read the audit log, so it is a lens rather than a new disclosure — a separate permission would only mean granting two things to get one view.

## From the CLI

```
infrawrench hygiene
infrawrench hygiene --days 180
infrawrench hygiene --json
```

The `--json` form is the one worth scheduling. Unused keys and over-broad grants accumulate slowly and nobody opens a settings page to check; piping this into whatever your organization already reviews is the point.
