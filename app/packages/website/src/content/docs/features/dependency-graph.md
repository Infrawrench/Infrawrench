---
title: Dependency graph
description: See how your resources are wired together through output references — and what breaks if one of them goes down.
sidebar_order: 8
---

Every [output reference](../core-concepts/output-references.md) you create is more than a convenience — it's a statement that one resource depends on another. The **dependency graph** draws all of those statements at once: a map of your infrastructure's wiring, across every provider and account in the organization.

Open it from the **Graph** tile in the sidebar, on web or desktop.

<insert [The Graph page showing a small cross-provider topology — e.g. a DigitalOcean droplet feeding a Cloudflare DNS record and a Postgres account — with arrows pointing from consumers to providers] here>

## Reading the graph

- **Nodes** are resources. Each shows its provider logo, name, type, and account.
- **Arrows point at what a resource depends on.** A Postgres account whose connection string references a managed database points at that database.
- Resources with no references in either direction stay off the canvas — the graph is about wiring, not inventory.

Providers sit on the left, and everything that consumes them fans out to the right, so the deeper a chain goes the further right it ends up.

## Blast radius

Click a node to see its **blast radius**: the resource itself plus everything that transitively depends on it. The dependents stay highlighted while the rest of the graph dims — if the selected resource breaks or rotates its outputs, the highlighted set is what's affected.

<insert [The Graph page with a database node selected — the node and its transitive dependents highlighted in the accent color, everything else dimmed, and the header reading "Blast radius: N dependent resources highlighted"] here>

Click the selected node again (or the **Open resource** button in the header) to jump to its detail page.

The graph is keyboard navigable: <kbd>Tab</kbd> moves between nodes, <kbd>Enter</kbd> or <kbd>Space</kbd> selects the focused node and then opens it, and <kbd>Escape</kbd> clears the selection. Clicking empty canvas or the **Clear** button in the header clears it too.

## Per-resource dependencies

Resource detail pages get a **Dependencies** tab whenever the resource participates in the graph. It lists direct neighbors in both directions:

- **Depends on** — the outputs this resource references, with the field and output key for each link.
- **Depended on by** — the resources referencing this resource's outputs.

Each entry links to the neighbor's detail page.

<insert [A resource detail page with the Dependencies tab open, showing a "Depends on" list and a "Depended on by" list with field ← output captions on each row] here>

## Where the data comes from

The graph is built entirely from output references — the same links that power [secret rerolls](../core-concepts/secret-rerolls.md) and automatic re-resolution. There's nothing separate to configure: wire a field to another resource's output and the edge appears; switch the field back to a literal value and it disappears.

On the web app the graph covers everything in your organization. On desktop it covers the resources and references stored on that machine, and switches to the organization-wide view when you're signed into cloud sync.

## API

Programmatic access is available at `GET /api/org/{orgId}/dependency-graph`, which returns the node and edge lists (see the [API reference](../team-and-billing/openapi.md)). It requires the `resources:read` permission.
