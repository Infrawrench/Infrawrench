---
title: Virtual tags
description: Tags you compute from your own rules. Merge tag spellings, assign values by any cost filter, split shared spend by percentage or by a business metric, and use the result everywhere a tag works.
sidebar_order: 11
---

**Provider tags are whatever each team managed to apply.** One account says `env`, another `Environment`, a third `ENV`. Half the estate carries a `team` tag. The shared database has no owner at all. A virtual tag is the answer you actually want to report on, defined once as an ordered list of rules and usable as a cost dimension everywhere a provider tag is.

Open **Settings → Virtual Tags** to create and edit them.

<insert [Settings → Virtual Tags list with two tags, one Ready with coverage stats and top values, one Processing] here>

## How a virtual tag decides a value

A virtual tag has a **key** (how filters address it, for example `team`), a display name, an ordered list of **rules**, and an optional **default value**.

Every cost row is checked against the rules **top to bottom**. The first rule the row matches decides its value. A row no rule matches takes the default value, or is left unset when there is none. Order matters, so the editor lets you move rules up and down.

Each rule has:

- **Applies to**: a cost filter, built with the same filter rows (or [cost query language](./cloud-costs.md) text) used everywhere else, for example `provider = 'aws' AND service = 'AmazonRDS'`. Empty matches all spend. A rule cannot filter on another virtual tag.
- **From / Until** (optional): inclusive dates. Use them to record a reorganisation: "until March this was team A, from April it is team B", without rewriting history.
- **A kind**, which says what the value is.

| Kind                         | What it does                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fixed value**              | Every matching row gets the same value.                                                                                                                                                   |
| **Copy from tag keys**       | Reads the value from provider tag keys, first present key wins. Each key can have its own value prefix and its own "only where" filter, and the value can be lowercased or uppercased.    |
| **Split by percentage**      | Divides each matching row across several values by fixed percentages that add up to 100.                                                                                                  |
| **Split by business metric** | Divides each matching row across several values in proportion to [business metrics](./unit-costs.md), day by day. For example a shared database split by each team's daily request count. |

### Merging tag keys

To collapse `env`, `Environment` and `ENV` into one `env`, add a single **Copy from tag keys** rule listing all three keys and choose **lowercase**. Give a key a prefix (`az-`) or an "only where" filter (`provider = 'azure'`) when the same value means different things in different places.

### Splits never change a total

A split shares a row's money, it does not copy it. A $100 row split 60/40 contributes $60 to one value and $40 to the other, so grouping by a virtual tag always adds up to the same total as the ungrouped graph.

For a metric split, a day where every share's metric has a value is weighted from that day's values. A day where any share is missing a value carries the most recent complete day's weights forward, or splits evenly when there is none. A missing report is "we do not know", not zero, so it never hands one team's share to the others.

<insert [Virtual tag editor showing a Copy from tag keys rule and a Split by percentage rule, with the 30-day preview open] here>

## Preview before you save

**Preview** evaluates the unsaved rules over the last 30 days: how much spend each rule would claim, how much nothing matches, and the top values. Use it to check a rule does what you meant before anyone's report changes.

## Processing status and backfill

Virtual tags are computed when a report runs and are **never written into collected spend**, so a saved edit applies to every graph, budget and export immediately, across all of your history.

After every save, a background pass evaluates the tag over your whole stored history (the backfill) and records what it found. The badge on each tag shows where that stands:

- **Queued**: saved, waiting for the background pass.
- **Processing**: being evaluated.
- **Ready**: the coverage figures are current. You see the share of spend a rule matched, the unmatched remainder, the number of distinct values, the top values, and any days a metric split had to fall back.
- **Failed**: the evaluation hit an error, shown on the card. The last good figures stay visible.

Tags are re-evaluated every 12 hours to follow newly collected spend and newly reported metric values. **Reprocess** queues one now.

## Using a virtual tag

The `virtual_tag` dimension appears wherever you choose a dimension:

- **Cost graphs and reports**: group by **Virtual tag** and pick the tag, or filter on it.
- **Saved filters**: a filter row on a virtual tag, or `virtual_tag['team'] = 'payments'` in the query language.
- **Budgets** and **change alerts**: scope a budget, or watch each value of a virtual tag separately.
- **Allocation rules** (and so [showback and invoices](./tag-policy-and-showback.md)): route a virtual tag value to a cost centre. A split tag routes each share separately.
- **Cost exports**: add virtual tag columns (`vtag_<key>`). A split row is written once per share with weighted amounts. Exports in FOCUS 1.3 columns cannot filter by a virtual tag yet; filter on the provider tags it is built from instead.

A virtual tag's **key cannot change** once created, because saved filters, budgets and reports store it; rename the display name freely. Deleting a tag that something still references is refused with a list of what uses it, so a budget can never silently widen to all spend.

## Permissions

Reading virtual tags needs `costs:read`; creating, editing, reprocessing and deleting them needs `costs:write`, the same scope as cost centres and allocation rules. Every change is written to the [audit log](../team-and-billing/audit-log.md) with the rules it stored.

For people with a [cost visibility scope](../team-and-billing/cost-visibility.md), graphs grouped or filtered by a virtual tag show only the spend they can see, and a tag's processing figures (spend per rule, top values) are hidden because they cover the whole organization. A visibility scope cannot itself be defined through a virtual tag yet: a scope whose saved filter, or whose cost centre's allocation rules, reads a virtual tag shows nothing rather than everything.

## CLI, MCP and Terraform

- `infrawrench virtual-tags` lists tags with their status and coverage, `infrawrench virtual-tags show <key>` prints the rules and stats, and `infrawrench virtual-tags reprocess <key>` queues a re-evaluation. All take `--json`. `infrawrench costs --group-by virtual_tag:team` groups spend by one. See [CLI](./cli.md).
- The MCP tools `list_virtual_tags`, `preview_virtual_tag`, `create_virtual_tag`, `update_virtual_tag` and `delete_virtual_tag` manage definitions; `query_costs` groups and filters by them. See [MCP](./mcp.md).
- The `infrawrench_virtual_tag` Terraform resource manages a tag as code. See [Terraform provider](./terraform-provider.md).

The mobile app can group and filter dashboard cost cards by a virtual tag; defining tags stays on the web and desktop apps.
