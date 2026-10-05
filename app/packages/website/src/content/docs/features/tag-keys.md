---
title: Tag keys (hidden & preferred)
description: Hide noisy tag keys like aws:cloudformation:* from every tag picker and pin the keys your team reports on to the top, without touching any cost data.
sidebar_order: 3
---

Cloud bills carry far more tag keys than anyone groups by. AWS stamps `aws:cloudformation:stack-id`, `aws:cloudformation:logical-id` and `aws:autoscaling:groupName` on everything it creates, GKE adds `goog-k8s-*` labels, and Kubernetes adds `kubernetes.io/*`. The two or three keys your team actually reports on (`team`, `env`, `cost-centre`) end up buried alphabetically between them in every dropdown.

**Tag key settings** fix that for the whole organization, in one place:

- **Hidden keys** disappear from every tag picker and group-by dropdown. An entry is either an exact key (`Name`) or a prefix pattern ending in `*` (`aws:cloudformation:*`).
- **Preferred keys** are pinned to the top of every picker, in the order you set, under a **Preferred** heading.

> **A display preference, nothing more.** Hiding a key changes what the pickers offer. The key's cost rows are still collected and stored, [cost exports](./cost-exports.md) still carry it, and a filter or report that names it keeps working. Nothing you have already saved changes what it measures.

> **Cloud only.** The settings are org-level cloud state. They apply on the web app, the desktop app signed into a cloud org, the mobile app, the [CLI](./cli.md) and the [MCP tools](./mcp.md).

## Where the settings apply

Every place you pick a tag key:

- **Cost graphs**: group-by **Tag** on dashboards, [cost reports](./cost-reports.md) and the Costs panel.
- **Filters**: the tag key field of every filter row, so [saved filters](./cloud-costs.md), [budgets](./cloud-costs.md#budgets) and change-alert scopes. The field stays free text, with your keys as suggestions, because a hidden key is still a valid filter.
- **Change alerts**: the tag key when an alert watches each tag value separately.
- **Cost centre and billing rules**: the tag key picker on [allocation rules](./tag-policy-and-showback.md) and [billing rules](./billing-rules.md), which drive showback.
- **Cost export columns**: suggestions for the tag columns to include.
- **Resource inventory**: the tag picker in a [metric alert](./metric-alerts.md)'s resource selector, which lists keys from your synced resources rather than from cost data.

If something you saved before uses a key you later hide, its picker still shows the key, marked as not in the list, so it is never silently changed.

## Editing the settings

Open **Settings → Tag Keys** on the web app, or the Settings tab on the desktop app.

<insert [Settings → Tag Keys page: the Preferred keys card with team, env and cost-centre in order, the Hidden keys card with aws:cloudformation:* and two suggested patterns, and the discovered keys table below] here>

The **Discovered tag keys** table lists every key in the last 90 days of cost data and in your resource inventory, busiest first, with:

- the providers that use it,
- how many cost rows carry it and how many resources,
- the last day it appeared in cost data,
- and its status: **Visible**, **Preferred**, **Hidden**, or **Hidden by** the pattern that matched.

Use **Pin** and **Hide** on a row, or type an exact key or a prefix pattern into **Hidden keys**. As you type a pattern, the page tells you how many discovered keys it matches. **Suggested from your data** offers one-click patterns for namespaces several of your keys share, like `aws:cloudformation:*`. Reorder preferred keys with the arrows. Changes apply when you click **Save tag keys**.

Pattern rules:

- An exact entry matches that key only. Matching is case-sensitive: `Env` and `env` are different keys, the same way providers treat them.
- A prefix pattern ends in a single `*` and matches every key starting with what comes before it. `*` anywhere else, or on its own, is rejected.
- A preferred key always stays visible, even when a hidden prefix covers it. That is how you keep `aws:team` while hiding the rest of `aws:*`.
- A key cannot be both preferred and hidden by its exact name.
- Up to 200 hidden entries and 50 preferred keys.

Anyone who can see resources can read the settings; changing them needs the `org:settings:write` permission (admins and owners). Every save is recorded in the [audit log](../team-and-billing/audit-log.md).

## From the CLI

```
infrawrench tag-keys                              # every key, with providers, usage and status
infrawrench tag-keys --json
infrawrench tag-keys hide 'aws:cloudformation:*'  # quote patterns so the shell leaves * alone
infrawrench tag-keys unhide 'aws:cloudformation:*'
infrawrench tag-keys pin team
infrawrench tag-keys unpin team
```

See [CLI](./cli.md).

## Over the API and Terraform

- `GET /api/org/{orgId}/tag-keys` lists discovered keys with their usage and status.
- `GET` / `PUT /api/org/{orgId}/tag-keys/settings` reads and replaces the `{ hidden, preferred }` document.
- `GET /api/org/{orgId}/costs/dimensions?dimension=tag-keys` returns keys with the settings applied: preferred first and flagged `preferred`, hidden keys left out. Add `includeHidden=true` to get them too, flagged `hidden`.

The [Terraform provider](./terraform-provider.md) manages the settings as the `infrawrench_tag_key_settings` singleton:

```hcl
resource "infrawrench_tag_key_settings" "this" {
  hidden_keys    = ["aws:cloudformation:*", "aws:autoscaling:*", "Name"]
  preferred_keys = ["team", "env", "cost-centre"]
}
```

## For AI assistants

The [MCP](./mcp.md) tool `list_cost_dimension_values` with `dimension: "tag-keys"` follows the same settings: preferred keys come first and are flagged, hidden keys are left out unless the assistant passes `includeHidden: true`. Because hidden keys are still queryable, an assistant asked about a hidden key by name can still answer.

## Related

- [Tag policy, untagged spend & showback](./tag-policy-and-showback.md): require tags and map spend to cost centres.
- [Cloud costs](./cloud-costs.md): cost graphs, filters and budgets.
