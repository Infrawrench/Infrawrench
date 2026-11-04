---
title: Infrafile
description: One file at your repo root that describes how your project is built and deployed, with its environments, an interactive plan, a Dockerfile and a deploy script.
sidebar_order: 9
---

An **Infrafile** is a single TypeScript file at the root of your repository that
describes how the project gets built and shipped. It lists the environments you
can deploy to, asks you anything it needs to know, renders a Dockerfile, and
then deploys. You watch it all happen in one run.

It isn't a workflow. It has no trigger, and Infrawrench never stores it. It is
read fresh from your repository every time it runs: the CLI reads it from disk,
and the web app pulls it from git.

```ts
defineInfra({
  envs: ["staging", "production"],

  async plan({ env, git, select }) {
    return {
      tag: `${env}-${git.sha.slice(0, 7)}`,
      replicas: env === "production" ? 3 : 1,
    };
  },

  dockerfile({ env, plan }) {
    return `FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci ${env === "production" ? "--omit=dev" : ""}
CMD ["node", "server.js"]`;
  },

  async deploy({ env, plan, image, push, notes }) {
    await push(image);
    const cluster = infra.accounts.kubernetes.getByName("prod");
    await cluster.importYaml(manifestFor(env, image, plan.replicas));
    await notes(`deployed ${image}, ${plan.replicas} replicas`);
  },
});
```

## The three stages

**`plan(ctx)`** runs first. It can use the full `infra` surface (every account,
resource and output a [workflow](./workflows.md) can reach) plus `select` and
`git`. Whatever it returns is passed to the later stages as `plan`.

**`dockerfile(ctx)`** is pure: no `await`, no `infra`. It takes the environment
and the plan and returns Dockerfile text. To vary it by environment, use an
`if`.

**`deploy(ctx)`** runs after the image is built, again with the full `infra`
surface. Applying a Kubernetes manifest, writing a DNS record or SSHing to a box
are all ordinary calls.

