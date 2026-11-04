---
title: Tag policy, untagged spend & showback
description: Require tags like owner and env on every resource, score compliance per account, find the spend that carries no tags, and map spend to cost centres.
sidebar_order: 3
---

A **tag policy** is an organization rule like "every resource carries `owner` and `env`". Infrawrench scores each account against it, shows you the spend that's missing the required tags, and, if you turn on enforcement, blocks new resources that would break it. **Allocation rules** then map spend onto named **cost centres** so you can report what each team costs.

> **Cloud only.** On desktop, the Costs panel shows the same tag section when you're signed into a cloud organization. The mobile app shows the showback tree read-only. You edit the policy, cost centres and rules in the web app's organization settings.

Bills full of provider bookkeeping keys (`aws:cloudformation:*`, `goog-k8s-*`) make every tag picker harder to use. [Tag key settings](./tag-keys.md) hide those from pickers and pin the keys you report on to the top, without changing your data.

## Set up the policy

Open **Settings > Tag Policy**. Anyone with `org:settings:write` (Owner by default) can edit it:

- **Required tag keys**: for example `owner`, `env`, `team`. Keys are matched without regard to case, so `Owner` on an AWS resource satisfies a required `owner`.
- **Allowed values** (optional, per key): for example `env` must be one of `prod`, `staging`, `dev`. Values must match exactly.
- **Enforce at create time**: off by default. See [Block untagged resources](#block-untagged-resources).

![Settings > Tag Policy page with two required tags (owner with no allowed values, env with prod/staging/dev), the "Enforce at create time" checkbox ticked, and the per-account compliance table below](https://agent-assets.infrawrench.com/docs-screenshots/features/tag-policy-and-showback/tag-policy-settings.png)

## Which resources are checked

Infrawrench checks any resource that has a `tags` or `labels` field, in whatever format the provider uses. Resource types with no concept of tags are left out of the score rather than dragging it down.

## Check compliance

Each account gets a score: the percentage of its checked resources that carry every required tag (with an allowed value, where you set one). The table in **Settings > Tag Policy** shows the score next to how many resources were checked out of the account's total, so a high score over a small set doesn't overstate coverage.

You'll see the same per-account list in the **Tags & allocation** section of the Costs panel on web and desktop, and on the mobile app's Costs tab.

## Block untagged resources

With **Enforce at create time** on, any resource you create through Infrawrench (web, desktop, SDKs, API) is checked against the policy:

- The create form pre-fills the required keys in the tag field and shows what the policy needs.
- A create that's missing a required key (or uses a disallowed value) is rejected with **`422 Unprocessable Entity`** and the code `tag_policy_unmet`, listing each problem in the response body. This works like the [change freeze](../team-and-billing/change-freeze.md)'s `423`.
- Resource types whose create form has no `tags` or `labels` field are exempt, since the provider can't store them.

People with `tag-policy:override` (Admin and Owner by default) can create anyway by sending this header:

```
x-tag-policy-override: true
```

Every block and every override is recorded in the [audit log](../team-and-billing/audit-log.md) as `tag_policy.block` or `tag_policy.override`.

<insert [Resource create modal showing the amber "Org policy requires tags: owner, env (prod | staging | dev)" notice above the form fields, with the tags field pre-filled with "owner=, env="] here>

## Find untagged spend

This is where the policy pays off. On the Costs panel's **Allocation** tab, the **Tags & allocation** section shows how much of your spend (from provider billing data) is missing at least one required tag key. You see it overall, per key, and as a top list of the account and service pairs responsible. That's the spend nobody can allocate, and the top list is the quickest way to fix it.

![Costs panel "Tags & allocation" section showing the untagged spend card with "$1,234 of $9,876 missing a required tag", the per-account compliance bars, and the showback list below](https://agent-assets.infrawrench.com/docs-screenshots/features/tag-policy-and-showback/tags-allocation-section.png)

## Set up cost centres and showback

**Cost centres** are buckets you define ("Platform", "Data", "Growth") to allocate spend to. **Allocation rules** map spend onto them, matching on any mix of:

- a **tag** key (or key = value),
- an **account**,
- a **provider**,
- a **service**.

Rules run top to bottom by priority and the first match wins. Put specific rules (this one account's `team=data` spend goes to Data) above broad ones (everything on GCP goes to Platform). Spend that no rule claims shows as **Unallocated**, so nothing disappears.

You edit rules in **Settings > Tag Policy**. The report appears on the Costs panel and answers "what did each team's infrastructure cost this month" without a spreadsheet.

### Nest cost centres

Cost centres can **nest**. A division holds teams, a team holds products, and "what does Engineering cost" covers the whole branch rather than one bucket. Build the tree in **Settings > Cost Centres** (create, rename, move, delete). It can be up to **four levels** deep.

![Settings > Cost Centres page showing a three-level tree (Engineering containing Platform and Data, Platform containing Search) with the move dropdown open on one row and the deeper targets greyed out](https://agent-assets.infrawrench.com/docs-screenshots/features/tag-policy-and-showback/cost-centres-move.png)

Every centre shows **two** numbers on the Costs panel and in the API:

| Field           | Means                                                   |
| --------------- | ------------------------------------------------------- |
| `totals`        | Spend allocated **directly** to this centre             |
| `subtreeTotals` | This centre **plus every centre under it** (the rollup) |

You need both, because budget conversations sound like "Engineering $40k, of which Platform $12k". For a centre with nothing under it, the two numbers are the same.

If you already had flat cost centres, **nothing changes**. They're all top-level, `subtreeTotals` equals `totals`, and your reports read exactly as before. You can nest one centre at a time.

### How rules work with nested centres

Nesting only changes how spend is reported, not how it's matched. Each cost row still goes to exactly one centre, so nothing is counted twice:

- All rules sit in one ordered list, wherever their centres are in the tree. **Lower priority number runs first, and the first match wins.**
- If one rule targets a parent and another targets its child at the **same priority**, the **child wins**. So a parent catch-all ("everything on GCP goes to Engineering") won't swallow spend meant for a child rule ("tag `team=search` goes to Search"). The parent still sees that spend in its subtree total.

`Unallocated` always stays its own row at the bottom of the tree and is never folded into a parent.

### Delete a centre

Deleting a centre **never deletes the centres under it and never changes spend history**:

- Its children move up to the deleted centre's parent. Delete "Platform" from Engineering > Platform > Search and Search stays under Engineering. (Delete a top-level centre and its children become top-level.) This keeps their spend inside the right parent's total.
- The centre's own **allocation rules are deleted with it**, so the spend they claimed falls through to the next matching rule, often "Unallocated".

The confirmation dialog explains both and tells you how many children and rules are affected.

![Costs panel "Tags & allocation" section showing the showback tree indented two levels, with a parent row displaying its subtree total and a smaller "own" figure beneath it, and the italic Unallocated row last](https://agent-assets.infrawrench.com/docs-screenshots/features/tag-policy-and-showback/showback-tree.png)

## CLI

The [`infrawrench` CLI](./cli.md) has both reports, with `--json` for scripting:

```bash
infrawrench tags                  # policy, per-account compliance, untagged spend
infrawrench tags --last 90d --json
infrawrench showback              # spend by cost centre, last 30 days
infrawrench showback --from 2026-07-01 --to 2026-07-31
```

`showback` prints the tree indented. A parent's bar shows its **subtree** total, with its own direct spend noted beside it. That means the bars don't add up to the organization total; the leaves do. `--json` returns the full report, including `totals` and `subtreeTotals`.

## MCP and AI chat

Three read-only tools give [MCP clients and the AI assistant](./mcp.md) the same data: `get_tag_compliance`, `query_untagged_spend` and `query_showback`. You can ask things like "which team's spend grew last month" or "how much of our spend is untagged" in chat. `query_showback` returns the same tree as the panel: use `subtreeTotals` for a division, `totals` for what that division spends itself, and never add `subtreeTotals` up across entries.

## Permissions

| Permission            | Grants                                           | Default roles |
| --------------------- | ------------------------------------------------ | ------------- |
| `resources:read`      | See the policy and compliance scores             | all roles     |
| `org:settings:write`  | Edit the policy and enforcement                  | Owner         |
| `costs:read`          | Untagged spend & showback reports                | all roles     |
| `costs:write`         | Manage the cost centre tree and allocation rules | Admin, Owner  |
| `tag-policy:override` | Create a resource past the policy, per request   | Admin, Owner  |
