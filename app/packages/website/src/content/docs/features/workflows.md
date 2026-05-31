---
title: Workflows
description: Automate across all your connected accounts with sandboxed TypeScript — triggered manually, on a schedule, or from git.
sidebar_order: 8
---

Workflows let you script actions across every account you've connected to Infrawrench. A workflow is a **TypeScript file** you edit in a full Monaco editor with autocomplete generated from _your_ accounts, run inside a secure **V8/WASM isolate** on desktop, on the web app, and through the web proxy.

The classic example: grab a config file from a Cloudflare R2 bucket, parse it as JSON, and use those values to update DNS records or a database — all in a few lines, with full type-checking.

<insert [Screenshot of the Workflows tab showing the Monaco editor with infra.* autocomplete open] here>

## The `infra` object

Every workflow runs with a global `infra` object. Its types are **generated from your connected accounts**, so autocomplete shows exactly the providers, accounts, and resource types you actually have.

### Accounts and resources

```ts
// Look an account up by the display name you gave it
const cf = infra.accounts.cloudflare.getByName("production");

// List resources of a type, or fetch one by its provider id
const buckets = await cf.resources["r2-bucket"].list();
const zone = await cf.resources["zone"].get("example.com");

// Resolve an output (e.g. a server's IP) for use elsewhere
const ip = await infra.accounts.hetzner
  .getByName("eu-central")
  .resolveOutput("server", serverId, "ipv4");
```

`infra.accounts.<plugin>` exposes `list()`, `getById(id)`, and `getByName(name)`. Each account handle gives you `resources[typeId]` (`list`, `get`, and — where the provider supports it — `create`, `update`, `delete`), `resolveOutput(...)`, and `storage`.

### Reading storage objects

```ts
const cf = infra.accounts.cloudflare.getByName("production");
const file = await cf.storage.bucket("configs").get("app.json");
const config = file.json<{ replicas: number }>();
infra.log("replicas:", config.replicas);
```

`storage.bucket(name).get(key)` returns the object with `.text()`, `.json<T>()`, and the raw `.base64`. `list(prefix?)` enumerates objects.

### Prompting the user

For **manual** runs you can ask the user for input mid-workflow:

```ts
const env = await infra.prompt({
  message: "Which environment?",
  kind: "select",
  options: [
    { label: "Staging", value: "staging" },
    { label: "Production", value: "production" },
  ],
});
```

`infra.prompt(...)` is only available for manual runs. Automated (cron/git) runs are non-interactive — calling it there throws, and the generated types mark it unavailable so you catch it while editing.

### Output and logging

```ts
infra.log("starting reconcile");
await infra.output({ updated: 3 }); // shown in the run result
```

## Metrics

When you create a workflow you can declare **metrics** in the UI (a key, label, type, and optional unit). Each metric you declare becomes a **typed property** on `infra.metrics`, named after its key — read it like a variable and assign to it to persist a new value:

```ts
// `runCount` is a declared number metric → typed `number | null`
infra.metrics.runCount = (infra.metrics.runCount ?? 0) + 1;

// a string metric
infra.metrics.lastRegion = "us-east";
```

Reads come from a snapshot taken when the run starts, so they're synchronous (no `await`). Assignments are saved automatically when the run finishes — even if it later errors, so partial progress is kept. Metric values persist between runs: a nightly cron can increment a counter, and a manual run sees the latest value. The editor autocompletes `infra.metrics.` with exactly the keys you declared, each typed to its declared type.

<insert [Screenshot of the workflow create form showing the metrics section with a key, label, type and unit] here>

## Pinning a workflow to a dashboard

Drag a workflow from the list on the left of the **Workflows** tab onto any dashboard (or onto a dashboard in the sidebar) to pin it. Use the search box above the list to filter by name when you have a lot of workflows. The workflow shows up as a card listing its declared metrics with their current values, when it last ran, and a **Run** button that triggers it and refreshes the values in place — so a dashboard can double as a live readout of whatever your workflows track.

On the **desktop app** workflows are stored locally, so workflow cards are available on local dashboards; switch to Local mode to pin them. On the **web app** workflow pins are scoped to your organization like the workflows themselves.

<insert [Screenshot of a dashboard with a pinned workflow card showing metric values, a last-run line, and a Run button] here>

## Triggers

Open the trigger settings to choose how a workflow runs:

- **Manual** — run on demand from the UI. The only mode that allows `infra.prompt`. Available everywhere (desktop, web, proxy).
- **Cron** — run on a schedule (a cron expression). Handled by the cloud background runner.
- **Git** — run when a connected git repository receives an event (e.g. a push). The web app gives you a webhook URL with a secret token to add to your repo.

**Platform support for automated triggers:**

| Trigger | Desktop            | Web | Web proxy |
| ------- | ------------------ | --- | --------- |
| Manual  | ✅                 | ✅  | ✅        |
| Cron    | only via the proxy | ✅  | ✅        |
| Git     | only via the proxy | ✅  | ✅        |

The desktop app runs manual workflows entirely locally. It does **not** run automated (cron/git) triggers on its own — those need a host that's always on, so they run in the cloud, or against your desktop accounts through the [web proxy](../core-concepts/desktop-vs-web.md).

<insert [Screenshot of the trigger configuration showing Manual / Cron / Git options with the git webhook URL] here>

## The isolate sandbox

Workflow code never runs in the host process. It executes in a **QuickJS WebAssembly isolate** with a hard memory limit and a wall-clock timeout, and with no ambient access to the network or filesystem — the only capabilities a workflow has are the ones `infra` grants it (which themselves run with your account credentials on the host side, never exposed to the script). The same isolate runs identically on desktop and on the server, so a workflow behaves the same wherever it runs.

## Runs

Each execution records a run with its status, streamed logs, declared output, timings, and any error. The run history is on the workflow's page so you can see what a cron has been doing.

<insert [Screenshot of a workflow's run history list with statuses and durations, one run expanded to show logs] here>
