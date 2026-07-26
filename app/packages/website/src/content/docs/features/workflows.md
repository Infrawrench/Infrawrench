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

Every resource you get back also carries `delete()` (delete this resource), the SSH helpers below, and the **extended capabilities** a resource supports in the detail page — each throws a clear error if that provider/resource doesn't support it:

```ts
const droplet = await infra.accounts.digitalocean.getByName("prod").droplets.get(id);
await droplet.delete(); // same as droplets.delete(droplet.id)

// SQL query (REST query engines, e.g. BigQuery)
const { rows } = await dataset.query("SELECT count(*) FROM events");

// Key-value / Redis namespaces
await kvNamespace.kv.set("flag", "on");
const flag = await kvNamespace.kv.get("flag");
const { items } = await kvNamespace.kv.list({ prefix: "user:" });

// Document stores (Firestore / MongoDB / DynamoDB)
await collection.nosql("deleteDocument", ["users", "123"]);

// Kubernetes-style logs + describe + manifests
const { text } = await pod.logs({ tailLines: 200 });
const summary = await pod.describe();
await deployment.applyManifest(updatedYaml);
await infra.accounts.digitalocean.getByName("prod").importYaml(manifest); // kubectl apply -f

// Pub/sub publish + provider metrics
await queue.publish("hello"); // or { body, extras }
const series = await droplet.metrics({ startMs, endMs });

// SFTP (over the resource's SSH endpoint — same key handling as ssh())
const entries = await droplet.sftp.list("/var/log");
await droplet.sftp.put("/tmp/app.env", "KEY=value\n");
const bytes = await droplet.sftp.get("/etc/os-release"); // Uint8Array
const text = await droplet.sftp.get("/etc/os-release", { encoding: "utf8" }); // string
await droplet.sftp.mkdir("/tmp/data");
await droplet.sftp.delete("/tmp/old", { recursive: true });
```

These mirror the detail page's SQL editor, Keys/KV tab, document browser, Logs/Describe tabs, manifest editor, Publish tab, and Metrics — exposed as plain methods on the resource handle. **Each method only appears on the resource types that actually support it** (autocomplete won't offer `.ssh()` on a DNS record or `.kv` on a droplet), so the editor shows you exactly what a given resource can do.

**`create()` is typed from the real form.** Rather than a generic `Record<string, string>`, the fields argument is generated from the provider's actual create form — so the editor autocompletes the real field keys, and where a field has a closed set of choices (regions, sizes, images, plain selects) you get those values as literal suggestions. Creating a DigitalOcean droplet, for example, autocompletes `name`, `region`, `size`, `image`, and the SSH-key field, with the live region/size/image ids as options:

```ts
const droplets = infra.accounts.digitalocean.getByName("prod").droplets;
const droplet = await droplets.create({
  name: "web-1",
  region: "nyc3", // ← suggested from your account's live region list
  size: "s-1vcpu-1gb",
  image: "ubuntu-24-04-x64",
  sshPublicKey: "deploy-key", // ← suggested from your Infrawrench SSH keys (by name)
});
```

Options come from the provider's live catalog, so any other string still type-checks (the union is open) — you just lose the autocomplete hint.

**SSH-key fields reference your Infrawrench keys.** A provider's SSH-key field (and the `sshKey` option on `resource.ssh(...)`, below) autocompletes the **names of the SSH keys you manage in Infrawrench** — the same list shown by the SSH-key picker, refreshed each time the editor loads types, so a key you just added appears immediately. You can give it a key **name** (Infrawrench resolves it to that key's public key before the provider sees it) or paste a raw public key directly — both work.

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

### SSH into a resource

Any resource that exposes an SSH endpoint (a DigitalOcean droplet, a Hetzner/EC2 server, …) can be connected to right from a workflow. The common pattern is **create with a key → wait for it to come up → connect**:

```ts
const droplets = infra.accounts.digitalocean.getByName("prod").droplets;

// 1. Create the box with an Infrawrench SSH key attached (it boots with your key)
const droplet = await droplets.create({
  name: "build-runner",
  region: "nyc3",
  size: "s-2vcpu-4gb",
  image: "ubuntu-24-04-x64",
  sshPublicKey: "deploy-key", // a key name from your Infrawrench SSH keys
});

// 2. Wait until it accepts SSH (polls until reachable, or times out)
await droplet.waitUntilReachable();

// 3. Connect and run a command — resolves the full stdout as a string.
//    No sshKey needed: a resource you just created remembers the key you
//    attached, so ssh() uses it automatically.
const uname = await droplet.ssh("uname -a");
infra.log(uname.trim());
```

The implicit key only applies to resources returned from `create()` (where you attached the key). For a resource you fetched with `get()`/`list()`, pass `{ sshKey: "<name>" }` explicitly — Infrawrench has no way to know which key you intend.

`resource.ssh(command, opts)` is a single combined call:

- **Await the full result** — resolves a `string` (or a `Uint8Array` with `{ encoding: "binary" }`):

  ```ts
  const text = await droplet.ssh("cat /etc/os-release", { sshKey: "deploy-key" });
  const bytes = await droplet.ssh("cat /tmp/blob", { sshKey: "deploy-key", encoding: "binary" });
  ```

- **Stream output** — pass `{ stream: true }` to get a `{ stdout, stderr }` object. Each is a byte stream (async-iterable, with a `getReader()`); the object itself iterates `stdout` for convenience:

  ```ts
  const streams = droplet.ssh("journalctl -f", { sshKey: "deploy-key", stream: true });

  // Iterate stdout / stderr separately…
  for await (const chunk of streams.stderr) {
    infra.log("err:", new TextDecoder().decode(chunk));
  }
  ```

  **Tail straight to the run log** — pass the whole streams object to `infra.log(...)` and it streams both channels to the log as they arrive, line by line, with **stdout in the normal colour and stderr in red**:

  ```ts
  await infra.log(droplet.ssh("apt-get update", { sshKey: "deploy-key", stream: true }));
  ```

(`encoding` applies to the awaited result, not to streams — stream chunks are always raw bytes.)

`infra.log(...)` also accepts a `Uint8Array` (or `ArrayBuffer`) directly and decodes it as UTF-8 text — so logging raw bytes from `sftp.get` or a binary `ssh()` result prints the content, not a `{"0":104,…}` dump. It also **awaits any promise you pass it**, so you can hand it an unawaited `ssh()` / `sftp.get()` call directly:

```ts
await infra.log(droplet.sftp.get("/etc/os-release")); // awaits the read, then prints the file's text
```

Options: `sshKey` (an Infrawrench SSH key by name or id — autocompleted from your keys; its private half authenticates; not needed for providers with native SSH like Fly/Hetzner), `username` (defaults to the resource type's SSH user, e.g. `root`), `encoding`, `stream`, `timeoutMs`, and `skipHostKeyCheck` (accept whatever host key is presented without verifying or pinning it — handy for ephemeral hosts that get recreated with the same address, but it turns off MITM protection, so only use it on a trusted path).

`waitUntilReachable({ timeoutMs?, port? })` **polls** until the host accepts TCP on the SSH port — it keeps re-resolving the address too, so it works on a freshly-created VM that doesn't have an IP yet (it doesn't fail the instant the address is missing). It defaults to a few minutes before giving up. A workflow run has a generous wall-clock budget (5 minutes by default, which counts time spent waiting), enough to create a VM, wait for boot, connect, and clean up.

Host keys are trusted on first use for workflow connections and pinned; if a previously-seen host's key later changes, the connection is refused until you re-pin it (or pass `{ skipHostKeyCheck: true }`). On the desktop app an unknown host key shows a confirmation dialog — while it's open, **the run's time budget is paused**, so taking a moment to confirm doesn't eat into the execution timeout (SSH and `waitUntilReachable()` waits are excluded from the budget for the same reason). SSH is available for manual and automated runs alike.

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
- **Budget** — run when a [cost budget](./cloud-costs.md) crosses a threshold. Pick a budget, a percentage of its monthly amount, and whether to compare **spend so far** or the **forecast** month-end total. Web/proxy only (budgets are a cloud feature).

**Platform support for automated triggers:**

