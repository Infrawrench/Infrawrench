---
title: Workflows
description: Automate tasks across all your connected accounts with TypeScript workflows you run by hand, on a schedule, from git pushes, or when a budget is crossed.
sidebar_order: 8
---

Workflows let you script actions across every account you've connected to Infrawrench. A workflow is a **TypeScript file** you write in a full code editor, with autocomplete built from _your_ accounts. Workflows run in a secure sandbox on the desktop app, the web app and the web proxy.

A typical example: grab a config file from a Cloudflare R2 bucket, parse it as JSON, and use those values to update DNS records or a database. That takes a few lines, with full type-checking.

![Screenshot of the Workflows tab showing the Monaco editor with infra.* autocomplete open](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/editor-infra-autocomplete.png)

## The `infra` object

Every workflow gets a global `infra` object. Its types come from your connected accounts, so autocomplete shows exactly the providers, accounts and resource types you actually have.

### Work with accounts and resources

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

`infra.accounts.<plugin>` gives you `list()`, `getById(id)` and `getByName(name)`. On an account, each resource type is a group named after its plural name: `account.<type>.list()` and `account.<type>.get(id)`, plus `.create/.update/.delete(...)` where the provider supports them. Read-only types only get `list` and `get`. You can also call `resolveOutput(...)` on the account.

Every resource you get back also has `delete()`, the SSH helpers below, and the same extra actions its detail page offers. If a provider or resource doesn't support one, the call throws a clear error.

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

// SFTP (over the resource's SSH endpoint, same key handling as ssh())
const entries = await droplet.sftp.list("/var/log");
await droplet.sftp.put("/tmp/app.env", "KEY=value\n");
const bytes = await droplet.sftp.get("/etc/os-release"); // Uint8Array
const text = await droplet.sftp.get("/etc/os-release", { encoding: "utf8" }); // string
await droplet.sftp.mkdir("/tmp/data");
await droplet.sftp.delete("/tmp/old", { recursive: true });
```

These match the detail page's SQL editor, Keys/KV tab, document browser, Logs and Describe tabs, manifest editor, Publish tab and Metrics. **Each method only appears on resource types that support it.** Autocomplete won't offer `.ssh()` on a DNS record or `.kv` on a droplet, so the editor shows you what each resource can actually do.

### Create resources with real form fields

The fields you pass to `create()` match the provider's actual create form. The editor autocompletes the real field names, and where a field has a fixed set of choices (regions, sizes, images, dropdowns) it suggests those values. Creating a DigitalOcean droplet, for example, autocompletes `name`, `region`, `size`, `image` and the SSH key field, with your account's live region, size and image ids as options:

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

Suggestions are just hints. Any other string still type-checks, you only lose the autocomplete.

**SSH key fields use your Infrawrench keys.** A provider's SSH key field (and the `sshKey` option on `resource.ssh(...)`, below) autocompletes the names of the SSH keys you manage in Infrawrench, the same list as the SSH key picker. A key you just added shows up the next time the editor loads. You can give a key **name** (Infrawrench swaps in that key's public key for you) or paste a raw public key.

### Reach inside a cluster or managed database

Some resources contain other resources. Everything the Kubernetes plugin can do works inside a managed Kubernetes cluster (DOKS, EKS, GKE, AKS, Kapsule), and the `postgres` / `mysql` / `redis` / `mongodb` plugins work inside a managed database. These are the same extra tabs you see on the resource's detail page.

In a workflow they show up as a property on the parent resource, named after the plugin:

```ts
const gcp = infra.accounts.gcp.getByName("production");

for (const cluster of await gcp.gkeClusters.list()) {
  for (const pod of await cluster.kubernetes.pods.list()) {
    if (Number(pod.fields.restarts) > 3) {
      await infra.page(`${pod.displayName} has restarted ${pod.fields.restarts} times`, {
        key: `pod-restarts-${pod.id}`,
      });
    }
  }
}

// Managed databases work the same way
const instance = await gcp.cloudSQLInstances.get(instanceId);
const databases = await instance.postgres.postgresqlDatabases.list();
```

Inside, everything works like an account's own resources: `list()`, `get(id)`, `create/update/delete(...)` where supported, and each type's extra actions, so `pod.logs()` and `pod.describe()` are right there. You never handle the kubeconfig or connection string yourself.

A few things to know:

- The editor may offer more than one engine. A Cloud SQL instance offers both `.postgres` and `.mysql`, even though each instance runs one engine. Using the wrong one fails with a clear error.
- Resources inside a cluster or database don't get `ssh()`/`sftp` or bucket reads. The editor won't offer them.
- Extra actions like `pod.logs()` only appear once you have at least one cluster (or database) of that type. Create your first one and they show up the next time the editor loads.
- They don't nest: things inside a cluster don't have clusters of their own.

### Read storage objects

Buckets and other storage resources come back with methods for reading their objects. Fetch the bucket, then read from it:

```ts
const cf = infra.accounts.cloudflare.getByName("production");
const bucket = await cf.r2Buckets.get("configs");
const file = await bucket.get("app.json");
const config = file.json<{ replicas: number }>();
infra.log("replicas:", config.replicas);

// list objects under a prefix
const logs = await bucket.list("logs/");
```

The object from `bucket.get(key)` has `.text()`, `.json<T>()` and the raw `.base64`. `bucket.list(prefix?)` lists objects.

### SSH into a resource

You can connect to any resource with an SSH endpoint (a DigitalOcean droplet, a Hetzner or EC2 server and so on) from a workflow. The usual pattern is: create it with a key, wait for it to come up, connect.

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

// 3. Connect and run a command. Resolves the full stdout as a string.
//    No sshKey needed: a resource you just created remembers the key you
//    attached, so ssh() uses it automatically.
const uname = await droplet.ssh("uname -a");
infra.log(uname.trim());
```

