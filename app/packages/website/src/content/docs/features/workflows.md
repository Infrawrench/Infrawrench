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

// Each resource type is a typed group on the account, named after the type:
const buckets = await cf.r2Buckets.list();
const zone = await cf.zones.get("example.com");
await cf.dnsRecords.create({ type: "A", name: "api", content: "1.2.3.4" });

// Resolve an output (e.g. a server's IP) for use elsewhere
const ip = await infra.accounts.hetzner
  .getByName("eu-central")
  .resolveOutput("server", serverId, "ipv4");
```

`infra.accounts.<plugin>` exposes `list()`, `getById(id)`, and `getByName(name)`. Each account handle is built from the provider's resource types: every type is a group named after its (plural) name — `account.<type>.list()` and `account.<type>.get(id)`, plus `.create/.update/.delete(...)` for the operations that provider actually supports (read-only types get just `list`/`get`). Account-level `resolveOutput(...)` is also available.

### Reading storage objects

Storage-capable resources (e.g. buckets) come back with object read methods on them — fetch the bucket, then read its objects:

```ts
const cf = infra.accounts.cloudflare.getByName("production");
const bucket = await cf.r2Buckets.get("configs");
const file = await bucket.get("app.json");
const config = file.json<{ replicas: number }>();
infra.log("replicas:", config.replicas);

// list objects under a prefix
const logs = await bucket.list("logs/");
```

The object from `bucket.get(key)` exposes `.text()`, `.json<T>()`, and the raw `.base64`; `bucket.list(prefix?)` enumerates objects.

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

`kind` can be `text` (default), `password`, `number`, `boolean`, `select` (with `options`), or `code` — a multiline code editor for pasting in a snippet, JSON, a manifest, etc. (Tab indents; ⌘/Ctrl+Enter submits):

```ts
const manifest = await infra.prompt({
  message: "Paste the deployment manifest",
  kind: "code",
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
- **Cron** — run on a schedule. Pick a preset (every 15 minutes, daily at 9am, weekly…) or type a raw 5-field cron expression; the editor shows a plain-English summary of what you entered.
- **Git** — run on each new commit to a branch. **Connect GitHub**, choose a repository from the picker, and set the branch — the Infrawrench GitHub App watches that repo as a bot and runs the workflow when the branch head changes. Web/proxy only; the desktop app doesn't offer git triggers (its workflows are local with no always-on host to watch a repo).

**Platform support for automated triggers:**

| Trigger | Desktop           | Web | Web proxy |
| ------- | ----------------- | --- | --------- |
| Manual  | ✅                | ✅  | ✅        |
| Cron    | ✅ (while open\*) | ✅  | ✅        |
| Git     | —                 | ✅  | ✅        |

The web app runs cron and git triggers on an always-on cloud host. The **desktop app** runs your local cron workflows itself: while at least one cron workflow is enabled, Infrawrench keeps running in the background after you close the window (just like active metric-ping alerts) so the schedule keeps firing. \*It can't fire while the app is fully quit — quit it and the local schedule pauses until you reopen. For schedules that must run 24/7 regardless, use the cloud or the [web proxy](../core-concepts/desktop-vs-web.md).

### Connecting GitHub

Git triggers use a **GitHub App** (a bot identity) rather than per-repo webhooks. In the git trigger settings, click **Connect GitHub** — you'll install the app on the repositories you want to watch, then they appear in the repo picker. A separate **github-watcher** service polls each watched repo's branch head and runs the workflow on a new commit. Self-hosters configure the app with `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM), and `GITHUB_APP_SLUG`, and point the app's setup URL at `/api/github/setup`.

<insert [Screenshot of the git trigger settings showing Connect GitHub, the repository picker, and the branch field] here>

## The isolate sandbox

Workflow code never runs in the host process. It executes in a **QuickJS WebAssembly isolate** with a hard memory limit and a wall-clock timeout, and with no ambient access to the network or filesystem — the only capabilities a workflow has are the ones `infra` grants it (which themselves run with your account credentials on the host side, never exposed to the script). The same isolate runs identically on desktop and on the server, so a workflow behaves the same wherever it runs.

## Runs

Each execution records a run with its status, streamed logs, declared output, timings, and any error. The run history is on the workflow's page so you can see what a cron has been doing.

<insert [Screenshot of a workflow's run history list with statuses and durations, one run expanded to show logs] here>
