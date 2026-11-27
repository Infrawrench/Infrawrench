# @infrawrench/git-worker

The Cloudflare Worker behind git.infrawrench.com (`infrawrench-git`): the JSON API, sign-in, Git over HTTPS and SSH, one Durable Object per repository, the push event consumer, and the built UI as static assets. `git/README.md` is the design, `NOTES.md` and `NOTES-ci.md` the decisions per area, and this file is what the Worker is configured with.

```sh
node git/dev.mjs                                        # the whole forge locally (git/README.md, "Local development")
pnpm --filter @infrawrench/git-worker typecheck
pnpm --filter @infrawrench/git-worker test              # needs git; GIT_WORKER_E2E=1 adds the workerd suites (needs ssh)
DATABASE_URL=postgres://... pnpm --filter @infrawrench/git-worker test:db   # a migrated scratch Postgres
pnpm --filter @infrawrench/git-worker bundle            # what a deploy would upload, uploading nothing
pnpm --filter @infrawrench/git-worker check:startup     # the bundle's start-up profile
```

Deploys are `.github/workflows/git-deploy.yml`, on pushes to `main` that touch the forge or what it bundles. Infrawrench CI runs the tests (`.infrawrench/ci/git.yml`). Provisioning is `infra/README.md` ("git.infrawrench.com") and `infra/git/setup.mjs`.

## Bindings (`wrangler.jsonc`)

| Binding           | What                                                                                                                                                                                                        | Made by                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `HYPERDRIVE`      | The app's Hyperdrive, in front of the app's Postgres. The forge's tables are in it.                                                                                                                         | The app (`infra/README.md`, "Cloudflare edge").                   |
| `OBJECTS`         | R2 bucket `infrawrench-git`: packs and their indexes, Terraform state versions.                                                                                                                             | `setup.mjs bucket`                                                |
| `REPO`            | Durable Object namespace, class `RepoDO`, one object per repository.                                                                                                                                        | The deploy (migration `v1`).                                      |
| `TERRAFORM_STATE` | Durable Object namespace, class `TerraformStateDO`, one object per Terraform workspace.                                                                                                                     | The deploy (migration `v2`).                                      |
| `RL_*`            | Six Rate Limiting bindings (`ratelimits`): cheap reads, heavy reads and writes, each for callers without a credential (`_ANON`, by address) and for callers who authenticated (`_SIGNED_IN`, by principal). | Nothing: a `namespace_id` is a number chosen in `wrangler.jsonc`. |
| `EVENTS`          | Queue `infrawrench-git-events`, produced by `RepoDO` and consumed by this Worker.                                                                                                                           | `setup.mjs queues`                                                |
|                   | Dead letter queue `infrawrench-git-events-dlq`: a push event that failed five deliveries.                                                                                                                   | `setup.mjs queues`                                                |
| `ASSETS`          | `../web/dist`, the built UI. The Worker runs first for every request.                                                                                                                                       | `vite build`, in the deploy.                                      |
| `connect`         | TCP port 8788 under `wrangler dev`. In production port 22 arrives through Spectrum.                                                                                                                         | `setup.mjs spectrum`                                              |

The rate limits are counted per Cloudflare location and are approximate; their limits are `DEFAULT_RATE_BUDGETS` in `src/http/rate-limit.ts`, which a test holds the bindings to. Without the bindings (local development, the tests) the same budgets are counted in the data centre's cache.

Two settings there are about what the site exposes, and a test holds both: `preview_urls` is off beside `workers_dev`, so no `*.workers.dev` URL is a second origin, and `observability.redact_query_string` keeps query strings out of Workers Logs, since the archive route takes a job token in its query.

## Cron trigger

`triggers.crons` runs the Worker's `scheduled` handler every hour (`17 * * * *`): the commits of versions of branches merged or deleted thirty days ago stop being kept (`src/review/prune.ts`; the versions' rows stay). Wrangler deploys the trigger with the Worker; nothing in `infra/git/setup.mjs` makes it.