| Trigger | Desktop           | Web | Web proxy |
| ------- | ----------------- | --- | --------- |
| Manual  | ✅                | ✅  | ✅        |
| Cron    | ✅ (while open\*) | ✅  | ✅        |
| Git     | —                 | ✅  | ✅        |
| Budget  | —                 | ✅  | ✅        |

The web app runs cron and git triggers on an always-on cloud host. The **desktop app** runs your local cron workflows itself: while at least one cron workflow is enabled, Infrawrench keeps running in the background after you close the window (just like active metric-ping alerts) so the schedule keeps firing. \*It can't fire while the app is fully quit — quit it and the local schedule pauses until you reopen. For schedules that must run 24/7 regardless, use the cloud or the [web proxy](../core-concepts/desktop-vs-web.md).

### Connecting GitHub

Git triggers use a **GitHub App** (a bot identity) rather than per-repo webhooks. In the git trigger settings, click **Connect GitHub** — you'll install the app on the repositories you want to watch in a new tab, and when the install finishes that tab returns to Infrawrench with a confirmation and the repositories appear in the repo picker. If you're a member (not an owner) of the GitHub organization, GitHub only lets you _request_ the install — Infrawrench will tell you the install is awaiting an owner's approval, and the repos show up once an owner approves it on GitHub. A separate **github-watcher** service polls each watched repo's branch head and runs the workflow on a new commit. Self-hosters configure the app with `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM), and `GITHUB_APP_SLUG`, and point the app's setup URL at `/api/github/setup`.

<insert [Screenshot of the git trigger settings showing Connect GitHub, the repository picker, and the branch field] here>

### Budget triggers

A budget trigger reads: **when budget _A_ goes over _X_%, run this workflow**. Choose the budget, the percentage of its monthly amount, and which number to compare:

- **spend so far** — month-to-date actual spend. Fires once the money is genuinely gone.
- **forecast spend** — the projected month-end total. Fires earlier, while you can still do something about it.

Leave the percentage at `100` for a plain "went over budget". Set it lower (say `80`) to act before the limit, or above `100` to catch a serious overrun.

The crossing is evaluated on the server right after each cost collection, so a budget trigger needs no schedule of its own. It fires **at most once per calendar month** per budget — a workflow that shuts down a runaway cluster won't re-run every 15 minutes for the rest of the month. Editing the budget, percentage, or measure re-arms it immediately. Budget alerts (SMS/push) are configured separately on the budget itself; a workflow trigger doesn't require any alert thresholds on the budget.

The workflow receives the crossing as `infra.event`, typed for you when the trigger is set to Budget:

```ts
// infra.event is the budget crossing that started this run.
await infra.log(
  `${infra.event.budgetName} hit ${infra.event.percent}% ` +
    `(${infra.event.observedCents / 100} ${infra.event.currency} of ` +
    `${infra.event.amountCents / 100}) in ${infra.event.month}`,
);

// Scale the dev cluster down to nothing for the rest of the month.
const gcp = infra.accounts.gcp.getByName("production");
for (const cluster of await gcp.gkeClusters.list()) {
  if (cluster.name.startsWith("dev-")) await cluster.delete();
}

await infra.output({ budget: infra.event.budgetId, actedAt: infra.event.month });
```

For every other trigger `infra.event` is just `{ kind: "manual" | "cron" | "git" | "api" }`, so a workflow can branch on how it was started.

<insert [Screenshot of the budget trigger settings showing the budget picker, the percentage field, the spend/forecast selector, and the plain-English summary line] here>

### Signing webhook deliveries

Workflows with a git trigger also expose a plain webhook endpoint, matched by an opaque token in the URL, for providers other than the GitHub App path above. A URL is a weak secret — it ends up in access logs, proxy logs, and referrer headers — so set a **signing secret** in the git trigger settings whenever you use it.

With a secret set, a delivery must prove it knows the secret or it's rejected with a 401:

- **GitHub** and compatible senders: `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the exact request body. GitHub's older SHA-1 `X-Hub-Signature` is not accepted — honoring it would let a sender pick the weaker digest.
- **GitLab**: `X-Gitlab-Token` matching the secret directly.