That automatic key only works for resources returned by `create()`. For a resource you fetched with `get()` or `list()`, pass `{ sshKey: "<name>" }` yourself, since Infrawrench can't know which key you mean.

`resource.ssh(command, opts)` works two ways.

**Wait for the full result.** It resolves a `string` (or a `Uint8Array` with `{ encoding: "binary" }`):

```ts
const text = await droplet.ssh("cat /etc/os-release", { sshKey: "deploy-key" });
const bytes = await droplet.ssh("cat /tmp/blob", { sshKey: "deploy-key", encoding: "binary" });
```

**Stream the output.** Pass `{ stream: true }` to get a `{ stdout, stderr }` object. Each is a byte stream you can loop over with `for await` or read with `getReader()`. Looping over the object itself gives you `stdout`.

```ts
const streams = droplet.ssh("journalctl -f", { sshKey: "deploy-key", stream: true });

// Iterate stdout / stderr separately…
for await (const chunk of streams.stderr) {
  infra.log("err:", new TextDecoder().decode(chunk));
}
```

To tail straight into the run log, pass the whole streams object to `infra.log(...)`. Both channels stream in line by line, stdout in the normal colour and stderr in red:

```ts
await infra.log(droplet.ssh("apt-get update", { sshKey: "deploy-key", stream: true }));
```

`encoding` only applies to the awaited result. Stream chunks are always raw bytes.

`infra.log(...)` also accepts a `Uint8Array` (or `ArrayBuffer`) and prints it as UTF-8 text, so logging bytes from `sftp.get` or a binary `ssh()` result shows the content rather than a list of numbers. It also waits for any promise you pass it, so you can hand it an `ssh()` or `sftp.get()` call directly:

```ts
await infra.log(droplet.sftp.get("/etc/os-release")); // awaits the read, then prints the file's text
```

SSH options:

- `sshKey`: an Infrawrench SSH key by name or id, autocompleted from your keys. Not needed for providers with built-in SSH like Fly and Hetzner.
- `username`: defaults to the resource type's SSH user, for example `root`.
- `encoding`, `stream`, `timeoutMs`.
- `skipHostKeyCheck`: accept any host key without checking or remembering it. Handy for short-lived hosts that keep getting recreated at the same address, but it turns off protection against man-in-the-middle attacks, so only use it on a network you trust.

`waitUntilReachable({ timeoutMs?, port? })` keeps checking until the host accepts connections on the SSH port. It works on a brand-new VM that doesn't have an IP yet, and gives up after a few minutes by default. A run gets 5 minutes by default, enough to create a VM, wait for it to boot, connect and clean up.

Host keys are trusted the first time you connect and remembered after that. If a known host's key later changes, the connection is refused until you re-pin it (or pass `{ skipHostKeyCheck: true }`). On the desktop app, an unknown host key shows a confirmation dialog, and the run's clock pauses while it's open. Time spent in SSH and `waitUntilReachable()` doesn't count against the run's time limit either. SSH works in both manual and automated runs.

### Ask the user for input

In **manual** runs you can ask for input partway through:

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

`kind` can be `text` (default), `password`, `number`, `boolean`, `select` (with `options`) or `code`. `code` opens a multiline editor for pasting a snippet, JSON or a manifest (Tab indents, ⌘/Ctrl+Enter submits):

```ts
const manifest = await infra.prompt({
  message: "Paste the deployment manifest",
  kind: "code",
});
```

`infra.prompt(...)` only works in manual runs. Cron and git runs have nobody to answer, so calling it there throws, and the editor flags it while you type.

### Log and return output

```ts
infra.log("starting reconcile");
await infra.output({ updated: 3 }); // shown in the run result
```

### Call an HTTP API

`fetch` is available and works the way you'd expect:

```ts
const res = await fetch("https://api.example.com/v1/incidents", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: { title: "disk 90% full", severity: "warning" },
});
if (!res.ok) throw new Error(`incident API returned ${res.status}`);
const created = await res.json<{ id: string }>();
await infra.log(`opened incident ${created.id}`);
```

Use it to talk to anything Infrawrench has no plugin for: a status page, a ticketing system, an internal service with an HTTP API, or a vendor's billing export you then pass to [`infra.costs.write`](#reporting-your-own-cost-data).

It's a smaller version of the browser's `fetch`:

| Difference                                                          | What it means for you                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| The body is fully buffered, so `text()`/`json()`/`bytes()` re-read  | No streaming, but you can read the body more than once.                    |
| A non-string, non-bytes `body` is sent as JSON automatically        | With `content-type: application/json` unless you set that header yourself. |
| Two extra options: `timeoutMs` (default 30s) and `maxBytes` (5 MiB) | A response bigger than the limit **fails** rather than being cut short.    |
| No `Request`/`Headers` constructors, no cookies, no `signal`        | Pass plain objects instead.                                                |

Allowed methods are GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. You can't set connection headers like `host`, `content-length` or `transfer-encoding`.

**Cloud workflows can only reach the public internet.** Private and loopback addresses (`10.0.0.1`, `127.0.0.1`, `169.254.169.254`), internal names (`*.svc`, `*.cluster.local`, `*.internal`) and non-HTTP schemes are refused, including after a redirect. You'll see the refusal in the run log:

```
fetch() failed: 169.254.169.254 is a private address and is not proxied.
```