## Variables (`vars` in `wrangler.jsonc`)

| Variable              | Value in production           | What it is                                                                                                                                                                                             | Without it                                             |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `SITE_ORIGIN`         | `https://git.infrawrench.com` | This site's origin: the WorkOS redirect URI, HTTPS clone URLs, the origin a write must come from.                                                                                                      | Falls back to the same value.                          |
| `SSH_HOST`            | `git.infrawrench.com`         | The host in SSH clone URLs, and the name `setup.mjs spectrum` creates the port 22 application under. `host:port` (local development) makes the URLs `ssh://` ones.                                     | The site's host.                                       |
| `SSH_ENABLED`         | `false`                       | `"false"` turns Git over SSH off: repositories have no SSH clone URL, the SSH key and deploy key pages say SSH is off, and an inbound connection is closed unread. Off until Spectrum carries port 22. | On.                                                    |
| `APP_ORIGIN`          | `https://app.infrawrench.com` | The Infrawrench app, for links back.                                                                                                                                                                   | Falls back to the same value.                          |
| `WORKOS_API_HOSTNAME` | `auth-api.infrawrench.com`    | WorkOS's API host (the app's custom Authentication API domain). With a port it is reached over plain HTTP, which is how local development points at the emulator.                                      | `api.workos.com`, which a custom domain stops serving. |
| `GIT_BASE_URL`        | unset                         | Read by server-core's CI: where runners clone a repository here from, and what a run's commit links open. Set it only for a forge on another host.                                                     | `https://git.infrawrench.com`.                         |

`define` in `wrangler.jsonc` is not configuration but part of the build: `globalThis.__INFRAWRENCH_EDGE_PLUGINS__` says the bundle has no plugin code, which is what lets server-core drop the code that would need it (below).

## Secrets

Six are required: `wrangler deploy` refuses without them (`secrets.required`), and so does `wrangler dev` (it reads `.dev.vars`, which `git/dev.mjs` writes).

