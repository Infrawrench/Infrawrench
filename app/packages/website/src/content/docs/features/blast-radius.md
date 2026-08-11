---
title: Blast radius
description: What breaks if you delete a resource — dependants, the dashboards and probes that point at it, what talks to it over the network, and what couldn't be checked.
sidebar_order: 8
---

**Blast radius** answers one question — _what breaks if I delete this?_ — from data Infrawrench already has, and puts the answer where the question gets asked: in the delete confirmation dialog, and in a tab on the resource's own page.

It is not a permission check and it will never stop you deleting anything. It is the thing you wish somebody had said out loud beforehand.

<insert [A resource delete confirmation dialog with the blast radius summary above the type-to-confirm box — reading something like "3 resources depend directly on this, 5 more further down the chain and 4 other references to it", with a customer-visible probe named in red] here>

## What it looks at

Three kinds of evidence, kept apart on purpose because they mean different things.

### Resources that depend on it

The [dependency graph](./dependency-graph.md) walked inbound, transitively. Every edge the graph draws counts: [output references](../core-concepts/output-references.md) you wired by hand, links a provider plugin declares, the resource hierarchy, and field values that name another resource.

Each dependant is labelled **direct** — it holds a reference to the resource itself — or with how many hops away it is. A direct dependant breaks now; a transitive one breaks if the chain in between does.

### What talks to it

When [network flow collection](./network-costs.md) is on, the report lists the peers that measurably exchanged traffic with the resource over the last 14 days, heaviest first, with the boundary each crossed and how many days it appeared on. A standing 400 GB/day flow to a service nobody wired a reference to is exactly the dependency no configuration records.

Peers resolve to a link when their address belongs to a resource you sync; anything else stays a label, because flow records identify endpoints by the provider's own id.

### Things that point at it

These don't break — they quietly stop having anything to show, which is the failure people discover a fortnight later:

- **Dashboards** with the resource pinned as a card
- **Custom graphs** and **workflows** whose source names it
- **Synthetic probes** targeting it, and any **status page** publishing those probes
- **Metric alerts** currently firing against it
- **Leases** claiming it, and **sleep/wake schedules** starting and stopping it
- **Saved log queries** tailing it
- Its recorded **owner** — who to tell

A probe on a published status page is called out separately as **customer-visible**, and one of those on its own makes the report high severity, ahead of any number of internal dependants. A blank internal dashboard is an annoyance; a status page going red is an incident somebody outside your organization sees.

## What it couldn't check

Every report ends with what it was unable to look at, and the report says so even when it found nothing else:

- **Network flow collection is off**, or no traffic data is stored — so nothing is known about what talks to the resource.
- **Workflows and custom graphs are matched by searching their source for the resource's id verbatim.** A script that assembles the id at runtime, or looks the resource up by name, will not appear.
- **Metric alert rules select resources by plugin, type and tag rather than by id**, so only alerts currently _firing_ against the resource can be listed by name.
- Any check that failed outright.

This is the part to read. "Nothing depends on this" and "nothing depends on this, but half the checks didn't run" are different claims, and the report never renders the second as the first — a report that found nothing but couldn't look everywhere is marked as such rather than as a clean bill of health.

## Where it shows up

### In the delete dialog

Opening the confirmation dialog starts the check; the dialog does not wait for it. The summary fills in above the type-to-confirm box a moment later, and if the check fails it says **couldn't check what depends on this resource** rather than showing nothing. Deleting is allowed either way — if you already know what you are doing, nothing here slows you down.

### On the resource page

Resource detail pages carry a **Blast radius** tab with the full report: every dependant listed and linked, every reference named, traffic itemized, and the coverage notes spelled out. This is the one to read _before_ you open the delete dialog — when you are planning a decommission rather than confirming one.

<insert [A resource detail page with the Blast radius tab open, showing the "Resources that depend on this" list with direct/hops badges, the "Things that point at it" list with a customer-visible chip, and the "What wasn't checked" section] here>

### From the command line

```
infrawrench blast-radius <resource-id>
infrawrench blast-radius <resource-id> --output json
```

Text mode prints the same four sections. `--output json` emits the whole report, `unchecked` included, so a decommissioning script can refuse to proceed on a report it doesn't like. See the [CLI reference](./cli.md).

### From the AI chat and MCP

The `get_blast_radius` tool returns the report for a resource id. `delete_resource` points at it, so an assistant asked to clean something up can say what would break before it asks you to confirm. See [MCP](./mcp.md).

## Notes

- Reading a blast radius needs the same permission as reading resources. It is deliberately **not** gated on the delete permission — the person writing the change request usually isn't the person who will run it.
- The report is assembled per request and not cached; the dependency walk covers the whole organization, which is what makes a transitive answer possible.
- Blast radius is a cloud feature. On desktop it appears when you are signed in to cloud sync; a local-only workspace has no dashboards, probes, leases or flow data for the report to look at.
- Very large organizations can produce more dependency links than the graph will draw at once. When that happens it lands in the report's coverage notes rather than silently shortening the dependant list.
