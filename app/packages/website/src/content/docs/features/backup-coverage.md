---
title: Backup coverage
description: See what is actually recoverable across every provider, which resources have a backup, how old the newest one is, and which backups protect something that no longer exists.
sidebar_order: 9
---

**Backups** shows what you could actually recover today. The [Expiry radar](./expiry-radar.md) tells you what's about to run out and [Posture](./posture-checks.md) tells you what's exposed. Backups answers the question most teams can't answer off the top of their head: _what is your actual RPO?_

Open it from the sidebar. It has four views:

- **Gaps**: stateful resources with no backup, resources whose newest backup is older than your policy allows, retention windows shorter than you asked for, and backups whose source resource is gone.
- **Coverage**: every stateful resource Infrawrench can judge, what protects it, how old that protection is, and which policy applies.
- **Policies**: the recovery objectives everything else is measured against.
- **Drills**: whether anyone has actually restored these backups, and how long it took.

![The Backups workspace tab on the Gaps view, showing the three summary cards (Worst RPO, Unprotected, Orphaned backups) above a table of findings with mixed severities](https://agent-assets.infrawrench.com/docs-screenshots/features/backup-coverage/gaps-view.png)

## Where the answers come from

Backups uses the inventory Infrawrench has already synced, like the expiry radar and posture checks. Opening it makes no provider API calls, so it costs nothing and never counts against a rate limit. It reflects your last sync, not a live check.

Coverage is only as good as what each provider's listing tells Infrawrench. If a provider exposes nothing readable for a resource, the resource is left off the Coverage table instead of showing up as a false alarm.

### What's covered today

| Provider      | Backups                              | Protected resources                                      |
| ------------- | ------------------------------------ | -------------------------------------------------------- |
| DigitalOcean  | Snapshots (of Droplets and volumes)  | Droplets (including the automated-backup flag), volumes  |
| Hetzner Cloud | Images of type `backup` / `snapshot` | Servers                                                  |
| Linode        | None (Backups add-on flag)           | Linodes (the Backups add-on), Managed Databases (daily)  |
| Google Cloud  | Spanner backups                      | Spanner databases                                        |
| Neon          | Snapshots                            | Branches                                                 |
| PlanetScale   | Backups                              | Branches                                                 |
| Azure         | None                                 | PostgreSQL and MySQL Flexible Servers (retention window) |

AWS is **not** covered yet. Infrawrench doesn't currently list EBS or RDS snapshots or read RDS backup retention, so it has nothing to check against. Rather than report every EBS volume as unprotected, AWS is left out.

## Read the coverage states

Each resource on the Coverage table is in one of five states:

- **Backed up**: at least one backup exists, inside the RPO (or no RPO applies).
- **Provider-managed**: the provider's own automated backups are on. There is a restore point, but Infrawrench can't list it, so no RPO can be measured.
- **Stale**: backups exist, but the newest is older than a policy allows.
- **Not assessed**: the resource has a provider backup setting, but its value couldn't be read. Usually a fresh sync fixes this. **This is never reported as a gap** and never appears in the weekly digest. It means "not checked", not "no backup".
- **Unprotected**: nothing protects it, and Infrawrench had the data to tell.

Three answers are deliberately cautious:

- A backup with no readable timestamp counts as a backup, but it can never meet an RPO. A backup you can't date isn't proof of a recent one.
- A backup whose source can't be worked out (no source field, an empty field, or more than one matching resource) is shown as **unattributable**, never as orphaned. That way you're never told to delete a backup that might still be protecting something.
- A resource whose backup setting can't be read is **not assessed**, never unprotected. Missing data doesn't raise an alarm.

The unattributable and not-assessed counts sit next to the severity chips, so "nothing wrong" and "couldn't tell" never look the same.

## Find orphaned backups

A backup whose source resource is gone is pure cost: you're paying for storage you can never restore onto anything. Where cost data is available, each one shows a trailing 30-day cost so you can decide with a real number. Where it isn't, the cost shows as unknown, never as zero.

![The Gaps view filtered to Orphaned snapshot, showing several rows with sizes and monthly costs](https://agent-assets.infrawrench.com/docs-screenshots/features/backup-coverage/gaps-orphaned-filter.png)

## Set recovery policies

A policy is a recovery objective: which resources it covers, and what it expects of them.

- **Selector**: a set of resource types, a tag (`env=production`), or both. Leave both empty and the policy covers every stateful resource.
- **Maximum RPO**: the newest backup must be no older than this many hours.
- **Minimum retention**: the provider's retention window must be at least this many days.

A policy must set at least one of the two, since a policy that asks for nothing could never find a problem.

When several policies cover the same resource, the strictest wins: the shortest RPO and the longest retention. These can come from different policies. A common setup is "everything, 24 hour RPO" alongside "production databases, 30 day retention". Each finding names the policy it breaks, so the link takes you to the one you need to change.

Turn a policy **off** to stop it judging anything without deleting it. That's useful for quieting a noisy objective while you look into it.

Creating, editing and deleting policies needs the **organization settings** permission. Anyone who can read your resources can see coverage. A member can see that a database is unprotected, but can't relax the target.

![The Policies view with two policies listed, one selecting production-tagged databases with a 6 hour RPO, one applying to everything with a 24 hour RPO](https://agent-assets.infrawrench.com/docs-screenshots/features/backup-coverage/policies-view.png)

## Where else it shows up

- The **weekly digest** includes a Backups line whenever anything is unprotected or past its RPO.
- Backup gaps don't page anyone. They're an ongoing condition, not an event, so the weekly digest is where they belong.

## Record restore drills

Everything above tells you _is there a backup, and how old is it_. It can't tell you what matters on the bad day: **does it restore, and how long does it take?**

Plenty can go wrong between a backup and a working restore: a snapshot that restores into a region with no capacity, a dump taken from a replica that was already broken, an encrypted volume whose key was rotated last quarter.

<insert [The Backups Drills tab showing the four summary cards (Verified, Stale, Never verified, Worst measured RTO) above a list of protected resources with their standings, one expanded to show the record-a-drill form] here>

### Infrawrench records drills, it doesn't run them

A drill is **a record that someone tried a restore**. Infrawrench doesn't restore your database on a schedule. An unattended restore costs real money, can collide with production, and there's no general way to check that what came back is correct.

What Infrawrench does is keep the exercise on a schedule, record it, and show you when it lapses.

### Drill outcomes

| Outcome                   | Means                                         |
| ------------------------- | --------------------------------------------- |
| **Restored and checked**  | It came back, and you looked inside.          |
| **Restored, not checked** | It came back. Nobody verified what was in it. |
| **Restore failed**        | You tried and it did not work.                |
| **Could not attempt**     | No capacity, no key, no time.                 |

Only **restored and checked** counts as evidence. A running database nobody looked inside is how teams find out mid-incident that the dump had been empty for months. Still record the attempt. It just doesn't reset the clock.

A verified drill **must** include the measured restore time. An RPO comes from the backup, but an RTO only comes from someone timing the restore, and that's the number you're after. A drill that couldn't be attempted can't include a time, because it never started.

### Drill standings

- **Verified**: a checked restore inside the window (180 days by default).
- **Stale**: it worked, but a while ago.
- **Last attempt failed**: someone tried more recently than the last success and it didn't work. This outranks the earlier success.
- **Never verified**: nobody has produced evidence yet, including when every drill was a restore nobody checked.

"Never verified" and "Stale" are kept apart because they lead to different conversations: one is _nobody has ever tried_, the other is _it worked in March_.

Only resources with something to restore appear here. A resource with **no** backup is a coverage gap, which the Gaps view already shows.

Drills recorded against a resource you've since deleted are kept and shown separately, since auditors ask about those too.

### Permissions

Recording a drill needs **Resources: write**, not the settings permission that policies need. The person who spent Saturday restoring a database is rarely the one who set the objective. Deleting a drill is recorded in the audit log.

## Related

- [Expiry radar](./expiry-radar.md): what's about to run out
- [Posture checks](./posture-checks.md): what's exposed
- [Orphan finder](./orphan-finder.md): what's idle or unattached
