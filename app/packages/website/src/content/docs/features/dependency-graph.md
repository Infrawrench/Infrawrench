---
title: Dependency graph
description: See how your resources are wired together, from your synced cloud data and your output references, and what breaks if one of them goes down.
sidebar_order: 8
---

The **dependency graph** shows how your infrastructure is wired together, across every provider and account in your organization. Most of it is filled in the first time you open it, from what your providers already report about each resource: an EC2 instance's VPC, a droplet's project, the IP a DNS record points to. [Output references](../core-concepts/output-references.md) you set up yourself show on the same canvas.

Open it from the **Graph** tile in the sidebar, on web or desktop.

![The Graph page showing a small cross-provider topology: DigitalOcean droplets feeding Cloudflare DNS records and a managed database feeding a PostgreSQL database, with arrows pointing from consumers to providers](https://agent-assets.infrawrench.com/docs-screenshots/features/dependency-graph/graph-overview.png)

## Read the graph

- **Nodes** are resources. Each shows its provider logo, name, type and account.
- **Arrows point at what a resource depends on.** A Postgres account whose connection string references a managed database points at that database.
- **The line style shows how certain the link is.** Solid means a stated relationship (an output reference you set up, or a link the provider integration knows about). Dotted means a resource belongs to another (a deployment in its cluster). Dashed means a field value happens to name another resource.
- Resources with no links either way aren't shown. The graph is about wiring, not inventory.

Providers sit on the left, and everything that uses them fans out to the right, so the longer a chain, the further right it ends.

The **From cloud data** checkbox in the header hides everything except output references, so you can see just what's wired through Infrawrench.

## Identical resources are grouped

Providers often create sets of identical resources. A GCP auto-mode VPC has one `default` subnet per region, all named `default` and all attached to the same network. Drawn separately, they'd fill the canvas with identical tiles.

The graph merges them into one tile marked **×12**, drawn as a small stack. Resources only merge when they're identical in both label and wiring: same provider, type, account and name, connected to exactly the same neighbours. Attach a VM to one of those subnets and it gets its own tile again.

Select a grouped tile and choose **Show all** to expand it. **Regroup** in the header puts everything back. The **Group identical** checkbox turns grouping off.

![Close-up of the graph header showing the line-style legend (Reference or provider link / Belongs to / Named in a field) and the "From cloud data" checkbox with its link count](https://agent-assets.infrawrench.com/docs-screenshots/features/dependency-graph/graph-header-legend.png)

## See the blast radius

Click a node to see its **blast radius**: the resource plus everything that depends on it, directly or indirectly. Those stay highlighted while the rest of the graph dims. If the selected resource breaks or rotates its outputs, the highlighted resources are what's affected.

![The Graph page with a database node selected: the node and its transitive dependents highlighted in the accent color, everything else dimmed, and the header reading "Blast radius: 3 dependent resources highlighted"](https://agent-assets.infrawrench.com/docs-screenshots/features/dependency-graph/graph-blast-radius.png)

Click the selected node again (or **Open resource** in the header) to open its detail page.

For the full picture, open the [blast radius](./blast-radius.md) report. It adds what the graph can't show: dashboards, probes, alerts, leases and schedules that point at the resource, what measurably talks to it, and what couldn't be checked. It's also what the delete confirmation dialog shows.

You can use the graph from the keyboard: <kbd>Tab</kbd> moves between nodes, <kbd>Enter</kbd> or <kbd>Space</kbd> selects the focused node and then opens it, and <kbd>Escape</kbd> clears the selection. Clicking empty canvas or **Clear** in the header also clears it.

## Dependencies on a resource page

A resource's detail page has a **Dependencies** tab whenever it's part of the graph. It lists its direct neighbours both ways:

- **Depends on:** the resources this one points at, with a caption for the relationship. That's the provider's own wording where there is one ("in VPC"), otherwise the field and output behind the link, or "belongs to" for parent resources.
- **Depended on by:** the resources pointing at this one.

Each entry links to that resource's detail page.

![A resource detail page with the Dependencies tab open, showing a "Depends on" list and a "Depended on by" list with field ← output captions on each row](https://agent-assets.infrawrench.com/docs-screenshots/features/dependency-graph/resource-dependencies-tab.png)

## On your phone

The [mobile app](./mobile-app.md) has the per-resource view, not the canvas. Every resource page has a **Dependencies** section with the same two lists and captions, and each entry opens that resource.

**Blast radius** in that section opens a screen showing what the resource depends on and what depends on it, as indented trees that follow the whole chain, with a count of everything that depends on it. `↺` marks a link back to a resource already on the branch, and `…` marks a branch cut off at the depth limit, the same as in the CLI.

The organization-wide canvas is on web and desktop only, since a phone screen is too small to show a whole topology.

<insert [Mobile resource page showing the Dependencies section with "Depends on" and "Depended on by" lists and the Blast radius button, next to the blast-radius screen showing the two indented trees and the affected-resource count] here>

## Where the links come from

There's nothing to set up. Links come from four places:

1. **Output references.** Wire a field to another resource's output and the link appears. Switch the field back to a plain value and it disappears. These are the same links used for [secret rerolls](../core-concepts/secret-rerolls.md).
2. **Links the provider integration knows about.** For example, an EC2 instance's `vpcId` is a VPC and its security group list is security groups. These are exact, and use the provider's wording ("in VPC", "guarded by").
3. **Parent resources.** Anything that sits inside another resource, like a Kubernetes deployment in its cluster or a database in its project, is shown as belonging to it.
4. **Field values that name another resource.** When a field exactly matches another resource's provider id, name, endpoint, hostname or IP, that's a link. If two resources match the same value, no link is drawn, and plain names like `staging` only match within the same account.

Not every provider supports exact links yet. Those that don't still get links from field values. Either way, connect an account, let it sync, and the graph fills in.

Very large organizations can have more links than the canvas can usefully show. If that happens, a banner tells you and the graph shows a partial view. A resource's **Dependencies** tab still shows all of its neighbours.

On the web app, the graph covers your whole organization. On desktop, it covers the resources stored on that machine, and switches to the organization-wide view when you're signed into cloud sync. Mobile has no canvas (see [on your phone](#on-your-phone) above).

## From the CLI

The [desktop CLI](./cli.md) draws the same topology as an ASCII tree:

```sh
infrawrench graph                      # the whole organization as a forest
infrawrench graph --resource <id>      # one resource: what it needs, and its blast radius
infrawrench graph <id>                 # same thing, positionally
infrawrench graph --json               # the node and edge lists, for scripting
```

Without a resource, each tree starts from a resource nothing depends on, and each child is something its parent depends on. Reading down a branch takes you towards the things everything else is built on. `↺` marks a link back to a resource already on the branch (references can be circular), and `…` marks a branch cut off at the depth limit.

With `--resource`, you get the terminal version of the **Dependencies** tab: a **Depends on** tree and a **Depended on by** tree, the second headed with the blast radius count.

<insert [Terminal showing `infrawrench graph --resource` output: the focused resource, a "Depends on" ASCII tree, and a "Depended on by" tree headed with a blast-radius count] here>

`--json` outputs `nodes`, `edges` and `truncated`. With a resource, it also includes the direct `dependsOn` and `dependedOnBy` lists and a `blastRadius` array of resource ids.

The command needs cloud sync. For a local-only workspace, use the desktop app's **Graph** tile.

## API

`GET /api/org/{orgId}/dependency-graph` returns the node and edge lists (see the [API reference](../team-and-billing/openapi.md)). Each edge has a `kind` saying where it came from (`output-ref`, `declared`, `containment` or `field-match`) and an optional `label` with the provider's wording. The `truncated` flag says whether the graph was cut short. It needs the `resources:read` permission.
