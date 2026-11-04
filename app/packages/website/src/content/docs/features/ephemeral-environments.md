---
title: Ephemeral environments
description: Capture an environment you already have as a reusable template, stamp out a fresh copy on demand with a required time to live, and let it delete itself when time runs out.
sidebar_order: 13
---

Ephemeral environments let you turn an environment you already run into a template, then stamp out a fresh copy whenever you need one: for a pull request, a load test, a demo or a migration rehearsal. Every copy has an expiry, so it can't quietly become permanent.

If the [environment diff](./environment-diff.md) shows staging and production drifting apart, this is the natural next step.

You can capture any resource type that its provider integration can create in Infrawrench. If a type can't be created, the capture tells you instead of leaving it out.

![The Environments page with two live environments counting down and three templates listed below them](https://agent-assets.infrawrench.com/docs-screenshots/features/ephemeral-environments/environments-overview.png)

## Capture a template

1. Open **Environments** from the sidebar and choose **Capture template**.
2. Pick the account that holds the environment you want to copy. You can narrow it with a tag, for example `env` = `staging`.
3. Review the draft Infrawrench shows you (see below).
4. Give the template a name and save it. Nothing is written until you save.

The draft shows:

- **What was captured.** Each resource, its type, and how many of its fields can be reproduced. Values the provider generates for you (ids, timestamps, computed endpoints) are left out.
- **What was skipped, and why.** Any resource that can't be created is listed with a reason, so you never end up with a template that silently lost your database.
- **References that were kept.** If your app points at your database, through an [output reference](../core-concepts/output-references.md) or just by holding the database's id in a field, that link is saved as a reference. When you stamp out a copy, the new app gets the new database's connection string.
- **What should vary.** Settings like region, size or disk are offered as **parameters** you can set each time you stamp one out. Anything you leave unchecked is captured exactly as it is today.

![The capture preview showing four captured resources, one skipped with its reason, and a Region checkbox under "What should vary?"](https://agent-assets.infrawrench.com/docs-screenshots/features/ephemeral-environments/capture-preview.png)

## Stamp out an environment

Press **Stamp out** on a template and fill in:

- **A name.** It becomes the prefix on every resource, so `pr-482` gives you `pr-482-api`, `pr-482-db` and so on. Two copies of one template never collide.
- **A time to live.** This is required, and there's no "forever" option. Pick a preset or type a number of hours, up to your organization's ceiling (see [Guardrails](#guardrails)).
- **Any parameters** the template declares.

Before you confirm, the form shows a **cost estimate** for the whole environment (from the same [cost estimates](./cost-estimates.md) the create form uses), what your chosen time to live works out to, and the environment's [estimated monthly carbon](./carbon.md). If a resource can't be priced, it's reported as unpriced rather than free, so you'll see "at least $X/month" instead of a misleading `$0`.

![The stamp-out dialog with a TTL of 3 days selected, a Region parameter, and the estimated cost line showing "At least $214.60/month"](https://agent-assets.infrawrench.com/docs-screenshots/features/ephemeral-environments/stamp-out-dialog.png)

Infrawrench creates resources in dependency order, so anything another resource points at is created first and the link is filled in with the new resource's real id or output. Permissions, tag policies and audit logging all apply just as they do in the normal create form.

### If creation fails part way

You won't be left with untracked resources. If, say, the fourth of six resources fails to create, the environment is marked **partially created**. It lists the three resources that exist and the error on the fourth, and you can tear it all down with one button.

## Expiry and teardown

Each resource in an environment gets a [lease](./resource-leases.md) set to the environment's deadline, with auto-delete turned on. That means:

- You're **warned twice** before anything is deleted, through the [expiry radar](./expiry-radar.md) and your usual alert routing.
- During a [change freeze](../team-and-billing/change-freeze.md), deletion **waits** until the freeze ends rather than being skipped.
- A failed delete is **retried and then reported**, never dropped silently.

Expiry runs in the cloud. You don't need the Environments page open, and closing your laptop doesn't extend an environment's life. If Infrawrench has trouble attaching a lease to a resource, it keeps retrying and shows the reason against that resource.

To remove an environment early, press **Tear down**. It's safe to press again: anything already gone counts as done. Once it's torn down, press **Forget** to remove the record. You can't forget an environment that still owns resources.

### When Infrawrench won't delete for you

Very rarely, a resource gets created but Infrawrench loses track of its id (for example, if the process is interrupted mid-run). Teardown then looks for a resource with the name it would have had. If it finds one, it **tells you instead of deleting it**:

> A resource carries the name this member would have had (`i-0abc123`), but nothing proves this environment created it. It has been left running. Delete it yourself if it is not wanted, then tear this environment down again to close it out.

A matching name doesn't prove the resource came from this environment, and Infrawrench won't risk deleting something you manage yourself. If you see this message, check the resource, delete it yourself if you don't want it, then press **Tear down** again.

Everything else is deleted for you as normal.

## Guardrails

Environments spend real money, so they come with limits:

| Guardrail                     | What it does                                                                                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Time to live is mandatory** | You can't create an environment without a deadline.                                                                                                                                                                                                                                     |
| **Organization TTL ceiling**  | Set the maximum and the pre-filled default under **Limits** on the Environments page. The hard ceiling is 720 hours.                                                                                                                                                                    |
| **Permissions**               | Viewing needs `resources:read`. Editing templates needs `resources:write`. Stamping one out needs **both** `resources:write` and `resources:delete`, because it sets up automatic deletion. Tearing down needs `resources:delete`. Changing the TTL ceiling needs `org:settings:write`. |
| **Change freezes**            | Stamping out and tearing down are both blocked during an org [change freeze](../team-and-billing/change-freeze.md).                                                                                                                                                                     |
| **Cost estimate first**       | You see the projected monthly cost before anything is created.                                                                                                                                                                                                                          |
| **Live environment cap**      | An organization can have 50 live environments at once, and a template can hold 50 resources.                                                                                                                                                                                            |

## What it doesn't do yet

- **Pull-request environments.** You can drive environments from your own automation through the API (one call to stamp out, one repeatable call to tear down), but Infrawrench doesn't watch your pull requests or post URLs back to them yet.
- **Editing a saved template in the app.** You can capture, list and delete templates on the page. To change one in place, use the API (`PUT /environments/templates/{id}`), or just capture it again.
- **Local desktop mode.** Environments run against organization accounts, so the desktop app shows them in cloud mode only. They aren't available on mobile.

## See also

- [Environment diff](./environment-diff.md): see where staging and production disagree
- [Resource leases](./resource-leases.md): the expiry that environments use
- [Cost estimates](./cost-estimates.md): where the projected cost comes from
- [Output references](../core-concepts/output-references.md): the links a capture keeps
