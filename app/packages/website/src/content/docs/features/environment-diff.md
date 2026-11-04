---
title: Environment diff
description: Compare two accounts of the same provider side by side: resource types in one and not the other, differences in counts, and the settings where matching resources disagree.
sidebar_order: 12
---

Staging works. Production doesn't. Somewhere between them is a database on a smaller plan, a queue nobody created, or a flag flipped in one place and not the other. Finding it usually means opening the same provider console in two tabs and comparing by eye.

Environment diff does that comparison for you. Point it at two accounts of the same provider and it shows:

- **What exists in one and not the other.** Resource types in staging that are missing from production, and the other way round.
- **How the counts differ.** Three droplets here, five there, for each resource type.
- **Where matching resources disagree.** The instance class, engine version, replica count or a feature flag, field by field, with both values side by side.

Like the [orphan finder](./orphan-finder.md), the [expiry radar](./expiry-radar.md) and [posture checks](./posture-checks.md), it costs nothing to leave on. It uses data your accounts already sync, so it makes no extra provider API calls and doesn't count against your rate limits. It works with every provider.

## How resources are matched

Resources in two accounts have different ids, so the diff matches them by **resource type plus name, ignoring environment words**. `api-staging` lines up with `api-prod`, and `acme-blue-worker` lines up with `acme-green-worker`.

The words it ignores are `prod`, `production`, `prd`, `live`, `stg`, `stage`, `staging`, `dev`, `test`, `qa`, `uat`, `sandbox`, `preview`, `preprod`, `demo`, `canary`, `beta`, `alpha` and `local`, plus **every word in the two account names**. So if your accounts are called "Acme Blue" and "Acme Green", `acme`, `blue` and `green` are ignored too, and you don't have to set up a naming convention.

If several resources of one type end up with the same name, they're paired up as far as they go, and any left over are shown as present on one side only.

## What it hides

Every production resource has a different id, IP address and creation time from its staging twin. Listing those would bury the field that actually differs, so by default the diff hides:

- fields that hold an identifier, link or network address, such as `vpcId`, `arn`, `endpoint`, `publicIpAddress`, `selfLink` and `fqdn`
- values that are timestamps on both sides, such as `createdAt` and `launchTime`
- values that are each side's own provider id

Everything else is shown: instance class, engine version, replica count, boolean flags. It never decides a configuration difference is "probably fine". The number of hidden fields is always shown, and **Show ids, addresses & timestamps** (or `--all` on the command line) turns the filter off.

## Compare two accounts

1. Open **Env diff** in the sidebar.
2. Pick a baseline account.
3. Pick a comparison account. Only accounts from the same provider are offered.

![The Env diff screen with a staging and a production account selected, showing the inventory table with a count delta and one resource type flagged as missing, and a field divergence below it](https://agent-assets.infrawrench.com/docs-screenshots/features/environment-diff/staging-vs-production.png)

The two accounts you picked are saved in the URL, so you can bookmark a comparison or paste it into a chat. Resource names link to the resource itself.

## From the command line

The [CLI](./cli.md) prints the same comparison:

```bash
# by name, id, or unique name prefix
infrawrench diff -a staging -b prod

# positionally, which reads better for the common case
infrawrench diff staging prod

# one resource type, ids and timestamps included, machine-readable
infrawrench diff staging prod --type managed_database --all --json
```

`--local` compares two accounts in the desktop app's own workspace instead of an organization's. This mode lists both accounts live from the provider, so it's slower and needs the accounts' credentials, but it works signed out. If listing a resource type fails, that type is left out and reported, not counted as missing.

## From an agent

The [MCP server](./mcp.md) offers the comparison as `diff_environments`, which takes the two accounts by id or exact name. Use it when you ask an agent why one environment behaves differently from another. The agent gets the type differences and field differences in one call.

## Permissions and freshness

Viewing a diff needs `resources:read`, the same permission as the account pages. Nothing is changed and no provider is contacted.

Results are as fresh as the last sync. If you've just changed something, sync the account first (or wait for the next sync) and run the comparison again.