There is also an optional fourth stage, **`destroy(ctx)`**, which tears a
deploy down instead. See [Tearing down](#tearing-down).

## Ask the user to pick something with `select`

```ts
const host = await select("build-host", "Build on", await droplets.list());
```

The first argument is a **key**, and it is what makes a deploy scriptable. Pass
`--set build-host=web-01` and the choice is answered with no prompt, so the same
Infrafile runs unattended in CI. If a non-interactive run has no answer for a
key, the deploy fails and tells you which key it needed.

`select` returns the item you picked, not a label, so selecting a resource gives
you a resource you can use.

## Ask for anything else with `ask`

`select` covers "pick one of these". `ask` covers everything else: a version
string, a replica count, a date, a yes or no:

```ts
async plan({ ask }) {
  const tag      = await ask("tag", "Image tag", { pattern: "^v[0-9]" });
  const replicas = await ask("replicas", "Replicas", { kind: "number", min: 1, max: 20, default: 2 });
  const when     = await ask("cutover", "Cut over on", { kind: "date" });
  const drain    = await ask("drain", "Drain connections first?", { kind: "boolean" });
  return { tag, replicas, when, drain };
}
```

Kinds are `text` (the default), `password`, `number`, `date` and `boolean`.
Answers come back **already typed**: a `number` is a number and a `date` is an
ISO `YYYY-MM-DD` string, so there's nothing to parse.

It uses the same keys as `select`. `--set replicas=4` answers it with no
prompt, and a trigger's stored answers do the same for a deploy nobody is
watching.

Answers are validated even when they come from `--set`. `--set replicas=lots`
fails and names the key instead of deploying nothing:

```
ask("replicas"): "lots" is not a number.
```

`min` and `max` bound numbers and dates, `pattern` constrains text, and
`required: false` allows an empty answer. A `default` fills in a blank one.

## Two reserved keys

Everything `plan()` returns is yours, except two keys Infrawrench reads:

- **`buildOn`**: where to build. An SSH-reachable resource, or the string
  `"local"` to use the Docker daemon on the machine running the deploy.
- **`registry`**: `{ host, username, password }`, used for `docker login`
  before a push. It is never written to the run log.

`tag` and `buildArgs` are also used when present.

## Use the image as a build environment

Plenty of targets aren't containers. A Cloudflare Worker, a static site or a
Lambda bundle doesn't want your image _deployed_. It wants a reproducible
environment to publish _from_.

So build a toolchain image and run commands inside it. `run(command)` runs in
the image that was just built, with your project mounted at `/workspace`, and
returns the command's stdout:

```ts
defineInfra({
  envs: ["production"],

  async plan({ env }) {
    return { tag: env };
  },

  // The image is never pushed anywhere. It exists to hold wrangler.
  dockerfile() {
    return `FROM node:22-slim
WORKDIR /workspace
RUN npm install -g wrangler`;
  },

  async deploy({ run, notes }) {
    const token = await infra.accounts.cloudflare
      .getByName("main")
      .workers.get("my-worker")
      .resolveOutput("apiToken");

    const out = await run("wrangler deploy", {
      env: { CLOUDFLARE_API_TOKEN: token },
    });
    await notes(out.trim());
  },
});
```

`run` takes any command, so pre-deploy steps are just earlier calls:

```ts
async deploy({ run, image, push, notes }) {
  const url = await infra.accounts.neon.getByName("main")
    .databases.get("app").resolveOutput("connectionString");

  await run("npm run db:migrate", { env: { DATABASE_URL: url } });
  await push(image);
  await notes("migrated and shipped");
}
```

They run in order, and a failure stops the deploy, so a broken migration means
nothing gets shipped.

A non-zero exit fails the deploy and shows the end of stderr. Pass
`{ allowFailure: true }` to handle failures yourself, and you get
`{ exitCode, stdout, stderr }` back instead of stdout.

Anything in `env` never appears in the run log or in the machine's process
list, so it's safe to put credentials there. Don't put them into the command
string.

On a web deploy, `run()` also has your project mounted at `/workspace`. Each
call is a separate build, so combine steps with `&&` when speed matters.

Commands run through `sh` by default, so `&&`, pipes and `npm run` scripts all
work, even if your Dockerfile sets its own `ENTRYPOINT`. Pass `entrypoint` to
use a different binary, or `""` to clear it. On a web deploy, only a shell
entrypoint (`sh`, `bash`) returns the command's output; any other returns its
exit code with empty `stdout` and `stderr`.

Other options: `workdir` (defaults to `/workspace`), `mountSource: false` for an
image that already contains everything, and `image` to run something other than
the image just built.

![A deploy run in the web app mid-build, showing the stage indicator on "build" and Docker build output streaming into the live log panel](https://agent-assets.infrawrench.com/docs-screenshots/features/infrafile/deploy-mid-build-docker.png)

## Deploy from the CLI

```
infrawrench deploy                      # one env declared? just go
infrawrench deploy --env production
infrawrench deploy --plan               # dry run: planned changes, plan and Dockerfile, nothing is touched
infrawrench deploy --env staging --set build-host=local --json
infrawrench deploy destroy -e staging   # run the destroy() stage to tear the env down
```

The CLI finds `./Infrafile` (looking up to your repo root), builds with your
**local Docker daemon** so you get your warm layer cache and need no VM, and
prompts in the terminal for anything `select` asks about.

`infra.accounts` combines your **local workspace's accounts with your
organization's cloud accounts**. You choose the scope before the run starts:

- At a terminal, the CLI asks once: "local + org, or local only?"
- `--org <id|name>` or `--local` answers it up front.
- Non-interactive runs default to local plus your default org.

Cloud accounts support listing, outputs, create and delete. Anything that needs
a live connection from your machine (SSH, storage, SQL) still needs a local
account.

Because the build is local, the CLI can deploy a working tree with uncommitted
changes. It tells you when it spots them.

### Preview with `--plan`

`--plan` is the safe first move, and it is a true dry run. Creates, updates and
deletes made through `infra.accounts` are caught and nothing touches your
providers. Each one is listed as a planned change, with `+`, `~` and `-` lines
and an "N to create, M to update, K to delete" summary, next to the plan itself
and the rendered Dockerfile.

A planned create returns a stand-in resource whose id starts with `planned:`,
and any output you read from it is the string `(known after apply)`. So a plan
that passes a new database's connection string into later steps still runs to
the end. The one thing you can't do with a stand-in is wait for it to be ready.
`plan()` gets a `dryRun: boolean` on its context, so skip readiness waits (like
polling until a branch or endpoint appears) when `ctx.dryRun` is true.

`--plan` also shows how the new plan differs from the one used by this
environment's last successful deploy: top-level keys marked `+`, `-` or `~`,
with secret-looking values hidden. If there's no previous successful deploy,
there's nothing to compare.

## Deploy from the desktop app

Open **Deploy** in the sidebar. What you see depends on the org switcher:

- **With an organization selected**, it's the web app's Deploy screen: the same
  repository and environment pickers, plan then deploy, live build output,
  deploy-on-push triggers and rollbacks, using the same hosted builds.
- **In local mode**, it's the history of what `infrawrench deploy` did on this
  machine: when each run happened, the environment and project directory, the
  commit (flagged if the tree had uncommitted changes), the image it produced,
  how far a failed run got, and how long it took. Expand a run to see its notes
  and the error that stopped it.

Local deploys still start from the terminal, because they need your working
tree and your own Docker daemon. The app is where you look afterwards.

Runs on this machine are kept locally whether or not they were also reported to
an organization, so even a `--local` deploy leaves a record. You can see the
same list with `infrawrench deploy log --local`.

<insert [The desktop app's Deploy tab in local mode, showing a table of past `infrawrench deploy` runs with one failed run expanded to reveal its error] here>

## Deploy from the web app

### Who can deploy

There are three permissions, because previewing and shipping are different
risks:

| Permission          | Grants                                          | Default for    |
| ------------------- | ----------------------------------------------- | -------------- |
| `deployments:read`  | Deploy history, and a repo's declared envs      | Members        |
| `deployments:plan`  | Running `plan()`, code execution, ships nothing | Members        |
| `deployments:write` | Building, deploying, rolling back               | Admins, owners |

`plan` is separate from `read` because running `plan()` runs the repository's
Infrafile against your organization's accounts. It doesn't change your
infrastructure, but it is still code running. Members get it so they can see
what a deploy would do, and a custom role can take it away while keeping the
history.

### Plans

The Deploy page in the web app needs a **paid plan** (or complimentary access).
On the free tier, the page shows what the feature includes and an upgrade link
instead. `infrawrench deploy` from the CLI builds on your own machine and works
on any tier.

If your subscription lapses, the message says so and points to
**Settings > Billing**. A payment that is only _retrying_ (`past_due`) does not
block deploys.

### Run a deploy

1. Open **Deploy** in the sidebar.
2. Pick the repository and branch.
3. Load the Infrafile to fill in the environment list.
4. Click **Plan**, then **Deploy**.

The same three stages run on Infrawrench's side.

### Hosted builds

You don't need a build machine: your paid plan includes the build. Infrawrench
builds your repository at the chosen commit, using the Dockerfile your
Infrafile rendered, in an isolated build environment, and pushes the image to
the registry your `plan()` returned. Because it's _your_ registry, your cluster
can pull the image with credentials it already has.

Builds are capped at 20 minutes and metered, so a runaway `RUN` stops on its
own.

A hosted build is quiet while it runs. The log shows `Uploading source (12.4 MB)`,
then `Building <image> on Cloud Build`, then nothing until `Built <image> in 84s`
appears. There's no `Step 3/9` to watch. If it fails, the message names the
build id so you can read the full log in Google Cloud Build. Hosted `run()`
steps do show their output, but all at once when the step ends.

Set `buildOn` to a resource if you'd rather build somewhere specific, such as a
machine with a warm layer cache or one inside a private network. It's optional,
and it's also how to watch a build live: that path streams every line of
`docker build` and `docker push` into the log.

![The Deploy screen mid-build with the stage indicator on "build", showing the "Uploading source" and "Building … on Cloud Build" lines in the live log panel while the hosted build runs](https://agent-assets.infrawrench.com/docs-screenshots/features/infrafile/deploy-mid-build-hosted.png)

## Deploy on push

In the Deploy screen, add a trigger: _when `owner/repo` `main` moves, deploy
`production`_. Infrawrench notices within 30 seconds and deploys the commit
that moved it.

Two things to know:

- **Adding a trigger doesn't deploy right away.** It notes where the branch is
  and fires on the _next_ push, so saving a trigger never ships whatever
  happened to be at HEAD.
- **A triggered deploy has nobody to ask.** Every `select(...)` in your
  Infrafile must have an answer saved on the trigger, the same way `--set`
  answers it in CI. A key without an answer fails the run and names the key.

The environment is checked against your Infrafile when you create the trigger,
so a typo is caught then instead of the trigger silently never firing.

## Share a deploy link

`https://app.infrawrench.com/deploy/github.com/owner/name` opens the Deploy
screen with that repository already selected. Handy in a README, a runbook or a
chat message.

The link accepts what people actually paste: a full `https://` URL, a bare
`owner/name`, a `.git` suffix, a trailing slash. If you belong to one
organization it goes straight there. If you belong to several, it asks which
one and keeps the repository selected either way.

If that organization's GitHub App can't see the repository, the screen tells
you so.

## Set up your editor

`Infrafile` has no extension on purpose, like `Dockerfile` or `Makefile`. To
get types and autocomplete, tell your editor it's TypeScript and save the
generated declarations next to it:

```
infrawrench deploy typings > Infrafile.d.ts
```

In VS Code:

```json
{ "files.associations": { "Infrafile": "typescript" } }
```

The declarations are generated from _your_ connected accounts, just like a
workflow's, so `infra.accounts.` autocompletes with your real account names.

Keep the file extensionless. If you name it `Infrafile.ts`, TypeScript ignores
`Infrafile.d.ts` and you get "Cannot find name 'defineInfra'" with no obvious
reason why.

## Roll back

A rollback ships a previous deploy's **exact image** again. It doesn't rebuild:

```
infrawrench deploy rollback --env production
infrawrench deploy rollback --to-run <runId>
```

In the web app, use the **Roll back** button on any successful row in the
history.

Without `--to-run`, the CLI picks the last successful deploy _before_ the one
that's live now, which is usually what "roll back" means. Name a run to go
further back.

During a rollback, the Infrafile is read at the commit that run deployed (not
the branch head), and its `deploy()` runs with the plan and image that run
recorded. `plan()`, `dockerfile()` and the build are all skipped, so you get
exactly the bytes that were known to work.

Two things to know:

- `plan` arrives as the **recorded JSON**, so anything in it that was a
  resource is now plain data. If `deploy()` needs live resources, get them from
  `infra.*`, which works normally.
- You can only roll back to a successful run that produced an image. A CLI run
  from a directory with no git remote has no repository recorded, so the web
  app can't roll back to it.

`run(...)` still works during a rollback and uses the recorded image, so a
`npm run db:rollback` step gets the same toolchain the original deploy used.

### Undo what a deploy created

Every run keeps a record of the resources it created through
`infra.accounts.*.create(...)`. If your Infrafile spun up a database or a
cluster, that's recorded. A plain rollback never touches those resources: it
re-ships the image and nothing else.

To also undo the provisioning, pass `--delete-created`:

```
infrawrench deploy rollback -e production --to-run <runId> --delete-created
```

Once the known-good image is confirmed live, every resource created by runs
**after** the target is deleted, newest run first and children before their
parents. The target run's own resources are kept, and so is anything the
rollback's own `deploy()` just created. Deletions are best-effort and listed in
the run's notes: a resource someone already removed by hand is noted, not
fatal.

This is opt-in because a database created by a bad deploy may still hold data
written since. Use `--delete-created` when the deploy's provisioning was the
mistake, not as a routine part of rolling back.

## Tearing down

An Infrafile can declare a `destroy(ctx)` stage, the opposite of `deploy()`:

```ts
async destroy({ env, git, notes }) {
  const namespace = git.pullRequest ? `app-pr-${git.pullRequest.number}` : `app-${env}`;
  // delete the namespace, the DNS record, the preview database…
  await notes(`tore down ${namespace}`);
}
```

Run it from the CLI:

```
infrawrench deploy destroy -e staging
```

At a terminal, the CLI asks once before going ahead. Non-interactive runs (like
CI tearing down a preview when its pull request closes) go ahead without
asking.

`destroy` gets **no image and never prompts**, because by the time a preview
closes its image is usually gone and nobody is at a terminal. It does get
`plan`: the **recorded plan from the env's last successful deploy**, when there
is one. So if `env` and `git` can't settle a choice (which account, which
region), have the deploy write it into the plan and read it back here:

```ts
async destroy({ env, plan, notes }) {
  const account = infra.accounts.neon
    .list()
    .find((a) => a.displayName === plan?.neonAccount);
  // …
}
```

Treat `plan` as possibly missing, since a teardown can outlive its deploy
history, and fall back to naming things by `env` and `git`. It arrives as
recorded JSON (plain data, so get live resources from `infra.*` as usual).
`destroy` has the full `infra` surface, so deleting resources, applying
manifests and SSHing all work, and the run shows up in the deploy history with
the stage `destroy`.

If your Infrafile has a `"preview"` environment, always declare `destroy`.
Without it, a closed pull request leaves its environment running forever, and
the only sign is the bill.

### Tear down from the record of what was created

`destroy()` works out what to delete from `env` and `git`. The other option is
to delete exactly what the record says was created:

```
infrawrench deploy destroy --created -e staging
```

Instead of running `destroy()`, this reads the environment's recorded runs and
deletes every resource they created, newest run first and children before their
parents, the same order `rollback --delete-created` uses. Deletions are
best-effort, with a `✓` or `!` line per resource, so something already removed
by hand is noted rather than fatal. `--created` needs an explicit `-e`, since
it's too sweeping to aim at a default environment.

If your Infrafile has no `destroy()` stage, a plain `deploy destroy` points you
to `--created`, which needs no stage at all.

## Record outputs

`notes()` records text for people. `infra.output(...)` records structured
values for scripts. Call it from `deploy()` with whatever a script will want
later, and the value is saved on the run:

```ts
async deploy({ env, plan, image, push, notes }) {
  await push(image);
  const ip = await applyManifestAndWait(env, plan, image);
  await notes(`deployed ${image} behind ${ip}`);
  await infra.output({ url: `http://${ip}`, image });
}
```

`infra.output` works the same way it does in [workflows](./workflows.md), and
the value is saved on the deploy's record. Read it back with:

```
infrawrench deploy outputs -e staging
infrawrench deploy outputs -e staging --json
```

This prints the latest **successful** deploy's output as JSON: the service URL,
the load balancer IP, whatever `deploy()` recorded. Use `--json` for scripting;
a smoke test is one `jq '.url'` away. For text like "migrated and shipped", use
`notes()`. `infra.output` is for values another program reads.

## Check for drift

Every run records the resources it created (the same record `--delete-created`
and `destroy --created` use). `deploy status` checks that record against what
actually exists:

```
infrawrench deploy status -e staging
infrawrench deploy status -e staging --json
```

Each resource is reported as **ok** (still exists), **missing** (someone
deleted it at the provider), or **unknown** (the check couldn't finish),
followed by a summary. From the CLI, the report covers what _this machine_
deployed.

## What a deploy records

The Infrafile itself is never stored, on your machine or in your organization.
It's read from your repository on every run and then discarded.

What is stored is the record of each run: env, commit, image, logs, the plan as
JSON, the rendered Dockerfile, notes, the output saved with `infra.output(...)`,
and the list of resources it created that `--delete-created` reads.

The web app streams a run's logs live and shows the plan and rendered
Dockerfile before anything is built.

### Stop a run

**Stop** sits next to Deploy while a run is in progress, in the web app and in
the desktop app's Deploy tab. It asks the run to stop rather than killing it:
the run stops at its next checkpoint, and a `select(...)` still waiting for an
answer is cancelled. You can click it before the connection is up; the request
is sent as soon as the run is reachable. The button reads "Stopping…" until the
run ends.

A stopped run is recorded like any other unsuccessful one. It shows in the
history as failed, at the stage it reached, with the reason. Anything it had
already created stays in place and stays on that run's record, so
`destroy --created` can clean it up.

## See what a deploy cost

Every successful run has a **Cost impact** button in the history. It shows what
the deploy did to your run rate, broken down by the resources it created, using
the provider's own billing from before and after. A run that only re-shipped an
image has no resources to link to and says so, rather than blaming something
else that changed in the same hour.

See [Cost per change & cost per deploy](./cost-per-change.md) for how the
comparison works, what "unknown" means (it is never "$0"), and why the figure
keeps moving as provider billing arrives.

## Ask an AI client about a deploy

The [AI chat](./ai-chat.md) and the [MCP server](./mcp.md) share a small set of
deployment tools:

- `list_deployments` and `get_deployment`: the history, and one run in full
  (logs, plan, rendered Dockerfile, error).
- `list_deployable_repos`: what your GitHub App can see.
- `plan_deployment`: runs a repo's `plan()` and renders its Dockerfile without
  building anything.
- `rollback_deployment`.

There is deliberately **no tool that deploys**. Shipping a release lands on real
infrastructure, so a person starts it, from the Deploy tab or
`infrawrench deploy`. An AI client gets everything it needs to reason about a
deploy ("why did last night's staging deploy fail?", "what would deploying this
branch do?") plus rollback, which makes things safer.

`plan_deployment` counts as a **destructive tool** in chat even though it
builds nothing, because your `plan()` is code that can create or delete
resources. It waits for your approval, as does `rollback_deployment`. Both are
audit-logged. They need the `deployments:plan` and `deployments:write`
[permissions](../team-and-billing/roles-and-permissions.md) respectively; the
read tools need `deployments:read`.

`plan_deployment` can't answer a `select(...)` prompt, so pass the choices up
front as `answers`, using the same keys the Infrafile uses.

## See also

- [Workflows](./workflows.md): the same `infra` surface, on a trigger
- [CLI](./cli.md): the rest of the terminal tool
- [AI chat](./ai-chat.md): asking about deploys, and rolling one back
- [Cost per change & cost per deploy](./cost-per-change.md): what a run did to the bill