Paste the same value into your provider's webhook configuration. The secret is write-only: after saving, the trigger shows **Signed ✓** and you can replace it, but the value is never displayed again. Leave it empty and the endpoint accepts unsigned deliveries on the strength of the token alone.

<insert [Git trigger row with a signing secret configured, showing the "Signed ✓" state and the Replace button] here>

## Writing workflows with an AI client

The [AI chat](./ai-chat.md) and [MCP](./mcp.md) surfaces can author workflows for you — "make a workflow that shuts down the dev cluster when my Production budget goes over 90%" is a single request. Both use the same tools:

| Tool                    | What it does                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `list_workflows`        | The org's workflows with their triggers, metrics, and last/next run.                               |
| `get_workflow`          | One workflow, including its source, current metric values, and recent runs.                        |
| `get_workflow_typings`  | The generated `infra.d.ts` — your real accounts, resource types, create fields, and SSH key names. |
| `check_workflow_source` | Type-checks a draft without saving it.                                                             |
| `write_workflow`        | Creates or updates a workflow. Type-checks first and **refuses to save** source with type errors.  |
| `run_workflow`          | Runs it now and returns the status, logs, output, and any error.                                   |
| `delete_workflow`       | Soft-deletes it (run history is kept).                                                             |

`get_workflow_typings` is the important one. The `infra` API is generated per organization — account names, which resource groups exist, which fields `create()` takes — so a model that writes from memory guesses wrong. Handing it the real declaration file first is what makes the generated code compile against _your_ setup. It also reflects the trigger: a budget-triggered workflow gets `infra.event` typed as the crossing payload, and only manual workflows get `infra.prompt`.

`write_workflow` then runs the same type check the editor runs and returns the diagnostics (`line:column`, TypeScript error code, message) instead of saving a broken workflow — so the model can fix its own mistakes before anything is persisted. Pass `skipTypecheck` to override that deliberately.

Workflow tools need the same `dashboards:read` / `dashboards:write` [permissions](../team-and-billing/roles-and-permissions.md) as the Workflows tab, and `write_workflow`, `run_workflow`, and `delete_workflow` are all audit-logged. `run_workflow` and `delete_workflow` are **destructive tools** — in chat they wait for your approval before running. Running a workflow executes arbitrary code that can create or delete infrastructure, which is why it needs the same confirmation as deleting one.

A workflow's code runs with your account credentials. Read the source of anything you didn't write before you enable it or hand it to `run_workflow`.

## The isolate sandbox

Workflow code never runs in the host process. It executes in a **QuickJS WebAssembly isolate** with a hard memory limit and a wall-clock timeout, and with no ambient access to the network or filesystem — the only capabilities a workflow has are the ones `infra` grants it (which themselves run with your account credentials on the host side, never exposed to the script). The same isolate runs identically on desktop and on the server, so a workflow behaves the same wherever it runs.

## Debugging

A **manual run from the editor is a debug run**: as it executes, the editor **highlights the line currently running**, so you can watch a workflow step through `create → waitUntilReachable → ssh → delete` in real time.

**Breakpoints.** Click the gutter (left margin) next to a line to set a breakpoint (a red dot). When the run reaches that line it **pauses** before executing it, and the toolbar shows:

- **Resume** — continue until the next breakpoint.
- **Step** — run the current line, then pause on the next one.
- **Stop** — abort the run.

You can add or remove breakpoints while a run is paused. Time spent paused at a breakpoint (and `infra.prompt`, SSH, and `waitUntilReachable` waits) doesn't count against the run's execution budget.

<insert [Screenshot of the Workflows editor mid-run: a line highlighted as the current line, a red breakpoint dot in the gutter, and Resume/Step/Stop buttons in the toolbar] here>

Debugging works on both the desktop app and the web app (the web run streams over a websocket). Highlighting reports each line as it runs, so very tight loops execute a bit slower while the editor is driving them; automated cron/git runs are never instrumented. Breakpoints only stop on top-level statements — lines inside a function/callback aren't paused individually.

## Runs

Each execution records a run with its status, streamed logs, declared output, timings, and any error. The run history is on the workflow's page so you can see what a cron has been doing.

<insert [Screenshot of a workflow's run history list with statuses and durations, one run expanded to show logs] here>