To reach something on a private network, give the workflow a route you control, such as an SSH command on a resource that can see it ([`resource.ssh`](#ssh-into-a-resource)) or a tunnel.

**Local desktop workflows** make requests straight from your own machine, so your LAN and localhost work. A workflow that calls `http://192.168.1.10:9200/` works locally but is refused in the cloud. Keep that in mind if you move it to an organization: organization workflows always run in the cloud, even when you edit them from the desktop app.

A run can make up to 250 requests, and time spent in `fetch` counts against the run's time limit, so a loop that polls an API can't run forever.

### Asking a model for help

> **Cloud only.** `infra.ai` isn't available in local desktop workflows, and it's billed like [AI chat](./ai-chat.md).

Some steps need judgement rather than a rule: is this log tail alarming, which of these errors are the same incident, what should the page say. `infra.ai(...)` sends one prompt to a model and returns its reply:

```ts
// Cron: hourly. Let the model read the log tail before waking anyone up.
const cluster = infra.accounts.kubernetes.getByName("prod");
for (const pod of await cluster.pods.list()) {
  const restarts = Number(pod.fields.restarts ?? 0);
  if (restarts <= 5) continue;
  const { text } = await pod
    .logs({ tailLines: 200 })
    .then((l) =>
      infra.ai(
        `These are the last 200 log lines of a crash-looping pod. In two sentences, what is failing and does it look self-inflicted (bad config, OOM) or external (dependency down)?\n\n${l.text}`,
      ),
    );
  await infra.page(`${pod.displayName} restarted ${restarts} times. ${text}`, {
    key: pod.displayName,
  });
}
```

**The model only sees what you send it.** Unlike [writing workflows with an AI client](#writing-workflows-with-an-ai-client), `infra.ai` is not an agent. It has no tools, no access to your accounts or resources, and no memory between calls. Put what you want it to look at (a log tail, a diff, a list of alerts) in the prompt.

| Option      | Default             | What it does                                                                          |
| ----------- | ------------------- | ------------------------------------------------------------------------------------- |
| `model`     | `"claude-sonnet-5"` | Also `"claude-haiku-4-5"` (fastest, cheapest) or `"claude-opus-5"` (most capable).    |
| `system`    | none                | A system prompt framing how to answer ("Reply with one word: PAGE or IGNORE.").       |
| `maxTokens` | `1024`              | Cap on the reply length, up to 8192. Check `stopReason === "max_tokens"` for cutoffs. |

The result includes `text`, the `model` that answered, `stopReason` (`"end"` or `"max_tokens"`), token counts, and `costMicros` (the cost in millionths of a dollar).

**Billing.** Calls are billed exactly like [AI chat](./ai-chat.md) and come out of the **same monthly AI spend**: your organization's cap, or the $5/month free tier without a paid plan. Once that's used up, `infra.ai` throws (and so does chat) until the cap is raised or the month resets. Stopping a run cancels any call in progress. Prompts are billed as input tokens, so watch what a cron loop sends: an hourly workflow that sends 200k characters to Opus adds up.

Limits: 20 calls per run, prompts up to 200,000 characters, and two minutes per call. Waiting on the model doesn't count against the run's time limit, so the 20-call cap is what bounds an `infra.ai` loop.

If the model refuses to answer, the call throws instead of returning an empty string, so your code can't quietly take the wrong branch. Catch it if you have a fallback.

### Paging a human

A workflow that finds a problem can wake someone up. `infra.page(...)` goes to the same people as [sync-failure incidents and budget alerts](./mobile-push-notifications.md): SMS (and optionally a voice call) through your organization's Twilio credentials, mobile push to everyone with the app installed, and any [Slack](./slack-alerts.md) or [Microsoft Teams](./teams-alerts.md) channels opted into pages. Choose who gets them under **Settings > Notifications**.

```ts
// Cron: hourly. Page when a pod's restart count runs away.
const cluster = infra.accounts.kubernetes.getByName("prod");
for (const pod of await cluster.pods.list()) {
  const restarts = Number(pod.fields.restarts ?? 0);
  if (restarts > 5) {
    await infra.page(`${pod.displayName} has restarted ${restarts} times`, {
      title: "Pod restarts",
      key: pod.displayName,
    });
  } else {
    // Recovered: re-arm this pod so a fresh spike pages immediately.
    await infra.page.clear(pod.displayName);
  }
}
```

**Repeat pages are throttled, so you can call it every time.** A monitoring cron finds the same problem on every run. Without throttling, an hourly check would send 24 messages a day about one broken pod. Instead, every page has a **key**, and once a key has fired, further pages with that key are held back until its cooldown ends (one hour by default). The check above runs hourly and pages once.

Pick the key to match what you're watching. The example uses the pod name, so ten unhealthy pods send ten pages and one flapping pod can't silence the other nine. Leave `key` out and everything shares a key called `default`, which is fine when the workflow watches one thing.

| Option            | Default             | What it does                                                       |
| ----------------- | ------------------- | ------------------------------------------------------------------ |
| `title`           | the workflow's name | Headline of the push notification.                                 |
| `key`             | `"default"`         | Throttle bucket. Pages sharing a key suppress one another.         |
| `cooldownMinutes` | `60`                | How long a key stays quiet after firing. `0` sends on every call.  |
| `voice`           | `false`             | Also place a Twilio voice call to recipients who opted into voice. |

The result tells you what happened: `delivered`, `suppressed`, how many `sms`, `push`, `slack` and `msTeams` messages went out, and `retryAt` if it was held back:

```ts
const result = await infra.page("nightly backup did not complete");
if (result.suppressed) infra.log(`already paged; quiet until ${result.retryAt}`);
```

`infra.page.clear(key)` resets a key's cooldown. Call it when things recover so the next problem pages straight away. A cooldown only starts when a page actually reached someone, so if every channel fails, the next run tries again.

A server outside Infrawrench can send the same page over HTTP. See [Push from your own servers](./server-push.md). Keys and cooldowns are separate there, so an API caller and a workflow never throttle each other.

In a **local** desktop workflow there's no SMS, push, Slack or Teams, so a page shows up as a desktop notification on the machine running the workflow. Keys and cooldowns work the same. Organization workflows use every channel whether you run them from the web or the desktop app.

### Wait for a human to approve

Some steps shouldn't run just because the script got there. `infra.waitForApproval(...)` pauses the run until someone in your organization approves or denies it:

```ts
// Cron: nightly cleanup, but a human signs off before anything is deleted.
const gcp = infra.accounts.gcp.getByName("production");
const stale = (await gcp.gkeClusters.list()).filter((c) => c.displayName.startsWith("dev-"));

if (stale.length > 0) {
  await infra.waitForApproval(`Delete ${stale.length} dev cluster(s)?`, {
    title: "Nightly dev cleanup",
    timeoutMinutes: 120,
  });
  for (const cluster of stale) await cluster.delete();
}
```

While the run waits, a **pending approval card** with **Approve** and **Deny** buttons appears on the workflow's run view, and the request goes out on every channel your organization has set up (see below). Approving lets the run continue within a few seconds. The call returns `{ approved: true, decidedBy, decidedAt }`, so you can log who signed off.

![Screenshot of the Workflows tab with a run suspended on an approval: the amber pending-approval card above the run log showing the request title, message, expiry time, and Approve/Deny buttons](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/run-pending-approval.png)

**A denial or a timeout throws.** If someone denies the request, or nobody decides before it expires (60 minutes by default, up to 24 hours), the call throws and the run fails unless you catch it. Silence never counts as approval: an unanswered request is treated as denied.

| Option           | Default             | What it does                                               |
| ---------------- | ------------------- | ---------------------------------------------------------- |
| `title`          | the workflow's name | Headline of the approval card and of every notification.   |
| `timeoutMinutes` | `60`                | How long to wait before the request expires and is denied. |

Waiting for a decision doesn't count against the run's time limit, so a run can wait out a long approval.

Approvals are **cloud only**. `infra.waitForApproval` isn't available in local desktop workflows, and the editor flags it while you type.

#### Who gets notified

An approval request goes out on every channel your organization has set up: mobile push, any [Slack](./slack-alerts.md) or [Microsoft Teams](./teams-alerts.md) channel opted into **Pages**, and SMS to your Twilio recipients when that's configured. It uses the same **Pages** opt-in as `infra.page(...)`. Approvals send SMS only, never a voice call.

Each message says what's being approved, which workflow and run it's for, whether a person or a schedule started the run, when the request expires, and that no decision counts as a denial. Slack and Teams messages include a button to the approvals inbox.

Texts are limited to one per workflow every 15 minutes, so a workflow that asks for approval in a loop doesn't flood everyone's phone. Push, Slack and Teams get one message per request. The first request always sends, each workflow has its own limit, and the approvals inbox always lists every pending request.

You can also list and decide approvals over the HTTP API, for example from a chat-ops bot: `GET /api/org/{orgId}/workflow-approvals?status=pending` and `POST /api/org/{orgId}/workflow-approvals/{id}/approve` (or `/deny`). Listing needs `workflows:read` and deciding needs `workflows:approve` (see [Roles and permissions](../team-and-billing/roles-and-permissions.md)).

#### The approvals inbox

The card on a run view shows what that workflow is waiting for. To see everything waiting on you, open **Settings > Approvals**. It lists every pending request across the organization: what's being approved, which workflow and run raised it, when it was requested, when it expires, and **Approve** / **Deny** buttons.

![Settings → Approvals page listing two pending approval requests from different workflows, each showing the request title, message, workflow name, run id, countdown to expiry, and the Approve/Deny buttons](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/approvals-inbox.png)

Anyone with `workflows:read` can see the page. The Approve and Deny buttons only appear with `workflows:approve`. The page refreshes itself every few seconds, and if someone else decided a request first, you'll be told rather than overwriting their decision.

In the desktop app, a banner above the Workflows tab shows the same inbox whenever the selected organization has pending requests.

#### Deciding from your phone

The [mobile app](./mobile-app.md) has the same inbox under **Settings > Approvals**. Tapping an approval notification opens it with that request at the top. Each card shows the request, the workflow and run it's blocking, when it was requested, the time left, and the reminder that no decision counts as a denial.

Deciding on a phone always takes **two taps**. **Approve** and **Deny** open a confirmation that names the request, workflow, run and deadline, and says what happens: approving lets a run continue against your real infrastructure, and denying fails it at that step and can't be undone. Nothing is sent until you confirm.

Otherwise it works like the web page: you need `workflows:read` to see the list and `workflows:approve` for the buttons, it refreshes on its own and when you pull down, and a request someone else already decided shows **"Already decided"**. If the request you were notified about has already been decided or expired, the screen tells you.

<insert [Mobile Settings → Approvals screen opened from a push notification: the deep-linked request highlighted at the top with its workflow, run id and expiry countdown, and the Approve confirmation dialog naming the request and its deadline] here>

### Reporting your own cost data

Infrawrench collects spend from every provider with a billing API, but plenty of costs don't come from one: a SaaS invoice, an internal chargeback, a colo bill, a provider with no plugin yet. A workflow can report those numbers, and they show up alongside provider spend in [cost graphs](./cloud-costs.md), filters and budgets.

```ts
// A nightly cron that pulls yesterday's Snowflake spend and reports it.
const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const warehouse = infra.accounts.snowflakeish.getByName("analytics");
const { rows } = await warehouse.query(`SELECT ... WHERE usage_date = '${day}'`);

await infra.costs.write(
  rows.map((r) => ({
    date: day,
    currency: "USD",
    amount: Number(r.credits_used) * 2.5,
    service: String(r.warehouse_name),
    tags: { team: String(r.team) },
  })),
);
```

Each row needs a `date` (`YYYY-MM-DD`, UTC), a 3-letter `currency` and an `amount`. Everything else is optional and becomes something you can group and filter by: `service`, `region`, `resourceId`, `tags`, plus `usageAmount`/`usageUnit` for unit costs. A negative `amount` is a credit. Pass a single row or an array.

**Re-running is safe.** Writing a row with the same day, service, region, resource, tags and currency **replaces** the earlier value instead of adding to it. A cron can re-report the past week every night to catch late charges without double-counting.

**Where it shows up.** Workflow rows show **Workflow** as their provider and, by default, appear in the account filter as "&lt;workflow name&gt; (workflow)". Pass `accountId` on a row to attribute it to one of your connected accounts instead, which is useful for chargebacks or discounts that belong to a real account:

```ts
const aws = infra.accounts.aws.getByName("production");
await infra.costs.write({
  date: day,
  currency: "USD",
  amount: -1200,
  service: "Negotiated discount",
  accountId: aws.id,
});
```

Every workflow row is tagged `infrawrench:workflow` with the name of the workflow that wrote it, and it can never overwrite spend collected from a provider. Because its provider stays "Workflow", a budget or graph filtered to a specific _provider_ won't include these rows. Filter by account, service or tag instead.

Limits: 1,000 rows per call (bigger arrays are split for you) and 50,000 rows per run. Tag keys starting with `infrawrench:` are reserved and rejected. `infra.costs` is cloud only, so it isn't available in local desktop workflows, and the editor flags it while you type.

### Read the carbon estimate

`infra.carbon` reads the same [estimated carbon](./carbon.md) figures as the Costs page. `estimate({ windowDays })` returns your organization's total, broken down by provider, region and account, plus the resources that couldn't be estimated. `resource(resourceId, fields?)` returns one resource's monthly price and carbon. Pass `fields` to check a proposed change, for example what a resize would save before you apply it:

```ts
const before = await infra.carbon.resource(resourceId);
const after = await infra.carbon.resource(resourceId, { instanceType: "m7g.large" });
if (before.carbon?.estimate && after.carbon?.estimate) {
  console.log(
    `Saves ~${(before.carbon.estimate.kgCo2e - after.carbon.estimate.kgCo2e).toFixed(1)} kg CO2e/month`,
  );
}
```

These are estimates, not measurements. `carbon.estimate` is `null` (with a `reason`) when there's no published figure for the region or size. Reading needs **Costs: read**. Like `infra.costs`, it's cloud only.

## Secrets

Workflow secrets are encrypted organization values for API tokens, signing keys and other credentials your workflows need. Create or rotate them in the workflow editor's **Secrets** section, then assign each workflow only the secrets it should get. Values are write-only: once saved, Infrawrench shows **Value set** and never displays the value again.

Each assigned secret becomes a read-only, typed property:

```ts
const response = await fetch("https://api.example.com/deploy", {
  method: "POST",
  headers: { authorization: `Bearer ${infra.secrets.DEPLOY_TOKEN}` },
});
```

Names can be simple, like `DEPLOY_TOKEN`, or dotted, like `stripe.apiKey` (used as `infra.secrets.stripe.apiKey`). The editor only autocompletes secrets assigned to that workflow.

Good to know:

- A run fails before it starts if an assigned secret has no value.
- The person the run acts for needs `secrets:read`.
- Assigned values are hidden in saved logs and output, but don't deliberately print or transform credentials in your code.
- One secret can be used by many workflows, but you assign it to each one explicitly. Deleting a secret removes it from every workflow.
- Organization config exports and the editor's type information never include secret values.

![Workflow editor Secrets section showing reusable secrets, Value set status, and assignment checkboxes](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/editor-secrets-section.png)

## Metrics

When you create a workflow you can add **metrics** in the UI (a key, label, type and optional unit). Each one becomes a typed property on `infra.metrics`, named after its key. Read it like a variable, and assign to it to save a new value:

```ts
// `runCount` is a declared number metric → typed `number | null`
infra.metrics.runCount = (infra.metrics.runCount ?? 0) + 1;

// a string metric
infra.metrics.lastRegion = "us-east";
```

Values are read as they were when the run started, so there's no `await`. New values are saved when the run finishes, even if it fails, so partial progress is kept. Values carry over between runs: a nightly cron can count up, and a manual run sees the latest number. The editor autocompletes `infra.metrics.` with exactly your keys and types.

![Screenshot of the workflow create form showing the metrics section with a key, label, type and unit](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/metrics-section.png)

## Local and organization workflows

A workflow belongs either to your machine or to an organization. The **desktop app follows the org switcher** to decide which ones it shows, the same as accounts, dashboards and costs.

- **Local mode**: workflows live on your machine and run against the accounts you've added locally. Nobody else sees them.
- **An organization selected**: the Workflows tab shows that organization's workflows, shared with your teammates and the same as on the web app. They run in the cloud against the organization's accounts.

Switching orgs swaps the list. Nothing is copied between the two. To move a local workflow into an organization, copy its source across. The `infra` object works the same in both, as long as the organization has accounts for the providers it uses.

Where a workflow lives changes a few things:

- Local workflows can't use `infra.costs`, `infra.ai` or `infra.waitForApproval`.
- In local workflows, `infra.page` shows a desktop notification instead of sending SMS, push, Slack and Teams messages.
- The available triggers differ. See the table under [Triggers](#triggers).

## Pin a workflow to a dashboard

Drag a workflow from the list on the left of the **Workflows** tab onto any dashboard (or onto a dashboard in the sidebar). Use the search box above the list to filter by name. The workflow appears as a card showing its metrics and their current values, when it last ran, and a **Run** button that runs it and updates the values in place. That turns a dashboard into a live readout of whatever your workflows track.

In Local mode you pin local workflows onto local dashboards. With an organization selected you pin that organization's workflows onto its dashboards.

![Screenshot of a dashboard with a pinned workflow card showing metric values, a last-run line, and a Run button](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/dashboard-workflow-pin.png)

## Triggers

Open the trigger settings to choose how a workflow runs:

- **Manual**: run it from the UI when you want. The only mode where `infra.prompt` works. Available everywhere (desktop, web, proxy).
- **Cron**: run on a schedule. Pick a preset (every 15 minutes, daily at 9am, weekly and so on) or type a 5-field cron expression. See [Cron schedules](#cron-schedules).
- **Git**: run on every new commit to a branch. Click **Connect GitHub**, pick a repository and set the branch. The workflow runs whenever that branch gets a new commit. Needs an organization.
- **Budget**: run when a [cost budget](./cloud-costs.md) crosses a threshold. Pick a budget, a percentage of its monthly amount, and whether to compare **spend so far** or the **forecast** month-end total. Needs an organization.

**The triggers you can pick depend on where the workflow lives**, not which app you're using. The desktop app with an organization selected offers the same four triggers as the web app:

| Trigger | Desktop (local)    | Desktop (org) | Web | Web proxy |
| ------- | ------------------ | ------------- | --- | --------- |
| Manual  | Yes                | Yes           | Yes | Yes       |
| Cron    | Yes (while open\*) | Yes           | Yes | Yes       |
| Git     | No                 | Yes           | Yes | Yes       |
| Budget  | No                 | Yes           | Yes | Yes       |

Organization workflows run their cron and git triggers in the cloud, whichever app you created them in. **Local** cron workflows are run by the desktop app. While at least one is enabled, Infrawrench keeps running in the background after you close the window so the schedule keeps firing. \*It can't run while the app is fully quit; the schedule picks up again when you reopen it. For schedules that must run around the clock, put the workflow in an organization or use the [web proxy](../core-concepts/desktop-vs-web.md).

### Cron schedules

The cron trigger takes a standard **5-field expression** (minute, hour, day of month, month, day of week). It supports `*`, lists (`1,15`), ranges (`9-17`), steps (`*/5`, `9-17/2`) and 3-letter month and weekday names (`JAN`, `MON`). `7` also means Sunday. When you set both day fields, a date matches if _either_ one does: `0 0 13 * 5` means "the 13th, or any Friday", as in standard cron.

Next to the expression is an optional **timezone** field that takes a name like `Europe/London`. Leave it empty for UTC. Times are read in that zone, so `0 9 * * *` in `America/New_York` keeps firing at 9am local time across daylight saving changes. A time skipped when clocks go forward doesn't fire that day, and during the repeated hour when clocks go back, it fires once.

As you type, the editor checks the expression (a typo shows the error instead of saving a schedule that never fires), describes it in plain English, and shows the **next few run times**. Saving doesn't run the workflow straight away; the first run is at the next scheduled time. The enable toggle pauses the schedule without losing it. Each scheduled time runs the workflow exactly once.

![Screenshot of the cron trigger settings showing the preset picker, the 5-field expression input, the timezone field, and the plain-English summary with the next three run times](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/cron-trigger-settings.png)

You can also manage a workflow's schedule over the API with `GET`/`PUT`/`DELETE /api/org/{orgId}/workflows/{id}/schedule`, for example to pause it from a script, without sending the whole workflow. See the [API docs](../team-and-billing/openapi.md).

### Connecting GitHub

Git triggers use the Infrawrench **GitHub App**.

1. In the git trigger settings, click **Connect GitHub**.
2. In the new tab, install the app on the repositories you want to watch.
3. When the install finishes, the tab returns to Infrawrench with a confirmation, and your repositories appear in the repo picker.

A few things to know:

- If you're a member (not an owner) of the GitHub organization, GitHub only lets you _request_ the install. Infrawrench tells you it's waiting for an owner, and the repos appear once an owner approves it on GitHub.
- You need to be signed in to Infrawrench in that tab as the same person who clicked **Connect GitHub**. If you aren't (the desktop app opens the install page in your browser), you'll be asked to sign in first, then the connection finishes.
- Infrawrench only connects an installation your GitHub account can access.
- The install link expires after an hour.
- An installation already connected to another Infrawrench organization can't be connected again until that organization disconnects it.

**Self-hosting.** Configure the app with `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM), `GITHUB_APP_SLUG`, and the app's OAuth `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`. In the app's settings, set the **Setup URL** to `<your app URL>/api/github/setup`, add the same URL as a **Callback URL**, and leave **Request user authorization (OAuth) during installation** unchecked. Without the client id and secret, new connections are refused (existing ones keep working). To let the same app [file findings as GitHub issues and open Terraform pull requests](./github-issues.md), also give it **Issues**, **Contents** and **Pull requests** read and write repository permissions. Each existing installation then has to approve the change on GitHub before those features work there; workflows keep running in the meantime.

![Screenshot of the git trigger settings after connecting GitHub, showing the repository picker, the branch field, and the "+ repos" link back to the GitHub App install flow](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/git-trigger-settings.png)

### Budget triggers

A budget trigger reads: **when budget _A_ goes over _X_%, run this workflow**. Choose the budget, the percentage of its monthly amount, and which number to compare:

- **spend so far**: what you've actually spent this month. Fires once the money is spent.
- **forecast spend**: the projected month-end total. Fires earlier, while you can still act.

Leave the percentage at `100` for a plain "went over budget". Set it lower (say `80`) to act before the limit, or above `100` to catch a serious overrun.

Budget triggers are checked each time costs are collected, so they need no schedule. Each fires **at most once per calendar month** per budget, so a workflow that shuts down a runaway cluster won't keep running every 15 minutes for the rest of the month. Changing the budget, percentage or measure re-arms it straight away. Budget alerts (SMS and push) are set up separately on the budget, and a workflow trigger doesn't need any.

The workflow gets the crossing as `infra.event`, typed for you when the trigger is set to Budget:

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

For every other trigger, `infra.event` is `{ kind: "manual" | "cron" | "git" | "api" }`, so a workflow can check how it was started.

![Screenshot of the budget trigger settings showing the budget picker, the percentage field, the spend/forecast selector, and the plain-English summary line](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/budget-trigger-settings.png)

### Sign webhook deliveries

Workflows with a git trigger also get a plain webhook URL, identified by a random token, for git providers other than the GitHub App. URLs leak easily (into access logs, proxy logs and referrer headers), so set a **signing secret** in the git trigger settings whenever you use one.

With a secret set, a delivery that can't prove it knows the secret is rejected with a 401:

- **GitHub** and compatible senders: `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the exact request body. GitHub's older SHA-1 `X-Hub-Signature` isn't accepted.
- **GitLab**: `X-Gitlab-Token` matching the secret exactly.

Paste the same value into your provider's webhook settings. The secret is write-only: once saved, the trigger shows **Signed ✓** and you can replace it, but you can't see it again. Leave it empty and the URL accepts unsigned deliveries based on the token alone.

![Git trigger row with a signing secret configured, showing the "Signed ✓" state and the Replace button](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/git-trigger-signed.png)

## Writing workflows with an AI client

[AI chat](./ai-chat.md) and [MCP](./mcp.md) can write workflows for you. "Make a workflow that shuts down the dev cluster when my Production budget goes over 90%" is a single request. Both use these tools:

| Tool                     | What it does                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_workflows`         | The org's workflows with their triggers, metrics, and last/next run.                                                                                                         |
| `get_workflow`           | One workflow, including its source, current metric values, and recent runs.                                                                                                  |
| `get_workflow_typings`   | The generated `infra.d.ts`: your real accounts, resource types, and SSH key names. Default is the fast static surface; pass `enrich:true` for precise create() field unions. |
| `check_workflow_source`  | Type-checks a draft without saving it.                                                                                                                                       |
| `write_workflow`         | Creates or updates a workflow. Type-checks first and **refuses to save** source with type errors.                                                                            |
| `run_workflow`           | Runs it now and returns the status, logs, output, and any error.                                                                                                             |
| `delete_workflow`        | Soft-deletes it (run history is kept).                                                                                                                                       |
| `list_workflow_secrets`  | Lists reusable workflow secret ids, names, and whether each has a value, never the values.                                                                                   |
| `write_workflow_secret`  | Opens a secure password prompt in Infrawrench chat; MCP can create or update metadata but cannot carry plaintext.                                                            |
| `delete_workflow_secret` | Deletes an encrypted secret and removes its workflow assignments.                                                                                                            |

A recurring check is one request too. "Check my Kubernetes clusters' pods every hour and page me if any restart count goes above 5" builds the cron workflow shown earlier, `infra.page` included, and relies on paging's built-in throttling.

**Start with `get_workflow_typings`.** The `infra` API is different for every organization (account names, resource groups, what's available inside a cluster or database), so a model writing from memory will guess wrong. Giving it your real type file first is what makes its code work against _your_ setup. The typings also reflect the trigger: budget workflows get a typed `infra.event`, and only manual workflows get `infra.prompt`.

- By default you get the fast version, where `create` fields are `Record<string, string>`. Pass `enrich:true` only when you need the exact create() fields from live provider settings; it calls provider APIs and can be slow. Over HTTP, the same choice is `GET /api/org/{orgId}/workflows/{id}/typings` (fast) or `?enrich=1`.
- For organizations with many connected providers, the tool returns the top-level `infra` types plus an index, and the model asks for the rest as needed: `typeNames: ["aws"]` gets every AWS type, or a single name like `Account_aws`. Small organizations get the whole file at once, and `scope: "full"` always returns everything.

If something isn't in the typings, it doesn't exist when the workflow runs. Use `check_workflow_source` to test a guess rather than saving and running a draft: reading a property that doesn't exist gives `undefined` instead of an error, so a run that did nothing can look like a success.

`write_workflow` runs the same type check as the editor and returns the errors (`line:column`, TypeScript error code, message) instead of saving broken code, so the model can fix its own mistakes first. Pass `skipTypecheck` to save anyway.

Workflow tools need the same `workflows:read` / `workflows:write` [permissions](../team-and-billing/roles-and-permissions.md) as the Workflows tab, and `write_workflow`, `run_workflow` and `delete_workflow` are recorded in the audit log. In chat, `run_workflow` and `delete_workflow` wait for your approval, because running a workflow executes code that can create or delete infrastructure. A `write_workflow` call that changes the source, trigger or assigned secrets, or enables the workflow, also waits for approval, since a saved cron workflow can run within a minute without anyone pressing Run.

A workflow's code runs with your account credentials. Read the source of anything you didn't write before you enable it or pass it to `run_workflow`.

## What a run is allowed to do

`workflows:write` lets you start a run. It doesn't decide what the run can do once it's going.

Every action a workflow takes is checked against the permissions of the person the run acts for, using the same permissions as the rest of Infrawrench. A workflow can't get around someone's role.

| Operation                                                   | Needs               |
| ----------------------------------------------------------- | ------------------- |
| Listing, reading, describing, logs, metrics, manifests      | `resources:read`    |
| Reading a resource output (`resolveOutput`)                 | `secrets:read`      |
| Reading assigned `infra.secrets` values                     | `secrets:read`      |
| `create()`, `update()`, applying a manifest, importing YAML | `resources:write`   |
| `delete()`                                                  | `resources:delete`  |
| `.ssh()`, `.query()`, the KV helpers, NoSQL                 | `resources:execute` |
| Object and SFTP **reads**                                   | `storage:read`      |
| Object and SFTP **writes**                                  | `storage:write`     |
| `infra.costs.write`                                         | `costs:write`       |

Reading a resource output needs `secrets:read` because an output can be a connection string or a generated password.

Logging, `infra.output`, metrics, `infra.fetch`, `infra.ai`, paging and approvals need no permission. AI spend is limited by your organization's [monthly AI cap](./ai-chat.md) instead.

Who a run acts for depends on how it started:

| Trigger                             | Acts for                                |
| ----------------------------------- | --------------------------------------- |
| Run button, debugger, HTTP, AI chat | Whoever started it                      |
| Cron schedule                       | Whoever last edited the workflow's code |
| Git push                            | Whoever last edited the workflow's code |
| Budget threshold crossing           | Whoever last edited the workflow's code |

"Last edited the code" means the last person to change what the workflow runs: its source, its trigger (including the schedule), or which secrets are assigned. That's true however they changed it: in the editor, through AI chat or MCP, over the HTTP API, with the Terraform provider's `infrawrench_workflow_schedule`, or by applying a [config-as-code](./config-as-code.md) document. Renaming a workflow, editing its description or turning it on and off doesn't change who it runs as.

So if you edit a colleague's scheduled workflow, its scheduled runs use **your** permissions from then on. A member can't borrow an admin's access by rewriting the admin's workflow: the rewritten code runs as the member. Editing a workflow with assigned secrets also needs `secrets:read`, because its runs will load those secrets on your behalf.

If the last editor has left the organization, the workflow can't do anything that needs permissions, and its next run fails at the first such step. If you inherit one, change its code or trigger under your own account, or ask an owner to.

A refused action throws inside the workflow and names the permission it needed. Catch it like any other error, or read it from the failed run and ask an admin for the right role.

## The sandbox

Workflow code runs in an isolated sandbox with a memory limit and a time limit, and no direct access to files or the network. It can only do what `infra` and `fetch` allow, and those actions use your account credentials without ever exposing them to the script. Workflows behave the same on the desktop and in the cloud, except that cloud `fetch` can only reach the public internet.

## Debugging

A **manual run from the editor is a debug run**. As it runs, the editor **highlights the current line**, so you can watch a workflow step through `create → waitUntilReachable → ssh → delete` live.

**Breakpoints.** Click the left margin next to a line to set a breakpoint (a red dot). The run **pauses** before that line, and the toolbar shows:

- **Resume**: continue to the next breakpoint.
- **Step**: run the current line, then pause on the next one.
- **Stop**: end the run.

You can add or remove breakpoints while paused. Time paused at a breakpoint (and waiting on `infra.prompt`, SSH or `waitUntilReachable`) doesn't count against the run's time limit.

![Screenshot of the Workflows editor mid-run: a line highlighted as the current line, a red breakpoint dot in the gutter, and Resume/Step/Stop buttons in the toolbar](https://agent-assets.infrawrench.com/docs-screenshots/features/workflows/editor-debug-paused.png)

Debugging works on the desktop and web apps. Very tight loops run a little slower while the editor is highlighting them; cron and git runs are never slowed this way. Breakpoints only stop on top-level lines, not lines inside a function or callback.

## Run history

Every run records its status, logs, output, timings and any error. The **Run history** section at the bottom of the workflow's page lists them newest first, so you can see what a cron has been doing.

Each row shows the status (`success`, `failure`, `running`, `pending`, `canceled`), when it started, how long it took, and what started it: Manual, Schedule, Git push, API or Budget. Click **Logs** on a row to expand that run's log lines (coloured by level), its error if it failed, and its output.

A run that's still going shows **in progress** instead of a duration. The run you just started from the editor isn't listed twice: its row says _streaming above_ while the live log is following it, and _shown above_ once it's finished.

The header shows the number of runs. The list shows the ten most recent, with a **Show N more** button for the rest. History keeps the **latest 50 runs**; older ones drop off.

The mobile app's workflow screen shows the same history (tap a run to see its logs), and `GET /api/org/:orgId/workflows/:id/runs` returns the same rows if you'd rather read them from a script.

<insert [Screenshot of a workflow's run history list with statuses and durations, one run expanded to show logs] here>
