---
title: Infrafile
description: One file at your repo root that describes how your project is built and deployed — the environments it supports, an interactive plan, a Dockerfile, and a deploy script.
sidebar_order: 9
---

An **Infrafile** is a single TypeScript file at the root of your repository that
describes how that project gets built and shipped. It declares the environments
you can deploy to, asks you anything it needs to know, renders a Dockerfile, and
then deploys — all in one run you can watch.

It is not a workflow. It has no trigger, it is never stored in Infrawrench, and
it is read fresh from your repository every single time it runs. The CLI reads
it from disk; the web app pulls it from git.

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
    await notes(`deployed ${image} — ${plan.replicas} replicas`);
  },
});
```

## The three stages

**`plan(ctx)`** runs first. It has the full `infra` surface — every account,
resource and output a [workflow](./workflows.md) can reach — plus `select` and
`git`. Whatever it returns is handed to the later stages as `plan`.

**`dockerfile(ctx)`** is pure: no `await`, no `infra`. It takes the environment
and the plan and returns Dockerfile text. Splitting by environment is just an
`if`.

**`deploy(ctx)`** runs after the image is built, with the full `infra` surface
again. Applying a Kubernetes manifest, writing a DNS record, SSHing to a box —
all ordinary calls.

## Asking questions with `select`

```ts
const host = await select("build-host", "Build on", await droplets.list());
```

The first argument is a **key**, and it is what makes a deploy scriptable. Pass
`--set build-host=web-01` and the choice resolves with no prompt, so the same
Infrafile runs unattended in CI. Without an answer in a non-interactive run the
deploy fails and tells you which key it needed.

`select` returns the item you picked, not a label — so selecting a resource
gives you back a usable resource.

## Two reserved keys

Everything `plan()` returns is yours except two keys the host reads:

- **`buildOn`** — where to build. An SSH-reachable resource, or the string
  `"local"` to use the Docker daemon on the machine running the deploy.
- **`registry`** — `{ host, username, password }`, used for `docker login`
  before a push. It is never written to the run log.

`tag` and `buildArgs` are honoured when present.

## When the image is a build environment, not the artifact

Plenty of targets aren't containers. A Cloudflare Worker, a static site, a
Lambda bundle — none of them want your image _deployed_. They want a
reproducible environment to be published _from_.

So build a toolchain and run inside it. `run(command)` executes in the image
that was just built, with your project mounted at `/workspace`, and resolves
with the command's stdout:

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

They run in order, and because a failure stops the deploy, a broken migration
means nothing gets shipped.

A non-zero exit fails the deploy and surfaces the tail of stderr — a failed
`wrangler deploy` should stop the run, not scroll past. Pass
`{ allowFailure: true }` to handle it yourself, and you get
`{ exitCode, stdout, stderr }` back instead of stdout.

Anything in `env` is passed to the container out of band and never appears in
the run log or in the machine's process list, so credentials are safe to put
there. Do not interpolate them into the command string.

Commands run through `sh` by default, so `&&`, pipes and `npm run` scripts all
behave. That entrypoint is set explicitly rather than inherited from the image —
a container's arguments are appended to whatever `ENTRYPOINT` the Dockerfile
declared, so an image that sets one would otherwise mangle every command. Pass
`entrypoint` to use a different binary, or `""` to clear it.

Other options: `workdir` (defaults to `/workspace`), `mountSource: false` for an
image that already carries everything, and `image` to run something other than
the one just built.

<insert [A deploy run in the web app mid-build, showing the stage indicator on "build" and Docker build output streaming into the live log panel] here>

## Deploying from the CLI

```
infrawrench deploy                      # one env declared? just go
infrawrench deploy --env production
infrawrench deploy --plan               # show the plan and Dockerfile, build nothing
infrawrench deploy --env staging --set build-host=local --json
```

The CLI reads `./Infrafile` (walking up to your repo root), builds with your
**local Docker daemon** so you get your warm layer cache and need no VM, and
prompts in the terminal for anything `select` asks about.

`--plan` is the safe first move: it runs `plan()`, prints what it decided and
the Dockerfile it rendered, and stops before building anything.

Because the build is local, the CLI can deploy a working tree with uncommitted
changes — it will tell you when it spots them.

## Deploying from the web app

### Who can deploy

Three permissions, because previewing and shipping are different risks:

| Permission          | Grants                                           | Default for    |
| ------------------- | ------------------------------------------------ | -------------- |
| `deployments:read`  | Deploy history, and a repo's declared envs       | Members        |
| `deployments:plan`  | Running `plan()` — code execution, ships nothing | Members        |
| `deployments:write` | Building, deploying, rolling back                | Admins, owners |

`plan` is separate from `read` because running `plan()` evaluates the
repository's Infrafile against your organization's accounts — inert as far as
your infrastructure goes, but still code execution. Members get it so they can
see what a deploy would do; a custom role can withhold it without also taking
away the history.

### Plans

Deploying from the web app needs a **paid plan** (or complimentary access).
Previewing does not — you can Plan a repository on the free tier and see exactly
what a deploy would do before deciding. `infrawrench deploy` from the CLI builds
on your own machine and is not gated.

If a subscription lapses the message says so and points at Settings → Billing. A
payment that is merely _retrying_ (`past_due`) does not block deploys — losing
the ability to ship should follow a cancellation, not a bounced card.

Open **Deploy** in the sidebar. Pick the repository and branch, load the
Infrafile to populate the environment list, then Plan and Deploy. The same three
stages run server-side. There is no working tree in the browser, so the build host
clones your repository at the chosen commit and builds there — which is why
`plan()` needs to return a `buildOn` resource when you deploy from the web.

## Deploy links

`https://app.infrawrench.com/deploy/github.com/owner/name` opens the deploy
screen with that repository already selected — handy in a README, a runbook, or
a chat message.

