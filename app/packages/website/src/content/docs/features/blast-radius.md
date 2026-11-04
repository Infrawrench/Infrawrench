---
title: Blast radius
description: See what breaks if you delete a resource, including dependants, dashboards and probes that point at it, what talks to it over the network, and what couldn't be checked.
sidebar_order: 8
---

**Blast radius** answers one question: _what breaks if I delete this?_ You'll see the answer in the delete confirmation dialog and in a tab on the resource's page.

It isn't a permission check and it never stops you deleting anything. Think of it as the warning you wish someone had given you beforehand.

![A resource delete confirmation dialog with the blast radius summary above the type-to-confirm box, reading something like "3 resources depend directly on this, 5 more further down the chain and 4 other references to it. The check was also incomplete.", with a customer-visible probe named in red](https://agent-assets.infrawrench.com/docs-screenshots/features/blast-radius/delete-confirm-dialog.png)

## What the report covers

The report looks at three kinds of evidence and keeps them separate, because they mean different things.

### Resources that depend on it

These come from the [dependency graph](./dependency-graph.md), followed all the way down the chain. It includes [output references](../core-concepts/output-references.md) you set up yourself, links a provider plugin declares, the resource hierarchy, and field values that name another resource.

Each dependant is marked **direct** (it references this resource itself) or with how many hops away it is. A direct dependant breaks right away. A further one breaks if something in between breaks.

### What talks to it

When [network flow collection](./network-costs.md) is on, the report lists the peers that exchanged traffic with the resource over the last 14 days, heaviest first. For each you see the boundary it crossed and how many days it showed up. This catches dependencies nobody wrote down, like a steady 400 GB/day flow to a service with no reference set up.

A peer is a clickable link only when it matches exactly one resource you sync. Otherwise it's a plain label. That happens for endpoints outside your accounts, and for provider ids shared by more than one of your resources (a `default` VPC or a `kube-system` namespace). Shared ones are also named in the coverage notes.

### Things that point at it

These don't break. They quietly stop showing anything, which people tend to notice weeks later:

- **Dashboards** with the resource pinned as a card
- **Custom graphs** and **workflows** whose source names it
- **Synthetic probes** targeting it, and any **status page** publishing those probes
- **Metric alerts** currently firing against it
- **Leases** claiming it, and **sleep/wake schedules** that start and stop it
- **Saved log queries** tailing it
- Its recorded **owner**, so you know who to tell

A probe on a published status page is flagged as **customer-visible**. One of those alone makes the report high severity, ahead of any number of internal dependants, because people outside your organization will see the status page go red.

## What it couldn't check

Every report ends with what it wasn't able to look at, even when it found nothing else:

- **Network flow collection is off**, or there's no traffic data, so nothing is known about what talks to the resource.
- **Workflows and custom graphs are matched by searching for the resource's exact id.** A script that builds the id at runtime or looks the resource up by name won't appear.
- **Metric alert rules pick resources by plugin, type and tag, not by id**, so only alerts currently _firing_ against the resource are listed.
- **A network peer whose provider id matches more than one resource** is listed with its traffic but without a link.
- Any check that failed outright.

Read this part. "Nothing depends on this" and "nothing depends on this, but half the checks didn't run" are different things, and the report always tells you which one you're looking at.

## Check before you delete

### In the delete dialog

When you open the confirmation dialog, the check starts in the background. The summary appears above the type-to-confirm box a moment later. If the check fails, it says **couldn't check what depends on this resource** instead of showing nothing. You can delete either way.

### On the resource page

Every resource page has a **Blast radius** tab with the full report: every dependant listed and linked, every reference named, traffic itemized, and the coverage notes. Use this when you're planning to decommission something, before you get to the delete dialog.

![A resource detail page with the Blast radius tab open, showing the "Resources that depend on this" list with direct/hops badges, the "Things that point at it" list with a customer-visible chip, and the "What wasn't checked" section](https://agent-assets.infrawrench.com/docs-screenshots/features/blast-radius/blast-radius-tab.png)

### From the command line

```
infrawrench blast-radius <resource-id>
infrawrench blast-radius <resource-id> --output json
```

Text mode prints the same four sections. `--output json` gives you the whole report, including `unchecked`, so a decommissioning script can stop if it doesn't like what it sees. See the [CLI reference](./cli.md).

### From AI chat and MCP

The `get_blast_radius` tool returns the report for a resource id. `delete_resource` points to it, so an assistant asked to clean something up can tell you what would break before asking you to confirm. See [MCP](./mcp.md).

## Good to know

- Viewing a blast radius needs the same permission as viewing resources. It does **not** need delete permission, since the person planning a change often isn't the one who runs it.
- Each report is built fresh when you ask for it and covers your whole organization.
- Blast radius is a cloud feature. On desktop it appears when you're signed in to cloud sync. A local-only workspace has no dashboards, probes, leases or flow data to check.
- Very large organizations can have more dependency links than the graph draws at once. If that happens, the coverage notes say so.
