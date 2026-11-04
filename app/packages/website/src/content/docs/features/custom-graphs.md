---
title: Custom graphs
description: Build your own dashboard charts with a short script that queries costs, metrics or any API, and declares its own chart, controls and refresh interval.
sidebar_order: 7
---

Cost graphs and budgets cover the spend Infrawrench collects. Sometimes the chart you want doesn't exist yet: spend per customer, error rate against a price line, or a number your own API reports. **Custom graphs** let you build it. You write a small TypeScript script that gathers the data and describes the chart, including any select menus, checkboxes and buttons on the card, and how often it refreshes.

Custom graphs are on the **paid plan** and are cloud only.

## What a graph script can do

Your script gets a global `graph` object:

- `graph.costs.query({ days, groupBy, filters, binning, topN })`: your organization's collected spend, the same data behind cost graphs, ready to chart.
- `graph.carbon.estimate({ windowDays })`: your organization's [estimated carbon](./carbon.md), grouped by provider, region and account, plus what couldn't be estimated.
- `graph.resources.list(filter)`: list resources, for example to build your own pickers.
- `graph.metrics(resourceId, { hours })`: provider metric series (CPU, bandwidth and so on) for one resource.
- `fetch(url, init)`: call external HTTP APIs (public addresses only).
- `graph.data.get/set/delete/list`: a private key/value store that persists between runs, for caches and baselines.
- `graph.controls.select/checkbox/text/number/button`: declare the card's controls and read their current values.
- `infra.accounts.<plugin>`: **read-only access to your connected accounts**, the same as [workflows](./workflows.md) get. You can list and fetch resources, resolve outputs, read logs, describe, read manifests, run SQL queries, read KV keys, fetch metrics, and run **SSH commands** with `resource.ssh(cmd)`. Nothing that creates or changes things is available: `create`, `update`, `delete`, `applyManifest`, `importYaml` and `publish` don't work in graphs.
- `graph.render({ title, chart, refreshSeconds, notice })`: say what to draw. Chart types are `line`, `area`, `stacked_bar`, `multi_bar`, `pie`, `stat` and `table`.

A minimal graph:

```ts
const range = graph.controls.select("range", {
  label: "Range",
  options: [
    { value: "7", label: "Last 7 days" },
    { value: "30", label: "Last 30 days" },
  ],
  default: "30",
});

const costs = await graph.costs.query({
  days: Number(range),
  groupBy: "provider",
});

graph.render({
  title: "Spend by provider",
  chart: { type: "stacked_bar", series: costs.series },
  refreshSeconds: 3600,
});
```

The script runs again when you change a control, press a button you declared, or the `refreshSeconds` timer runs out. `graph.event.button` tells the script which button was pressed, so a button can, for example, reset a baseline or clear a cached value in `graph.data`.

## Create a graph

1. On a dashboard, choose **+ > Custom graph**.
2. Pick an existing graph, or name a new one.
3. A new graph opens in the script editor with a working example. The editor checks your code against the `graph` API and shows a live preview of the saved script, controls included.

![Dashboard with a custom graph card showing a chart, a Range select, and a checkbox, with the "+" add menu open showing the Custom graph entry](https://agent-assets.infrawrench.com/docs-screenshots/features/custom-graphs/dashboard-card-add-menu.png)

![The custom graph script editor: Monaco on the left with graph API autocomplete, live preview pane on the right showing the rendered chart and its controls](https://agent-assets.infrawrench.com/docs-screenshots/features/custom-graphs/script-editor-preview.png)

You can put the same graph on as many dashboards as you like. Removing a card leaves the graph alone. Deleting a graph removes every card that shows it.

The picker is also where you manage graphs. Hover a row to edit its script or delete it, including graphs that aren't on any dashboard.

## Create a graph with AI

You can ask an AI to write a graph for you over [MCP](../team-and-billing/openapi.md) or in the in-app chat. It uses these tools:

- `get_custom_graph_typings` to get the full `graph` API.
- `write_custom_graph` to save the script. The code is checked before saving, and any errors come back instead of being saved.
- `render_custom_graph` to check the result.

In the in-app chat, a `write_custom_graph` call that sets the script waits for your approval first, because the script can run SSH commands whenever the graph renders.

Try asking for "a graph of our egress spend against the bandwidth metrics of the CDN droplets, with a toggle for daily/weekly", then pin the result.

## Whose access a graph uses

Anyone who can see the dashboard can see the graph, so `infra.*` runs with the **author's** permissions, not the viewer's. The author is whoever last saved the script.

- Reads need the author to have `resources:read` (`storage:read` for buckets).
- SSH, SQL and KV need `resources:execute`.

The author's current role is checked every time the graph renders. If the author is demoted or removed, their graphs stop reaching your infrastructure straight away. If you edit someone else's script, you become its author, so you can't borrow a more privileged person's access.

## Limits

- 30 seconds of run time and 64 MiB of memory per run.
- Per-run limits on cost queries, metric lookups, fetches and data store operations.
- Read-only: a script can't create, change or delete resources.
- `fetch` can only reach public addresses.
- SSH is limited to 10 commands of 30 seconds each per render.
- The data store holds up to 200 keys of 64 KiB each, private to the graph.

## Where graphs show

Custom graph cards, controls included, show on web, desktop (cloud mode) and the [mobile app](./mobile-app.md). On a phone, selects become rows of chips. You write and edit scripts on web and desktop. On the phone you can add existing graphs to dashboards and use their controls.