The link tolerates what people actually paste: a full `https://` URL, a bare
`owner/name`, a `.git` suffix, a trailing slash. If you belong to one
organization it goes straight there; if you belong to several it asks which one,
carrying the repository through either way.

If that organization's GitHub App cannot see the repository, the screen says so
rather than presenting a repo no deploy could read.

## Editor support

`Infrafile` has no extension on purpose — it is a well-known filename like
`Dockerfile` or `Makefile`. To get types and autocomplete, tell your editor it
is TypeScript and drop the generated declarations next to it:

```
infrawrench deploy typings > Infrafile.d.ts
```

In VS Code:

```json
{ "files.associations": { "Infrafile": "typescript" } }
```

The declarations are generated from _your_ connected accounts, exactly like the
ones a workflow gets, so `infra.accounts.` autocompletes with real account
names.

## Rolling back

A rollback ships a previous deploy's **exact image** again. It does not rebuild:

```
infrawrench deploy rollback --env production
infrawrench deploy rollback --to-run <runId>
```

or the **Roll back** button on any successful row in the web app's history.

With no `--to-run`, the CLI picks the last successful deploy _before_ the one
currently live — which is what "roll back" usually means. Naming a run is how
you go further back.

What actually happens: the Infrafile is re-read at the commit that run deployed
— not at the branch head, so you get the deploy logic that shipped alongside
those bytes — and its `deploy()` runs with the plan and image the run recorded.
`plan()`, `dockerfile()` and the build are all skipped. The point of rolling
back is to get the bytes that were known good, not to reconstruct something that
ought to resemble them.

Two consequences worth knowing:

- `plan` arrives as the **recorded JSON**, so anything in it that was a resource
  is now plain data rather than a live handle. A `deploy()` that needs handles
  should take them from `infra.*`, which works normally.
- Only a successful run that produced an image can be rolled back to. A CLI run
  from a directory with no git remote has no repository recorded, so the web app
  cannot re-read its Infrafile.

`run(...)` still works during a rollback and targets the recorded image, so a
`npm run db:rollback` step reaches the same toolchain the deploy originally used.

## What a deploy records

The Infrafile itself is never stored — not on your machine's behalf, not in your
organization. It is read from your repository on every run and discarded.

The web app streams a run's logs live and shows the plan and rendered Dockerfile
before anything is built.

## See also

- [Workflows](./workflows.md) — the same `infra` surface, on a trigger
- [CLI](./cli.md) — the rest of the terminal tool
