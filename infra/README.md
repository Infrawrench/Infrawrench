# Production infrastructure

The prod web stack runs on four platforms, with Postgres (analytics tables
included) on Neon throughout:

- **Cloudflare Workers**: the `infrawrench-web` front door on
  `app.infrawrench.com/*` (the SPA and most of the API) and the
  `infrawrench-poller` edge poller. See [Cloudflare edge](#cloudflare-edge).
- **AWS Lambda**: the Node work that finishes within a request, and the
  poller. See [Lambda gateway](#lambda-gateway).
- **AWS EC2**: the session gateway, two instances behind a Cloudflare Tunnel
  for WebSockets, SSE, PTYs and large uploads. See
  [AWS session gateway](#aws-session-gateway).
- **Oracle Cloud**: the `github-watcher`, on one Always Free VM. See
  [Oracle Cloud](#oracle-cloud).

GCP keeps the Artifact Registry repo every image is built into first and the
keyless CI identity that pushes there.
The CF Workers deployables (website, telemetry) are not part of this.

| Layer                                                                   | Owner                                     |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| Registry, CI identity, Lambda, session gateway, Oracle VM, edge secrets | `infra/terraform` (applied manually)      |
| Images `web` / `poller` / `github-watcher`, tagged `:<commit sha>`      | `.github/workflows/web-deploy.yml`        |
| Container registry `registry.infrawrench.com` (CF Worker + R2)          | `infra/registry` (deployed manually)      |
| Image `bastion-agent`, tagged `:<commit sha>` + `:latest`               | `.infrawrench/ci/bastion-deploy.yml`      |
| Workflow egress proxy `egress.infrawrench.com` (CF Worker)              | `.infrawrench/ci/egress-proxy-deploy.yml` |
| Edge Workers `infrawrench-web` / `infrawrench-poller`                   | `.github/workflows/web-deploy.yml`        |
| Lambda image `lambda`, tagged `:<commit sha>`                           | `.github/workflows/web-deploy.yml`        |

**The egress proxy is deliberately not on the gateways.** Workflow `fetch()`
runs in the `web`/`poller` isolates; if the gateway made the request, every
workflow would be one URL away from the gateway's own network and the cloud
metadata server on 169.254.169.254. The request is handed to a Cloudflare
Worker instead (`app/packages/egress-proxy`), which has no route into a VPC.
The gateways find it via `WORKFLOW_FETCH_PROXY_URL` /
`WORKFLOW_FETCH_PROXY_TOKEN` in `app_env`; with those unset, workflow
`fetch()` fails rather than falling back to an in-process request.

History: this replaced a DigitalOcean DOKS stack (destroyed 2026-07-25), whose
successor, a regional GKE cluster running `web`, `poller` and
`github-watcher` from the manifests in `infra/k8s`, was emptied by 2026-10-13
and removed on 2026-11-17 along with `infra/k8s`. Git history has both.

## What is left on GCP

- **Artifact Registry** (`main.tf`): `build-push` builds each image here first;
  `deploy-aws-web` and `deploy-oci` copy them on to ECR and OCIR. It keeps the
  30 most recent versions per image and deletes anything older than 90 days.
- **Keyless CI** (`ci.tf`). GitHub's OIDC token is exchanged for short-lived
  credentials on a CI service account via Workload Identity Federation,
  restricted to `main` of this repository and to jobs running under the
  `production` GitHub environment. No GCP JSON key exists in repo secrets. The
  account can push to the registry and nothing else.

## One-time bootstrap

1. **Terraform**: authenticate as a principal with Owner (or Project IAM
   Admin + Artifact Registry Admin) on the project, plus AWS and Oracle
   credentials for the sections below:

   ```sh
   gcloud auth application-default login
   cd infra/terraform
   cp terraform.tfvars.example terraform.tfvars   # fill in project_id + app_env
   terraform init && terraform apply
   ```

   If the project has never had these APIs enabled, `apply` can fail once on
   API-not-enabled while the enablement propagates; re-run it.

2. **GitHub repo settings**: the GCP variables are terraform outputs:

   ```sh
   terraform output   # registry_endpoint, ci_service_account,
                      # workload_identity_provider
   ```

   - Environment: create `production` (Settings, Environments) with a
     deployment branch rule allowing only `main`; add required reviewers if
     deploys should wait for approval. Every `web-deploy` job runs under it,
     and the Workload Identity condition rejects any job that does not.
   - Environment secret (on `production`, not the repository):
     `PROD_DATABASE_URL`
   - Repository variables: `GCP_WORKLOAD_IDENTITY_PROVIDER`,
     `GCP_SERVICE_ACCOUNT`, `AR_REGISTRY`, plus `GCP_REGION` if the registry
     is not in us-east4. The Lambda, AWS, Oracle and edge sections below add
     their own.

3. **Allowlists**: if Neon's IP allow is enabled, add the Lambda VPC's
   `lambda_egress_ip` output, which the Lambda functions and the session
   gateway both leave from.

4. **First deploy**: push to `main` (or run the `web-deploy` workflow
   manually). CI builds the three images, tags them with the commit SHA, pushes
   to Artifact Registry, runs drizzle migrations against Neon, then runs each
   enabled deploy job.

## The default compute service account

The project's default compute account, on most projects
`<project-number>-compute@developer.gserviceaccount.com`, was granted
**project Editor** automatically when the Compute Engine API was enabled.
Terraform never created that binding and deliberately does not remove it,
because things outside this config (a VM created by hand, an old Cloud
Function) may run as that account. **Manual step:**

1. Find what uses the default account:
   `gcloud compute instances list --format='table(name,serviceAccounts[].email)'`,
   plus Cloud Functions, Cloud Run and Dataflow if the project uses them.
2. If nothing does, remove the grant:
   `gcloud projects remove-iam-policy-binding <project> --member='serviceAccount:<number>-compute@developer.gserviceaccount.com' --role=roles/editor`.
   Projects old enough to have the legacy
   `<number>@cloudbuild.gserviceaccount.com` account should apply the same
   check to it.

The org policy `iam.automaticIamGrantsForDefaultServiceAccounts` stops new
projects from granting Editor to begin with.

## Cloudflare edge

Most of the web app and the poller run on Cloudflare Workers, with the Lambda
functions and the AWS session gateway as the Node **gateway** for what a
Worker cannot do: socket database
drivers, SSH and SFTP, kubectl and k9s, Docker, bastion agents, shared
consoles, Linux app streams, chat and the workflow isolate. KNOWLEDGE.md
("Edge/gateway split") explains the mechanism; this section is the runbook.

- **`infrawrench-web`** (`app/packages/web/edge`) sits on the
  `app.infrawrench.com/*` route _in front of_ the origin. It serves the SPA
  from static assets, runs the API itself, sends Node work to the Lambda,
  and forwards session work to the origin with a plain `fetch(request)`,
  which a Worker's subrequest to its own route sends to the origin (the
  session gateway's tunnel) rather than back through the Worker. The bastion
  agents and desktop clients keep connecting to the same URL.
- **`infrawrench-poller`** (`app/packages/poller/edge`) runs the poller
  passes that need nothing Node-only, beside the Node poller running with
  `POLLER_SCOPE=gateway`.
- Both reach Postgres, the analytics tables included, through
  **Hyperdrive**.

### Provisioning (once)

Run wrangler from either Worker package (`pnpm --filter @infrawrench/web exec
wrangler ...`) on the Infrawrench Production account.

1. **Neon must accept Hyperdrive.** Hyperdrive connects from Cloudflare's
   network, not the Cloud NAT address. The `core` project has no IP allowlist
   (checked 2026-10-06), so nothing is needed today; if one is ever added it
   must cover Hyperdrive and the GitHub-hosted runners that run migrations,
   neither of which has a fixed address.
2. **Hyperdrive**, pointed at Neon's _direct_ endpoint (not `-pooler`;
   Hyperdrive is the pool):
   `wrangler hyperdrive create infrawrench-db --connection-string="postgres://…"`.
3. **Queue**: `wrangler queues create infrawrench-poll`.
4. Replace `HYPERDRIVE_ID` in **both** `edge/wrangler.jsonc` files with the
   id from step 2, and commit. CI refuses to deploy while the placeholder is
   there.
5. Set the repo variable `EDGE_DEPLOY_ENABLED=true`. The next main push runs
   `deploy-edge` after `deploy-lambda`: it reads the edge-env secret
   terraform keeps in AWS Secrets Manager (`lambda.tf`) and uploads it as both
   Workers' secrets, so `app_env` stays the one place a value lives. It needs
   the Lambda gateway's repository variables to read it.

### Cutover order

Each step is independently reversible, and in this order nothing is ever
unserved.

1. Deploy with `EDGE_DEPLOY_ENABLED=true`. The poller Worker starts claiming
   accounts at once; the Node poller (still scope `all`) claims alongside it,
   which the `SKIP LOCKED` leases make safe. Watch
   `accounts.requires_gateway` fill in as Postgres, Docker and similar
   accounts hand themselves over.
2. Add `POLLER_SCOPE = "gateway"` to `app_env` and `terraform apply`. The
   Node poller (then the GKE Deployment, now the Lambda poller function)
   does only gateway work.
3. The web Worker's route (`app.infrawrench.com/*`) went live on 2026-10-06,
   on the second attempt. The first, about 15 minutes, cost every request
   2-5 s because the API did not fit a 128 MB isolate; it went back once the
   plugin code was out of the bundle and both Workers were pinned next to the
   database (KNOWLEDGE.md, "Edge/gateway split"). Measure per-request CPU with
   `wrangler tail` after any change to what the API loads.

**Rollback**: delete the web Worker's route (dashboard, or redeploy without
it) and every request goes straight to the session gateway again. Unset
`POLLER_SCOPE` to make the Lambda poller do everything; the poller Worker can stay
(the leases make the overlap harmless) or be deleted.

### Day-2

- **Secrets** still rotate through `app_env`. The Workers pick up a change on
  the next `deploy-edge` run; to push one without a code change, re-run the
  workflow.
- **An account stuck on the gateway** (`requires_gateway = true`) is
  harmless, the gateway can do everything, but `gateway_reason` says why it
  moved, and setting the flag back to false lets the edge try again.
- **A write that 503s** with "could not be completed here" reached a Node-only
  path on the edge. The Worker logs `[edge] <method> <path> reached a
gateway-only path`; add the route to `src/edge/gateway-routes.ts`.

## git.infrawrench.com

The forge (`git/`) is one Worker, `infrawrench-git` (`git/packages/worker`),
on the Infrawrench Production account: the UI as static assets, the API, Git
over HTTPS, and Git over SSH through a Spectrum application. It reads the
app's Postgres through the app's Hyperdrive and keeps repositories in R2 and
one Durable Object each. `git/packages/worker/README.md` lists every binding,
variable and secret and what breaks without each; this section is how they
come to exist.

`infra/git/setup.mjs` does the Cloudflare part through the API. It reads the
names from the Worker's `wrangler.jsonc`, looks before it changes anything, so
it can be run again at any point, and prints no secret. `--dry-run` prints
every request it would send and sends none:

```sh
node infra/git/setup.mjs --dry-run
```

It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
environment. The token: Workers Scripts, Workers R2 Storage and Queues (edit)
and Hyperdrive (read) on the account; Zone (read) and Zone Settings (edit) on
`infrawrench.com`, which is what Spectrum's API asks for.

### Provisioning (once)

1. **WorkOS** (dashboard, production environment, **Redirects**): add the
   redirect URI `https://git.infrawrench.com/auth/callback` and the sign-out
   redirect `https://git.infrawrench.com/`. The forge uses the app's client,
   so there is no new key; without the redirect URI WorkOS refuses the
   sign-in before it shows a page.
2. **The app's side of CI**: `GIT_JOB_TOKEN_KEY` in `app_env`
   (`terraform.tfvars.example` says how to make one), `terraform apply`. The
   Worker gets the same value from there at each deploy. Skip it and the
   deploy stops, naming the key.
3. **Bucket, queues and the Worker's own secrets**:

   ```sh
   node infra/git/setup.mjs
   ```

   - R2 bucket `infrawrench-git` (`--location` picks the hint; `enam` by
     default, next to the database).
   - Queues `infrawrench-git-events`, `infrawrench-git-reviews` (review
     agents' runs), `infrawrench-git-jobs` (push mirrors and issue imports)
     and `infrawrench-git-events-dlq`: every queue
     `wrangler.jsonc` names. The consumers' settings are the Worker's
     `wrangler.jsonc` and arrive with the deploy. A queue added there later
     is made by running the script again (`--only queues`) before the deploy
     that binds it.
   - It checks that the Hyperdrive in `wrangler.jsonc` exists. It is the
     app's (`infrawrench-db`, "Cloudflare edge" above) and nothing is
     created: the forge's tables are in the app's database.
   - `WORKOS_COOKIE_PASSWORD` (48 random bytes) and `SSH_HOST_KEY`: an
     ed25519 key from `ssh-keygen -t ed25519`, stored with `wrangler secret
put` and deleted from disk. Both are made only when absent and never
     replaced. The script prints the host key's public half and fingerprint:
     keep them, they are what people check a first connection against. The
     Worker does not exist yet at this point, and `wrangler secret put` makes
     it, empty, to hold them.

4. **Deploy**: set the repo variable `GIT_DEPLOY_ENABLED=true` and run
   `git-deploy` (Actions, **Run workflow**), or push to `main`. It needs the
   Lambda gateway's repository variables to read the edge-env secret, as
   `deploy-edge` does, and the `CLOUDFLARE_API_TOKEN` secret must cover this
   Worker (the workflow's header lists the permissions). The deploy attaches
   the custom domain `git.infrawrench.com`, creates the Durable Object class
   and attaches the queue consumer.
5. **Check HTTPS** before opening SSH: sign in at `https://git.infrawrench.com`,
   create a repository, push to it with a personal access token.
6. **Spectrum**, which needs the deployed Worker's tag:

   ```sh
   node infra/git/setup.mjs --only spectrum
   ```

   It creates one application: `dns` `{ "type": "CNAME", "name": <SSH_HOST> }`,
   `protocol` `tcp/22`, `traffic_type` `worker`, `origin_worker_id` the
   Worker's 32-character tag (from `GET /accounts/$ACCOUNT_ID/workers/scripts`).
   Worker origins are a public beta: a Pro or Business zone gets one such
   application, on one TCP port, beside its plan's own SSH application, and
   Proxy Protocol is not supported.

   **Whether `git.infrawrench.com` can carry both the Worker's custom domain
   and this application is not documented.** The script tries the name in
   `SSH_HOST` (`wrangler.jsonc`, `git.infrawrench.com`). If Cloudflare refuses
   it, change that value to `ssh.git.infrawrench.com`, deploy, and run the
   step again; clone URLs follow the same value, so nothing else changes. To
   try a name without editing first, `--ssh-host ssh.git.infrawrench.com`
   (the script then says the variable has to follow).

7. **Check SSH**: `ssh -T git@<SSH_HOST>` should print the host key's
   fingerprint from step 3 to accept, then the forge's greeting. Then clone
   and push over SSH, including a push of a few hundred megabytes: the
   Durable Object's full-duplex `fetch` is the one thing the local tests
   cannot confirm for production (`git/packages/worker/NOTES.md`, "Where
   things run"). Also confirm, with `wrangler tail`, that the address the
   Worker sees for a connection (`socket.opened.remoteAddress`) is the
   client's: the limit on failed sign-ins is per address
   (`transport/ssh/rate-limit.ts`), and without Proxy Protocol nothing else
   carries it.

### Day-2

- **Deploys** follow pushes to `main` that touch `git/**` or what the Worker
  and the UI are built from. A deploy waits up to twenty minutes for the
  commit's newest migration to be in the database (`web-deploy`'s `migrate`
  job applies it) and fails rather than run ahead of the schema.
- **Secrets shared with the app** rotate through `app_env`: `terraform apply`,
  then re-run `git-deploy`. `GIT_JOB_TOKEN_KEY` changes on both sides in that
  order, and runs being cloned in between fail; retry them.
- **The SSH host key is not rotated.** A new one makes every client that has
  connected before refuse to. If it must change (it leaked), delete the
  secret, run `node infra/git/setup.mjs --only secrets`, deploy, and publish
  the new fingerprint.
- **Review agents** need `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID` and
  `AI_GATEWAY_TOKEN` in `app_env` (the app's own, for AI chat): the deploy
  passes them on and warns when one is missing, and without them no review
  runs. What a run uses is billed from the organisation's AI spend; the
  Stripe meter event is sent by the app's poller (`git-storage` pass), not
  the Worker.
- **A push event that failed five deliveries** is in
  `infrawrench-git-events-dlq`. Nothing consumes it: read it with
  `wrangler queues` to see what the consumer could not process. The
  repository itself is unaffected (the refs moved before the event was sent).
- **Rollback**: `wrangler rollback` in `git/packages/worker` returns to the
  previous version; Durable Object storage and R2 are not rolled back, and
  neither needs to be for a code change. Setting `GIT_DEPLOY_ENABLED` to
  anything else stops further deploys.
- **Turning SSH off**: delete the Spectrum application (dashboard, or
  `DELETE /zones/$ZONE_ID/spectrum/apps/$APP_ID`). HTTPS is untouched.

## Lambda gateway

The Node half of the edge split is two tiers. The **Lambda gateway** runs on
AWS Lambda and takes the Node work that finishes within a request; the
**session gateway** on AWS EC2 takes what needs a long-lived process.
KNOWLEDGE.md ("Edge/gateway split") explains the routing; this is the runbook.

| Work                                                                                                                      | Runs on                                 |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Most of the API                                                                                                           | `infrawrench-web` Worker                |
| Plugin calls (the web Worker carries no plugin code), socket drivers, request-scoped SSH, account writes, OAuth, webhooks | Lambda `infrawrench-prod-lambda-web`    |
| WebSockets, bastion agents and bastion-bound accounts, shared consoles, Linux apps, MCP, chat, deploys, storage uploads   | AWS session gateway (`aws-web.tf`)      |
| Poller, edge half                                                                                                         | `infrawrench-poller` Worker             |
| Poller, gateway half                                                                                                      | Lambda `infrawrench-prod-lambda-poller` |
| `github-watcher` (deploys run up to 20 minutes, past Lambda's 15)                                                         | Oracle Cloud VM (`oci.tf`)              |

- **One image, two functions** (`infra/docker/lambda.Dockerfile`, built on
  the OS-only `provided.al2023` image with Amazon Linux's Node and our own
  runtime client). The web function is reached through a function URL in
  `RESPONSE_STREAM` mode on its `live` alias; the poller is invoked by an
  EventBridge Scheduler rule every minute and ticks on its usual 15-second
  cadence for most of it.
- **The web function runs on SnapStart.** Init (the whole API with every
  plugin) runs once when a version is published, and new environments resume
  from a snapshot of it in about a second instead of a ~30-second cold start.
  Only published versions have snapshots, which is why the URL serves the
  `live` alias. KNOWLEDGE.md ("Lambda gateway") has why the runtime and the
  base image are what they are.
- **The function URL is public**, so the web function refuses any request
  without `LAMBDA_GATEWAY_SECRET`, which only the Worker holds. Terraform
  generates it and merges it, with the URL, into the edge-env secret, which is
  how the Worker gets both.
- **`app_env` stays the one place a value lives.** Terraform writes it to a
  Secrets Manager secret the functions load at cold start, merged with
  `lambda_app_env` for the few values that must differ there.
- **Egress** leaves through a NAT gateway with one Elastic IP
  (`lambda_egress_ip`). Allowlist it wherever the stack needs a fixed source
  address; the session gateway leaves through the same NAT.

### Provisioning (once)

1. **Neon pooler.** Point `lambda_app_env.DATABASE_URL` at the `-pooler`
   endpoint. Every warm execution environment holds its own small pool, and
   the pooler keeps that from eating the compute's connection limit.
2. **Terraform**, with AWS credentials for the target account:
   `lambda_enabled = true`, then `terraform apply`. This creates the ECR
   repository, the secret, the VPC and NAT, the roles and GitHub's OIDC
   provider (set `aws_github_oidc_provider_arn` instead if the account
   already has one). No functions yet: they need an image.
3. **GitHub**: repository variables `LAMBDA_ECR_REPOSITORY` and
   `AWS_LAMBDA_CI_ROLE_ARN` from the outputs (plus `AWS_REGION` if not
   us-east-2), then `LAMBDA_DEPLOY_ENABLED=true`. The next deploy pushes the
   image and notes that the functions do not exist yet.
4. **Terraform again** with `lambda_initial_image_tag` set to that commit SHA.
   The functions, the function URL and the schedule come up, and the
   edge-env secret gains `LAMBDA_GATEWAY_URL`. The poller function starts
   claiming at once, beside the Node poller; the leases make that safe.
5. **Smoke test** before the Worker uses it: a request to the function URL
   without the secret must answer 403. `GET /healthz` with the
   `x-iw-gateway-secret` header answers `ok`. The apply that creates the
   function also publishes version 1 and its snapshot, which takes a minute
   or two; the URL answers once it is done.

### Cutover order

Each step is independently reversible.

1. Re-run `deploy-edge` (any deploy does). The Worker now has
   `LAMBDA_GATEWAY_URL` and sends Node work there. Watch the web function's
   logs and the Worker's `wrangler tail`; a 421 from the Lambda is a normal
   handoff to the session gateway, not an error.
2. Once the poller function has run clean for a while, scale the Node
   poller to zero (it was the GKE `poller` Deployment). `POLLER_SCOPE` is shared through
   `app_env`, so the function claims exactly what the Node poller did.
   **Done 2026-10-13**, with `POLLER_SCOPE` unset: the function polls every
   account and runs every pass, and the poller Worker is paused
   (`POLLER_EDGE_PAUSED = "true"` in `app/packages/poller/edge/wrangler.jsonc`).
   Its scheduler Durable Object was exceeding its memory limit mid-tick, so
   accounts it claimed went unsynced until their leases expired; the GKE
   poller had been quietly finishing them. To return to the split once that is
   fixed: set the var to `"false"`, deploy, confirm accounts sync, then set
   `POLLER_SCOPE = "gateway"` in `app_env`.
3. Move the session work off GKE (done 2026-10-13; see
   [AWS session gateway](#aws-session-gateway)).

**Rollback**: there is no Node poller to fall back to since the GKE cluster
was removed (2026-11-17), so the Lambda tier is load-bearing. Rolling back a
bad release means pointing the `live` alias at the previous version (Day-2
below), not removing the functions: `lambda_initial_image_tag = ""` would
leave the poller's gateway work undone and the Worker sending Node work to
the session gateway, which serves it but was not sized for it.

### Day-2

- **Code** deploys with every main push (`deploy-lambda`, before the Worker).
  Terraform ignores `image_uri`, so an apply never rolls code back. For the
  web function the job also publishes a version, waits for its snapshot,
  moves `live` to it and deletes all but the newest three versions.
- **A deploy that fails at "Publish the web function"** left `live` where it
  was; nothing is serving the new version. The job prints the version's
  state reason and the init log is in `/aws/lambda/infrawrench-prod-lambda-web`.
  The usual cause is init drawing randomness (`[lambda-runtime] refusing the
snapshot`, with the call sites): load the module that does it lazily.
- **Rolling the web function back** is moving the alias:
  `aws lambda update-alias --function-name infrawrench-prod-lambda-web --name live --function-version <n>`.
  The previous two versions are kept for this; the next deploy moves it on.
- **Configuration**: edit `app_env` or `lambda_app_env`, `terraform apply`.
  The secret's version id is in the functions' environment, so the change
  replaces the poller's running environments and publishes a new web version
  (and snapshot) that `live` moves to. Nothing reads the secret after init.
- **Cold starts**: the web function resumes from its snapshot, so a new
  environment costs about a second. The poller still runs its full init when
  it starts a new environment, which is off every request path.
- **A Lambda request that 503s** with "could not be completed here" wrote to
  the database and then reached a bastion agent. The path should go to the
  session gateway: add it to the `SESSION_ROUTES` list in
  `src/edge/gateway-routes.ts`.

## AWS session gateway

The session gateway (the third tier, after the edge Worker and the Lambda:
WebSockets, SSE, SSH and kubectl PTYs, uploads over 4 MiB) runs on two AWS
t4g.medium instances, in place of the GKE `web` Deployment it replaced on
2026-10-13. Terraform is `infra/terraform/aws-web.tf`; the instances' side is
`infra/vm/`.

- **Where**: one instance per availability zone in the Lambda VPC's private
  subnets. No public address, nothing can connect in, and they egress through
  the Lambda's NAT Elastic IP (`terraform output lambda_egress_ip`), the one
  address to allowlist for everything Infrawrench runs on AWS.
- **Traffic and failover**: each runs the web image and a connector for the
  Cloudflare Tunnel `infrawrench-session-gateway`, whose routes are
  `app.infrawrench.com` and `session-gateway.infrawrench.com` (a test
  hostname that skips the Worker) to `http://localhost:3000`.
  `app.infrawrench.com` is a proxied CNAME to the tunnel, so the Worker's
  `fetch(request)` to its own host lands there. Cloudflare spreads requests
  over the connected replicas; an instance that dies drops out, and so does
  one whose app fails `/healthz`, because the agent stops its connector.
  Verified on 2026-10-13: 200 requests through one instance going down, none
  failed, and the agent brought it back within a minute.
- **State across the two**: a bastion agent's connection and a shared
  console's pty live in one process; the other instance reaches them through
  the realtime relay (KNOWLEDGE.md, "Realtime relay"), so the tunnel's lack of
  affinity costs nothing. Needs `APP_URL` and `INTERNAL_RELAY_SECRET` in
  `app_env`.
- **Configuration**: the Lambda's own Secrets Manager secret (`app_env` merged
  with `lambda_app_env`), read through the instance role. The tunnel token and
  the agent itself are in a private S3 bucket.
- **Deploys**: CI's `deploy-aws-web` job copies each deploy's
  `web:<sha>-arm64` (built on an arm runner) from Artifact Registry to the
  session ECR repository as `session-arm64`. Each instance's agent
  (`infra/vm/agent.sh`, every minute) pulls it and restarts on a new image id;
  web-2 waits three minutes after web-1, and an instance's connector is down
  while its app restarts. ECR keeps the last ten images.

### Day-2

- **Shell**: `aws ssm start-session --target <id>` (`terraform output
aws_web_instances`). No SSH. Then `sudo docker logs app`, `sudo docker logs
cloudflared`, `sudo journalctl -u infrawrench-agent`.
- **Configuration change**: edit `app_env` or `lambda_app_env`, `terraform
apply`; the agents restart the app within a minute.
- **Agent change**: edit `infra/vm/agent.sh`, `terraform apply` (it is an S3
  object). Changes to `cloud-init-aws.yaml` only reach new instances.

## Oracle Cloud

The github-watcher runs on an Oracle Cloud Always Free micro VM
(`infra/terraform/oci.tf`), in place of the GKE `github-watcher` Deployment
it replaced. It runs the same agent (`infra/vm/agent.sh`) and follows
`github-watcher:oci` in OCIR, which CI's `deploy-oci` job sets after each
deploy and prunes of untagged images. Oracle's free Ampere capacity in
us-ashburn-1 was exhausted in every availability domain for days, which is
why the session gateway went to AWS instead. SSH as `ubuntu` from
`oci_admin_cidrs`; `terraform output oci_instances`.

## Day-2 notes

- **Deploys are push-to-main.** Every deploy is a full image rebuild pinned to
  the commit SHA. The Lambda's `live` alias names the version serving, the
  session gateway and the Oracle VM follow a moving tag (`session-arm64`,
  `github-watcher:oci`) that CI points at each commit, and rolling back is
  reverting the commit (or, for the Lambda, moving the alias).
- **Secrets rotate through terraform**: edit `app_env` in `terraform.tfvars`
  and `terraform apply`. The Lambda functions get a new configuration, the VM
  agents restart their app within a minute, and the Workers pick it up on the
  next `deploy-edge` run (re-run the workflow to push one without a code
  change).
- **Migrations run before the deploy jobs**, so schema changes must be
  backward-compatible with the previous release (expand, deploy, contract).
- **Image retention**: Artifact Registry keeps the 30 most recent versions per
  image and deletes anything older than 90 days. Rollback targets beyond that
  window need a rebuild.
- Terraform state is local by default; move it to a remote backend before a
  second operator touches this.