| Secret                   | What it is                                                                                                                                    | Where it comes from                                    | Without it, or with a wrong one                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKOS_API_KEY`         | The app's WorkOS API key: the client secret of the sign-in code exchange and the session refresh.                                             | `app_env`, uploaded by each deploy.                    | Nobody can sign in, and every session ends when its access token expires (minutes).                                                                                                          |
| `WORKOS_CLIENT_ID`       | The app's WorkOS client, so the same people are the same users. Its key set verifies access tokens.                                           | `app_env`, uploaded by each deploy.                    | Nobody can sign in; a different client's would sign in people the `users` table does not know.                                                                                               |
| `WORKOS_COOKIE_PASSWORD` | Seals this host's session cookie. At least 32 characters, this Worker's own and not the app's.                                                | `setup.mjs secrets`, once.                             | Sign-in fails. Changing it signs everyone out.                                                                                                                                               |
| `SSH_HOST_KEY`           | The SSH server's ed25519 private key, as `ssh-keygen` writes it. Clients pin its public half on first connect.                                | `setup.mjs secrets`, once (it prints the public half). | Git over SSH refuses every connection. Changing it makes every client that has connected before refuse to, until they remove the old key from `known_hosts`.                                 |
| `GIT_JOB_TOKEN_KEY`      | The HMAC key of CI job tokens (`iwj_`), at least 32 characters. The app mints them with the same value; this Worker only checks them.         | `app_env`, uploaded by each deploy.                    | Runners cannot clone a repository here, so its runs wait saying the key is missing; a value that differs from the app's refuses every job token.                                             |
| `ENCRYPTION_MASTER_KEY`  | The app's master key (base64 of 32 bytes). Read for one thing: an `iwk_` API key's stored hash is an HMAC under a key derived from it.        | `app_env`, uploaded by each deploy.                    | Infrawrench API keys are refused for Git and for the API. Sessions, personal tokens (`iwg_`), SSH keys and job tokens do not use it.                                                         |
| `CI_PROXY_URL`           | Optional. The CI proxy's origin, where the app's CI code sends a run.                                                                         | `app_env`, uploaded by each deploy when set.           | A push still records its run; the app's poller sends it (a second or two later) instead of this Worker. The CI tab here cannot show a finished run's job output or a running one's live log. |
| `CI_PROXY_KEY`           | Optional. The key that proxy takes.                                                                                                           | `app_env`, uploaded by each deploy when set.           | As without `CI_PROXY_URL`.                                                                                                                                                                   |
| `APP_URL`                | Optional. The app's origin as the server knows it: where runners report a run's progress to, and the link a commit status carries to its run. | `app_env`, uploaded by each deploy when set.           | Runs sent from here are followed by the poller alone, and their statuses have no link.                                                                                                       |

| `CLOUDFLARE_ACCOUNT_ID` | Optional. The Cloudflare account of the app's AI Gateway, which the review agents call Claude through. | `app_env`, uploaded by each deploy when set. | Review agents do not run: a push queues no run, and asking for one answers 422 saying they are not set up. Everything else about review (versions, findings a reviewer of your own reports, the merge block) works. |
| `AI_GATEWAY_ID` | Optional. That gateway's name. | `app_env`, uploaded by each deploy when set. | As without `CLOUDFLARE_ACCOUNT_ID`: all three or none. |
| `AI_GATEWAY_TOKEN` | Optional. A Cloudflare API token with the AI Gateway Run permission. The Worker holds no Anthropic key. | `app_env`, uploaded by each deploy when set. | As without `CLOUDFLARE_ACCOUNT_ID`. |
| `INFRAWRENCH_PLATFORM_ADMIN_EMAILS` | Optional. The app's platform admins, comma separated: they may give an organisation a reserved name from Settings > Organisations, as in the app. | `app_env`, uploaded by each deploy when set. | Nobody may take a reserved name on the forge. |

Nothing else the app has is given to this Worker: the deploy passes on those keys of the edge-env secret and no others. `CI_ARTIFACT_SIGNING_KEY` and the `GITHUB_APP_*` variables are read by server-core modules the bundle includes but this Worker never reaches (a run's downloads and GitHub repositories are the app's).

The six required ones are the whole of a working forge; of the optional ones three are CI's and three the review agents'. The Worker has no Stripe key: what review agents use is written to the organisation's AI spend and sent to the meter by the app's poller. To rotate one of the app's, change `app_env`, `terraform apply`, and run `git-deploy` again (a deploy adds to a Worker's secrets and never removes one). To set one by hand: `pnpm --filter @infrawrench/git-worker exec wrangler secret put <NAME>`.

## The bundle

`pnpm --filter @infrawrench/git-worker bundle` is `wrangler deploy --dry-run`: 5.0 MB, 1.0 MB gzipped (26 November 2026, with the MCP server, whose SDK and schema library are 0.75 MB of it; 3.4 MB and 0.7 MB when the plugin registry left). It was 9.0 MB and 1.8 MB while the bundle reached server-core's plugin loader, which brought the plugins' metadata registry (3.5 MB), undici and the socket drivers' stubs with it, and needed the app's `alias` map of every library that cannot run in a Worker. Now `src/__tests__/import-graph.test.ts` bundles the Worker and fails, with the chain of imports, when something brings any of that back; `wrangler.jsonc` has no `alias` map to keep in step with `server-core/edge/gateway-only-modules.json`.

What keeps it out is one line of server-core (`ci/runs.ts` `lendingCode`): with `__INFRAWRENCH_EDGE_PLUGINS__` defined, a run that lends something (a connection, an SSH key, an `env-file:`) is left for the app's gateway to send, as it is on the app's own edge Worker, and the code that lends is not bundled. Every other run is sent from here.

`pnpm --filter @infrawrench/git-worker check:startup` profiles start-up (80 to 160 ms locally, on a busy machine). The server code is imported on first use (`src/index.ts`), so keep new imports there dynamic.
