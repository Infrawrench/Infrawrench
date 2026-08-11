---
title: Ephemeral environments
description: Capture the environment you already have as a reusable template, stamp out a fresh copy on demand with a required time-to-live, and let it delete itself when the clock runs out.
sidebar_order: 13
---

The [environment diff](./environment-diff.md) tells you that staging and production have drifted apart. **Ephemeral environments** are the next step: take the environment you already have, turn it into a template, and stamp out a fresh copy whenever you need one — for a pull request, a load test, a demo, a migration rehearsal — with an expiry attached so it cannot quietly become permanent.

Everything about a template is built from the plugin's own create form. Infrawrench has no per-provider recipe book; if a plugin can create a resource type, that type can be captured, and if it can't, the capture says so instead of pretending.

<insert [The Environments page with two live environments counting down and three templates listed below them] here>

## Capture a template

Open **Environments** from the sidebar and choose **Capture template**. Pick the account holding the environment you want to copy, and optionally narrow it with a tag (for example `env` = `staging`).

Infrawrench reads the selected resources and shows you a draft:

- **What was captured.** Each resource, its type, and how many of its fields are reproducible. A field only appears if the plugin's create form has a matching input — anything the provider derives (ids, timestamps, computed endpoints) is dropped, because feeding it back would fail.
- **What was skipped, and why.** A resource whose plugin cannot create that type is listed with a reason. It is never silently omitted; a template that quietly lost your database is worse than one that tells you it couldn't take it.
- **References that were preserved.** If your app resource points at your database — through an [output reference](../core-concepts/output-references.md) you wired up, or simply by carrying the database's id in one of its fields — that link is captured as a _reference_, not as a copied string. This is the part that makes a template more than a list: when you stamp out a copy, the new app gets the _new_ database's connection string.
- **What should vary.** Fields the plugins describe as knobs — region pickers, size pickers, disk sliders — are offered as **parameters** you can set at instantiation. Everything you leave unchecked is captured exactly as it is today.

Give the template a name and save it. Capture writes nothing until you do.

<insert [The capture preview showing four captured resources, one skipped with its reason, and a Region checkbox under "What should vary?"] here>

## Stamp one out

Press **Stamp out** on a template and fill in three things:

- **A name.** It becomes the prefix on every resource the environment creates, so `pr-482` gives you `pr-482-api`, `pr-482-db`, and so on. Two copies of one template never collide.
- **A time to live.** This is required — there is no "forever" option. Pick a preset or type a number of hours, up to the ceiling your organization sets (see below).
- **Any parameters** the template declares.

Before you commit, the form shows a **cost estimate** for the whole environment, drawn from the same [forward-looking estimates](./cost-estimates.md) the create form uses, plus what the chosen TTL works out to. A resource the provider cannot price is reported as unpriced rather than counted as free — "at least $X/month" is an honest answer, `$0` is not.

<insert [The stamp-out dialog with a TTL of 3 days selected, a Region parameter, and the estimated cost line showing "At least $214.60/month"] here>

Infrawrench then creates the resources **in dependency order**: anything referenced by something else is created first, and the reference is filled in with the freshly created resource's real id or output. Each resource is created through exactly the same path the create form uses, so plugins, permissions, tag policies and audit logging all behave identically.

### If something fails half-way

A partially created environment is recorded, not abandoned. Every member is written down before the first resource is created, and each one is marked as created the moment the provider returns. If the fourth of six creates fails, you get an environment marked **partially created**, listing the three resources that exist and the error on the fourth — and you can tear it down with one button.

This is deliberate: the one failure that would genuinely cost you money is a cloud resource that exists with nothing in Infrawrench pointing at it. That cannot happen here.

## Expiry and teardown

Each resource an environment creates gets a [lease](./resource-leases.md) set to the environment's deadline, with auto-delete switched on. That means expiry is handled by the machinery you already have:

- You are **warned twice** before anything is deleted, through the same [expiry radar](./expiry-radar.md) and alert routing as every other lease.
- Deletion **defers during a [change freeze](../team-and-billing/change-freeze.md)** rather than being skipped — the environment is still going away, just not during the freeze.
- A failed delete is **retried and then reported**, never dropped silently.

You can also tear an environment down at any time with **Tear down**. Resources are deleted newest-first, and the operation is safe to repeat: a resource that is already gone, or one the provider answers "not found" for, counts as done. Once an environment is torn down you can **Forget** it to remove the record; Infrawrench refuses to forget one that still owns resources.

## Guardrails

Environments spend real money, so the page is fenced:

| Guardrail                     | What it does                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Time to live is mandatory** | An environment cannot be created without a deadline.                                                                                                                                                                                                                                                                           |
| **Organization TTL ceiling**  | Set the maximum and the pre-filled default under **Limits** on the Environments page. The hard ceiling is 720 hours — an "ephemeral" environment that outlives a month is just infrastructure nobody owns.                                                                                                                     |
| **Permissions**               | Viewing needs `resources:read`; editing templates needs `resources:write`. Stamping one out needs **both** `resources:write` and `resources:delete`, because the auto-delete lease it carries is a standing instruction to delete. Tearing down needs `resources:delete`. Changing the TTL ceiling needs `org:settings:write`. |
| **Change freezes**            | Both stamping out and tearing down are blocked while an org [change freeze](../team-and-billing/change-freeze.md) is in effect.                                                                                                                                                                                                |
| **Cost estimate first**       | The projected monthly cost is shown before the button does anything.                                                                                                                                                                                                                                                           |
| **Live environment cap**      | An organization may hold 50 live environments at once, and a template may hold 50 resources.                                                                                                                                                                                                                                   |

## What it doesn't do yet

- **Pull-request environments.** The API is shaped so an automation can drive it — one call to stamp out, one idempotent call to tear down — but Infrawrench does not yet watch your pull requests or post URLs back to them.
- **Editing a saved template in the UI.** Templates can be captured, listed and deleted from the page; changing one in place is an API call today (`PUT /environments/templates/{id}`). Re-capturing is the usual route.
- **Local desktop mode.** An environment is created against organization accounts and torn down by the cloud, so the desktop app shows it in cloud mode only. It is not on mobile at all — stamping out infrastructure is a desk task.

## See also

- [Environment diff](./environment-diff.md) — why staging and production disagree in the first place
- [Resource leases](./resource-leases.md) — the TTL mechanism environments are built on
- [Cost estimates](./cost-estimates.md) — where the projected cost comes from
- [Output references](../core-concepts/output-references.md) — the links a capture preserves
