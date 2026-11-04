---
title: Virtual tags
description: Tags you compute from your own rules. Merge tag spellings, assign values by any cost filter, split shared spend by percentage or by a business metric, and use the result everywhere a tag works.
sidebar_order: 11
---

Provider tags are whatever each team managed to apply. One account says `env`, another `Environment`, a third `ENV`. Half your resources have a `team` tag. The shared database has no owner at all.

A virtual tag fixes that. You define the answer you want to report on once, as an ordered list of rules, and use it as a cost dimension anywhere you'd use a provider tag.

Open **Settings > Virtual Tags** to create and edit them.

<insert [Settings > Virtual Tags list with two tags, one Ready with coverage stats and top values, one Processing] here>

## How a virtual tag picks a value

A virtual tag has a **key** (what filters use, for example `team`), a display name, an ordered list of **rules** and an optional **default value**.

Each cost row is checked against the rules **top to bottom**, and the first rule it matches sets its value. A row that matches no rule gets the default value, or no value if there isn't one. Order matters, so you can move rules up and down in the editor.

Each rule has:

- **Applies to**: a cost filter, using the same filter rows (or [cost query language](./cloud-costs.md) text) as everywhere else, for example `provider = 'aws' AND service = 'AmazonRDS'`. Leave it empty to match all spend. It can also filter on another virtual tag; see [Build on other virtual tags](#build-on-other-virtual-tags).
- **From / Until** (optional): inclusive dates. Use them to record a reorganisation, like "until March this was team A, from April it's team B", without rewriting history.
- **A kind**, which says what the value is.

| Kind                         | What it does                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fixed value**              | Every matching row gets the same value.                                                                                                                                                   |
| **Copy from tag keys**       | Reads the value from provider tag keys, first present key wins. Each key can have its own value prefix and its own "only where" filter, and the value can be lowercased or uppercased.    |
| **Split by percentage**      | Divides each matching row across several values by fixed percentages that add up to 100.                                                                                                  |
| **Split by business metric** | Divides each matching row across several values in proportion to [business metrics](./unit-costs.md), day by day. For example a shared database split by each team's daily request count. |

### Merge tag keys

To combine `env`, `Environment` and `ENV` into one `env`, add a single **Copy from tag keys** rule listing all three keys and choose **lowercase**. Give a key a prefix (`az-`) or an "only where" filter (`provider = 'azure'`) when the same value means different things in different places.

### Build on other virtual tags

A rule can filter on another virtual tag, so you can define one tag in terms of another. Define `team` once, then build `business_unit` on top of it:

| Rule | Applies to                                        | Value      |
| ---- | ------------------------------------------------- | ---------- |
| 1    | `virtual_tag['team'] IN ('payments', 'checkout')` | `commerce` |
| 2    | `virtual_tag['team'] ~= 'data-platform'`          | `data`     |
| 3    | `virtual_tag['team'] IS NOT SET`                  | `unowned`  |

When `team` changes, `business_unit` follows on the next query, and its status goes back to **Queued** so its coverage numbers are refreshed after `team`'s.

A few rules apply. If you break one, saving is refused with a message naming the problem:

- **The tag you reference must exist.** You also can't delete a tag that other tags filter on; the message names the tags that use it.
- **The tag you reference must give each row one value.** A filter asks a yes or no question about a row, and a row split 60/40 between two teams has no single answer. So a tag with a **Split by percentage** or **Split by business metric** rule can't be filtered on by another tag, and a tag that others filter on can't gain a split rule.
- **No loops.** `business_unit` can't filter on `team` while `team` filters on `business_unit`. The error spells out the loop, for example `team > business_unit > team`.
- **At most five deep.** A chain of tags building on each other can be at most five long, counting both ends (`division > business_unit > team > owner > env` is five). Deeper chains would slow every report that uses the top tag. Filter on the provider tags a deep tag is built from instead.
- A tag can't filter on itself, so the editor leaves it out of the virtual tag picker.

<insert [Virtual tag editor for business_unit with a rule whose filter row reads Virtual tag team is payments, checkout] here>

### Splits never change a total

A split shares a row's cost, it doesn't copy it. A $100 row split 60/40 gives $60 to one value and $40 to the other, so grouping by a virtual tag always adds up to the same total as the ungrouped graph.

For a metric split, a day where every share has a metric value is weighted by that day's values. If any share is missing a value for a day, the most recent complete day's weights are used, or the split is even if there's none. A missing report means "unknown", not zero, so it never hands one team's share to the others.

<insert [Virtual tag editor showing a Copy from tag keys rule and a Split by percentage rule, with the 30-day preview open] here>

## Preview before you save

**Preview** runs your unsaved rules over the last 30 days. You see how much spend each rule would claim, how much nothing matches, and the top values. Use it to check a rule does what you meant before anyone's report changes.

## Processing status

Virtual tags are applied when a report runs and never change your collected spend. So a saved edit applies right away to every graph, budget and export, across all your history.

After each save, Infrawrench also runs the tag over your full history to work out coverage figures. The badge on each tag shows where that's at:

- **Queued**: saved, waiting to be processed.
- **Processing**: being worked out.
- **Ready**: the coverage figures are current. You see the share of spend each rule matched, what's left unmatched, the number of distinct values, the top values, and any days a metric split had to fall back.
- **Failed**: something went wrong, and the error shows on the card. The last good figures stay visible.

Tags are reprocessed every 12 hours to pick up new spend and new metric values. Click **Reprocess** to run one now.

## Use a virtual tag

The `virtual_tag` dimension appears wherever you choose a dimension:

- **Cost graphs and reports**: group by **Virtual tag** and pick the tag, or filter on it.
- **Saved filters**: a filter row on a virtual tag, or `virtual_tag['team'] = 'payments'` in the query language.
- **Budgets** and **change alerts**: scope a budget, or watch each value of a virtual tag separately.
- **Allocation rules** (and so [showback and invoices](./tag-policy-and-showback.md)): send a virtual tag value to a cost centre. A split tag sends each share separately.
- **Cost exports**: add virtual tag columns (`vtag_<key>`). A split row is written once per share with weighted amounts. Exports in FOCUS columns can't filter by a virtual tag yet; filter on the provider tags it's built from instead.

You **can't change a virtual tag's key** after creating it, because saved filters, budgets and reports use it. You can rename the display name freely. Deleting a tag that something still uses is refused with a list of what uses it, so a budget never quietly widens to all spend.

## Permissions

Reading virtual tags needs `costs:read`. Creating, editing, reprocessing and deleting them needs `costs:write`, the same permission as cost centres and allocation rules. Every change goes into the [audit log](../team-and-billing/audit-log.md) with the rules that were saved.

If you have a [cost visibility scope](../team-and-billing/cost-visibility.md), graphs grouped or filtered by a virtual tag only show spend you can see. A tag's processing figures (spend per rule, top values) are hidden, because they cover the whole organization. You can't define a visibility scope through a virtual tag yet: a scope whose saved filter, or whose cost centre's allocation rules, uses a virtual tag shows nothing rather than everything.

## CLI, MCP and Terraform

- `infrawrench virtual-tags` lists tags with their status and coverage, `infrawrench virtual-tags show <key>` prints the rules and stats, and `infrawrench virtual-tags reprocess <key>` queues a reprocess. All take `--json`. `infrawrench costs --group-by virtual_tag:team` groups spend by one. See [CLI](./cli.md).
- The MCP tools `list_virtual_tags`, `preview_virtual_tag`, `create_virtual_tag`, `update_virtual_tag` and `delete_virtual_tag` manage definitions, and `query_costs` groups and filters by them. See [MCP](./mcp.md).
- The `infrawrench_virtual_tag` Terraform resource manages a tag as code. See [Terraform provider](./terraform-provider.md).

The mobile app can group and filter dashboard cost cards by a virtual tag. You create and edit tags in the web and desktop apps.
