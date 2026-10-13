# Production infrastructure (GCP)

Prod web stack on GKE: `web` (Hono + WebSockets, 2 replicas), `poller`
(2 replicas — safe, it claims work atomically), and `github-watcher`
(1 replica — its SHA CAS makes overlap safe, but replicas just multiply
GitHub API reads). Postgres stays on Neon, metrics on ClickHouse Cloud;
the CF Workers deployables (website, telemetry) are not part of this.
In front of the pods sit the Cloudflare edge Workers and, optionally, the
AWS Lambda gateway, which take over most of the web API and the poller; see
[Cloudflare edge](#cloudflare-edge) and [Lambda gateway](#lambda-gateway).

| Layer                                                                 | Owner                                       |
| --------------------------------------------------------------------- | ------------------------------------------- |
| Network, cluster, registry, namespace, secrets, ingress, cert-manager | `infra/terraform` (applied manually)        |
| Deployments, Service, Ingress, ClusterIssuer                          | `infra/k8s` (applied by CI)                 |
| Images `web` / `poller` / `github-watcher`, tagged `:<commit sha>`    | `.github/workflows/web-deploy.yml`          |
| Container registry `registry.infrawrench.com` (CF Worker + R2)        | `infra/registry` (deployed manually)        |
| Image `bastion-agent`, tagged `:<commit sha>` + `:latest`             | `.github/workflows/bastion-deploy.yml`      |
| Workflow egress proxy `egress.infrawrench.com` (CF Worker)            | `.github/workflows/egress-proxy-deploy.yml` |
| Edge Workers `infrawrench-web` / `infrawrench-poller` (optional)      | `.github/workflows/web-deploy.yml`          |
| Lambda gateway: ECR, functions, VPC, schedule (optional)              | `infra/terraform/lambda.tf`                 |
| Lambda image `lambda`, tagged `:<commit sha>`                         | `.github/workflows/web-deploy.yml`          |
| Cloudflare Tunnel connector to ClickHouse (optional)                  | `infra/terraform/edge.tf`                   |

**The egress proxy is deliberately not on this cluster.** Workflow `fetch()`
runs in the `web`/`poller` isolates; if those pods made the request, every
workflow would be one URL away from pod-to-pod traffic and the metadata server
on 169.254.169.254. The request is handed to a Cloudflare Worker instead
(`app/packages/egress-proxy`), which has no route into the VPC. The pods find it
via `WORKFLOW_FETCH_PROXY_URL` / `WORKFLOW_FETCH_PROXY_TOKEN` in `app_env`;
with those unset, workflow `fetch()` fails rather than falling back to an in-pod
request.

This replaced a DigitalOcean DOKS stack, which was destroyed on 2026-07-25.
Nothing DigitalOcean-side remains.

## Shape of the GCP stack

- **Regional GKE cluster** in `us-east4`, REGULAR release channel, autoscaling
  between 2 and 4 `e2-standard-2` nodes **region-wide** (not per zone — a
  three-zone cluster with a per-zone floor of 2 would sit at 6 nodes).
- **Private nodes.** Nodes have no external IPs; egress leaves through Cloud
  NAT pinned to a reserved address, so the whole fleet has one stable source
  IP. The control plane endpoint stays public so GitHub Actions can reach it
  without a bastion; see [Control plane access](#control-plane-access) for
  narrowing it.
- **No image pull secret.** The node pool runs as a dedicated service account
  holding `artifactregistry.reader`, so kubelet pulls with its own identity.
  (The DOKS stack needed a `docr-pull` dockerconfigjson secret; this one
  doesn't, which is why the Deployments have no `imagePullSecrets`.)
- **Keyless CI.** GitHub's OIDC token is exchanged for short-lived credentials
  on a CI service account via Workload Identity Federation, restricted to
  `main` of this repository and to jobs running under the `production` GitHub
  environment. No GCP JSON key exists in repo secrets.
- **Static ingress IP**, reserved separately from the ingress-nginx release, so
  reinstalling the chart never changes the address DNS points at.

## One-time bootstrap

1. **Terraform** — authenticate as a principal with Owner (or Project IAM
   Admin + Kubernetes Engine Admin + Artifact Registry Admin) on the project:

   ```sh
   gcloud auth application-default login
   cd infra/terraform
   cp terraform.tfvars.example terraform.tfvars   # fill in project_id + app_env
   terraform init && terraform apply
   ```

   If the project has never had these APIs enabled, `apply` can fail once on
   API-not-enabled while the enablement propagates — re-run it. (Enabling them
   ahead of time with `gcloud services enable` avoids the race; terraform
   adopts already-enabled services rather than conflicting with them.)

2. **GitHub repo settings** — the four variables are terraform outputs:

   ```sh
   terraform output   # registry_endpoint, ci_service_account,
                      # workload_identity_provider, ingress_ip, egress_ip
   ```

   - Environment: create `production` (Settings, Environments) with a
     deployment branch rule allowing only `main`; add required reviewers if
     deploys should wait for approval. Every `web-deploy` job runs under it,
     and the Workload Identity condition rejects any job that does not.
   - Environment secret (on `production`, not the repository):
     `PROD_DATABASE_URL`
   - Repository variables: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`,
     `AR_REGISTRY`, plus `GKE_CLUSTER` / `GKE_REGION` if you changed the
     terraform defaults

3. **Allowlists** — if ClickHouse Cloud's IP access list or Neon's IP allow is
   enabled, add the `egress_ip` output (the Cloud NAT address). Nothing else in
   the fleet has a routable address.

4. **First deploy** — push to `main` (or run the `web-deploy` workflow
   manually). CI builds the three images, tags them with the commit SHA, pushes
   to Artifact Registry, runs drizzle migrations against Neon, rewrites the
   kustomize image names, and applies the manifests.

5. **DNS** — point `app.infrawrench.com` (A record) at the `ingress_ip` output.
   cert-manager then issues the Let's Encrypt cert via HTTP-01 (the ACME email
   is in `infra/k8s/cluster-issuer.yaml` — change it if needed). The record is
   proxied through Cloudflare, so do this with the proxy **off** first — see
   [TLS, Cloudflare, and the ACME deadlock](#tls-cloudflare-and-the-acme-deadlock)
   for why.

## TLS, Cloudflare, and the ACME deadlock

`app.infrawrench.com` is an **A record proxied through Cloudflare** (zone
`infrawrench.com`). That shapes anything involving certificates:

- Visitors terminate TLS at Cloudflare's edge certificate, not at the origin.
  The origin's Let's Encrypt cert is what Cloudflare validates on the back
  half of the connection, so replacing it is never user-visible.
- **cert-manager's HTTP-01 challenge cannot be satisfied while the record
  points somewhere else.** Let's Encrypt resolves the public name, so if that
  still answers from another origin, the solver never sees the request. Worse,
  if the zone's SSL/TLS mode is **Full (strict)**, pointing the proxied record
  at a cluster that only has ingress-nginx's self-signed default cert returns
  526 to visitors _and_ keeps the challenge failing — a deadlock where the
  cert can't issue because the cert isn't valid yet.

The way out is to move the record with the **proxy off** (`proxied: false`,
low TTL). Let's Encrypt then validates directly against the ingress IP:

```sh
kubectl -n infrawrench get certificate web-tls -w
```

Once `web-tls` reports `READY=True`, re-enable the proxy. The origin now
presents a publicly-trusted certificate, which satisfies Full (strict) as well
as the laxer modes. Keep the unproxied window short — the origin IP is exposed
and unprotected while it lasts.

Reissues on renewal are unaffected: the record already points at this cluster,
so HTTP-01 resolves correctly with the proxy on.

## Workload hardening

All three Deployments run with a restrictive `securityContext`: `runAsNonRoot`
as uid/gid **1000** (the `node` user the runtime image already switches to, and
the owner of `/app`), `allowPrivilegeEscalation: false`, all capabilities
dropped, `seccompProfile: RuntimeDefault`, and `readOnlyRootFilesystem: true`.

- **`readOnlyRootFilesystem` needs the `/tmp` emptyDir**, not optimism. `web`
  genuinely writes at runtime: object-storage downloads staged by
  `api/routes/storage.ts`, and the 0600 kubeconfigs
  `services/kubectl-pty-session.ts` and `services/k8s-pf-proxy.ts` drop before
  spawning `kubectl`/`k9s`. Every one of them builds its path under
  `os.tmpdir()`, so one scratch volume mounted at `/tmp` covers the lot. SSH
  session recording (`server-core/src/ssh-recording/`) touches no files — it
  goes to the database.
- **That volume is a plain `emptyDir` with no `medium`, i.e. node-backed
  ephemeral disk. It is deliberately _not_ `medium: Memory`, and it is not a
  tmpfs.** A memory-backed `emptyDir` charges every staged byte against the
  container's memory limit, so a large object-storage download would OOM-kill
  `web` at its 1Gi ceiling instead of taking the eviction path this is designed
  around. Do not "tidy" these into `medium: Memory`. The `sizeLimit` (1Gi on
  `web`, 256Mi on the other two) is the backstop instead: exceed it and the pod
  is evicted, rather than the node's ephemeral disk filling and taking its
  neighbours with it.
- **`NPM_CONFIG_CACHE=/tmp/.npm`** is set in `infra/docker/service.Dockerfile`.
  The container CMD is `npm run start` and npm wants a cache and log dir under
  `$HOME/.npm`, which a read-only root denies it. npm 11 swallows both failures
  (its own source comments the read-only case), so this is defence-in-depth
  against that behaviour changing, not a fix for a crash.
- **`automountServiceAccountToken: false` everywhere.** Workload Identity
  resolves a pod's Google identity through the GKE metadata server keyed off the
  KSA name, never the projected token, so Vertex AI (`web`) and hosted Cloud
  Build (`github-watcher`) keep working. Nothing in the tree reads the projected
  token or calls the in-cluster Kubernetes API — the `kubernetes` plugin talks
  to _customer_ clusters from a user-supplied kubeconfig.

### NetworkPolicy

**App workloads** (`infra/k8s/network-policy.yaml`, applied by CI):

- _Ingress_ is default-deny for `web`, `poller` and `github-watcher`, with
  exactly these paths re-opened: `ingress-nginx` → `web:3000`, the node subnet
  for kubelet probes, and `web` → `web:3000` for the cross-replica relay.
  `poller` and `github-watcher` expose no ports and keep the bare deny. The
  selector is an explicit label list rather than `podSelector: {}` because
  ClickHouse, Keeper and cert-manager's HTTP-01 solver pods share this
  namespace.
- _Egress_ is the public internet minus every private and link-local range
  (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16`), plus
  kube-dns (by its Service ClusterIP too, because NodeLocal DNSCache answers
  on the node and a pod selector never matches), the GKE metadata server's
  Workload Identity endpoints, ClickHouse,
  and `web` → `web`. It is a denylist of the cluster's own address space, not
  an allowlist of destinations: `web`, `poller` and `github-watcher` dial
  arbitrary customer infrastructure by design and a NetworkPolicy cannot name
  SaaS hosts. But this VPC is not peered with anything, so nothing a customer
  legitimately points us at lives in those ranges; everything there is ours
  (nodes, kubelets, pods, Services, the control plane's private endpoint, the
  metadata server). Workflow `fetch()` is still isolated structurally, off
  cluster on the egress proxy; this policy covers what the app dials itself.

**ClickHouse and Keeper** (`infra/terraform/clickhouse.tf`): ClickHouse accepts
8123/9000 only from the app workloads and its own bootstrap/backup jobs, 9000
and 9009 only from the other replica, and probes from the node subnet. Keeper
accepts 9181 only from the ClickHouse servers and 9234 (Raft, which has no
authentication of its own) only from other Keeper members. On top of the
network layer:

- **Interserver credentials.** Part fetches on 9009 carry a terraform-generated
  user/password (`interserver_http_credentials`). Adding them to a running
  cluster needs one apply with `clickhouse_interserver_allow_empty = true`,
  then another with it removed; the tfvars example has the reasoning.
- **Keeper digest identity.** The servers authenticate to Keeper with a
  terraform-generated digest identity, and ClickHouse then creates every znode
  with the `auth` ACL instead of `world:anyone`. Znodes that existed before the
  identity was added keep their open ACL; the Keeper ingress policy is what
  protects those. To close them too, from a ClickHouse pod with a ZooKeeper
  3.6+ CLI: `addauth digest <CLICKHOUSE_KEEPER_IDENTITY>` then
  `setAcl -R /clickhouse auth::cdrwa`. Never regenerate the identity without
  doing the same, or the servers lock themselves out of their own metadata.
- **Keeper four-letter words** are limited to the read-only set; the defaults
  include `rcvr`, `rqld` and `ydld`, which change cluster state without auth.

**Enforcement** is GKE's Calico addon, `enable_network_policy` in
`infra/terraform/main.tf` (on by default). The alternatives and their cost:

- **The Calico addon** (`network_policy` plus
  `addons_config.network_policy_config`) is what this config uses. It is an
  in-place cluster update, **not a replacement**, but GKE then recreates every
  node to start the Calico agents, honouring the maintenance window and each
  pool's surge settings. Workloads are rescheduled once, under their PDBs.
- **Dataplane V2** (`datapath_provider = "ADVANCED_DATAPATH"`) is the better
  long-term answer, but it can only be chosen at cluster creation; on this
  cluster it means recreating it, and `deletion_protection = true` is set. The
  app egress policy already allows the Dataplane V2 metadata endpoints, so the
  policies carry over unchanged if the cluster is ever rebuilt on it.

Rollout order: let CI apply `infra/k8s` first (any push to it does), then
`terraform apply`; the ClickHouse policies and enforcement then land together.
Verify enforcement is live before trusting the policy: from a throwaway pod in
the namespace, a connection to `clickhouse-keeper-headless:9181` should time
out, and the app should still serve, sync and query metrics. A NetworkPolicy
that is present but inert is worse than none, because it reads as protection.

### Control plane access

The control plane keeps its public IP endpoint, behind IAM, so GitHub-hosted
runners (which have no fixed address) can deploy. Two variables narrow it:
`control_plane_dns_endpoint` (on by default) exposes the IAM-gated DNS endpoint,
which authorized networks do not apply to, and `master_authorized_networks`
restricts the IP endpoint to listed CIDRs. Move CI first: set the
`GKE_DNS_ENDPOINT` repo variable to `true` so `web-deploy.yml` fetches
credentials with `--dns-endpoint`, let a deploy go green, and only then set the
list, including the address terraform runs from (its kubernetes and helm
providers use the IP endpoint). People can use
`gcloud container clusters get-credentials ... --dns-endpoint` instead of being
listed.

## Hosted builds and the default compute service account

Hosted Infrafile builds (`terraform/builds.tf`) run customer Dockerfiles, and
any build step can mint a token for the account the build runs as. They run as
a dedicated account (the `build_service_account` output, set as
`GCP_BUILD_SERVICE_ACCOUNT` in `app_env`) that holds `logging.logWriter` and
nothing else; source, staged images, `run()` output and credentials reach each
build through per-object signed URLs and per-secret bindings.

Before that, builds ran as the project's default account, which on most
projects is `<project-number>-compute@developer.gserviceaccount.com` and was
granted **project Editor** automatically when the Compute Engine API was
enabled. Terraform never created that binding and deliberately does not remove
it, because things outside this config (a VM created by hand, an old Cloud
Function) may run as that account. **Manual step after applying:**

1. Confirm builds run as the new account: a recent build in
   `gcloud builds list --limit 5 --format='value(id,serviceAccount)'` should
   name the `-build` account.
2. Find what else uses the default account:
   `gcloud compute instances list --format='table(name,serviceAccounts[].email)'`,
   plus Cloud Functions, Cloud Run and Dataflow if the project uses them. GKE
   nodes and the ClickHouse VM use `google_service_account.nodes`, not it.
3. If nothing does, remove the grant:
   `gcloud projects remove-iam-policy-binding <project> --member='serviceAccount:<number>-compute@developer.gserviceaccount.com' --role=roles/editor`.
   Projects old enough to have builds default to the legacy
   `<number>@cloudbuild.gserviceaccount.com` should apply the same check to
   that account; it no longer runs our builds either.

The org policy `iam.automaticIamGrantsForDefaultServiceAccounts` stops new
projects from granting Editor to begin with.

## Cloudflare edge

Most of the web app and the poller can run on Cloudflare Workers, with the GKE
pods kept as the Node **gateway** for what a Worker cannot do: socket database
drivers, SSH and SFTP, kubectl and k9s, Docker, bastion agents, shared
consoles, Linux app streams, chat and the workflow isolate. KNOWLEDGE.md
("Edge/gateway split") explains the mechanism; this section is the runbook.

- **`infrawrench-web`** (`app/packages/web/edge`) sits on the
  `app.infrawrench.com/*` route _in front of_ the ingress. It serves the SPA
  from static assets, runs the Hono API itself, and forwards everything else
  to the origin with a plain `fetch(request)`, which a Worker's subrequest to
  its own route sends to the origin rather than back through the Worker. The
  ingress, its certificate and the hostname are unchanged; the bastion agents
  and desktop clients keep connecting to the same URL.
- **`infrawrench-poller`** (`app/packages/poller/edge`) runs the poller
  passes that need nothing Node-only, beside the Node poller running with
  `POLLER_SCOPE=gateway`.
- Both reach Postgres through **Hyperdrive** and ClickHouse through a
  **Workers VPC service** over a Cloudflare Tunnel whose connector runs in the
  cluster (`edge.tf`). ClickHouse gets no public address.

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
3. **Tunnel**: create a remotely-managed tunnel (Networking > Tunnels), put
   its token in `terraform.tfvars` as `cloudflare_tunnel_token`, and
   `terraform apply`. Two `cloudflared` pods come up; `/ready` is green once
   they hold a connection.
4. **VPC service** for ClickHouse over that tunnel:
   `wrangler vpc service create infrawrench-clickhouse --type http --tunnel-id <id> --hostname clickhouse.infrawrench.svc.cluster.local --http-port 8123`.
5. **Queue**: `wrangler queues create infrawrench-poll`.
6. Replace `HYPERDRIVE_ID` and `CLICKHOUSE_VPC_SERVICE_ID` in **both**
   `edge/wrangler.jsonc` files with the ids from steps 2 and 4, and commit.
   CI refuses to deploy while the placeholders are there.
7. Set the repo variable `EDGE_DEPLOY_ENABLED=true`. The next main push runs
   `deploy-edge` after the cluster rollout: it reads `infrawrench-env` from
   the cluster and uploads it as both Workers' secrets, so `app_env` stays the
   one place a value lives.

### Cutover order

Each step is independently reversible, and in this order nothing is ever
unserved.

1. Deploy with `EDGE_DEPLOY_ENABLED=true`. The poller Worker starts claiming
   accounts at once; the Node poller (still scope `all`) claims alongside it,
   which the `SKIP LOCKED` leases make safe. Watch
   `accounts.requires_gateway` fill in as Postgres, Docker and similar
   accounts hand themselves over.
2. Add `POLLER_SCOPE = "gateway"` to `app_env`, `terraform apply`, and
   `kubectl -n infrawrench rollout restart deploy/poller`. The Node poller now
   does only gateway work; it can drop to one replica.
3. The web Worker's route (`app.infrawrench.com/*`) went live on 2026-10-06,
   on the second attempt. The first, about 15 minutes, cost every request
   2-5 s because the API did not fit a 128 MB isolate; it went back once the
   plugin code was out of the bundle and both Workers were pinned next to the
   database (KNOWLEDGE.md, "Edge/gateway split"). Measure per-request CPU with
   `wrangler tail` after any change to what the API loads.

**Rollback**: delete the web Worker's route (dashboard, or redeploy without
it) and every request goes straight to the pods again. Unset `POLLER_SCOPE`
and restart the poller to make it do everything; the poller Worker can stay
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

## Lambda gateway

The Node half of the edge split is two tiers. The **Lambda gateway** runs on
AWS Lambda and takes the Node work that finishes within a request; the GKE
web pods stay as the **session gateway** for what needs a long-lived process.
KNOWLEDGE.md ("Edge/gateway split") explains the routing; this is the runbook.

| Work                                                                                                                      | Runs on                                 |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Most of the API                                                                                                           | `infrawrench-web` Worker                |
| Plugin calls (the web Worker carries no plugin code), socket drivers, request-scoped SSH, account writes, OAuth, webhooks | Lambda `infrawrench-prod-lambda-web`    |
| WebSockets, bastion agents and bastion-bound accounts, shared consoles, Linux apps, MCP, chat, deploys, storage uploads   | GKE `web` pods                          |
| Poller, edge half                                                                                                         | `infrawrench-poller` Worker             |
| Poller, gateway half                                                                                                      | Lambda `infrawrench-prod-lambda-poller` |
| `github-watcher` (deploys run up to 20 minutes, past Lambda's 15)                                                         | GKE `github-watcher` pod                |

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
  generates it and merges it, with the URL, into `infrawrench-env`, which is
  how the Worker gets both.
- **`app_env` stays the one place a value lives.** Terraform writes it to a
  Secrets Manager secret the functions load at cold start, merged with
  `lambda_app_env` for the few values that must differ there.
- **Egress** leaves through a NAT gateway with one Elastic IP
  (`lambda_egress_ip`), the counterpart of the Cloud NAT address. Allowlist it
  wherever `egress_ip` is allowlisted.

### Provisioning (once)

1. **ClickHouse over the tunnel.** ClickHouse is in-cluster and the functions
   are not, so give the tunnel from `edge.tf` a public hostname
   (Networking > Tunnels > (tunnel) > Published application routes), say
   `clickhouse-gw.infrawrench.com` to `http://clickhouse.infrawrench.svc.cluster.local:8123`,
   and put a Cloudflare Access application with a **Service Auth** policy in
   front of it. Create a service token (Access > Service credentials) and put
   the hostname and token in `lambda_app_env` (`terraform.tfvars.example`
   shows the shape). The ClickHouse password still applies behind Access.
2. **Neon pooler.** Point `lambda_app_env.DATABASE_URL` at the `-pooler`
   endpoint. Every warm execution environment holds its own small pool, and
   the pooler keeps that from eating the compute's connection limit.
3. **Terraform**, with AWS credentials for the target account:
   `lambda_enabled = true`, then `terraform apply`. This creates the ECR
   repository, the secret, the VPC and NAT, the roles and GitHub's OIDC
   provider (set `aws_github_oidc_provider_arn` instead if the account
   already has one). No functions yet: they need an image.
4. **GitHub**: repository variables `LAMBDA_ECR_REPOSITORY` and
   `AWS_LAMBDA_CI_ROLE_ARN` from the outputs (plus `AWS_REGION` if not
   us-east-2), then `LAMBDA_DEPLOY_ENABLED=true`. The next deploy pushes the
   image and notes that the functions do not exist yet.
5. **Terraform again** with `lambda_initial_image_tag` set to that commit SHA.
   The functions, the function URL and the schedule come up, and
   `infrawrench-env` gains `LAMBDA_GATEWAY_URL`. The poller function starts
   claiming at once, beside the Node poller; the leases make that safe.
6. **Smoke test** before the Worker uses it: a request to the function URL
   without the secret must answer 403. `GET /healthz` with the
   `x-iw-gateway-secret` header answers `ok`. The apply that creates the
   function also publishes version 1 and its snapshot, which takes a minute
   or two; the URL answers once it is done.

### Cutover order

Each step is independently reversible.

1. Re-run `deploy-edge` (any deploy does). The Worker now has
   `LAMBDA_GATEWAY_URL` and sends Node work there. Watch the web function's
   logs and the Worker's `wrangler tail`; a 421 from the Lambda is a normal
   handoff to the pods, not an error.
2. Once the poller function has run clean for a while, set `replicas: 0` in
   `infra/k8s/poller-deployment.yaml`. `POLLER_SCOPE` is shared through
   `app_env`, so the function claims exactly what the Node poller did.
   **Done 2026-10-13**, with `POLLER_SCOPE` unset: the function polls every
   account and runs every pass, and the poller Worker is paused
   (`POLLER_EDGE_PAUSED = "true"` in `app/packages/poller/edge/wrangler.jsonc`).
   Its scheduler Durable Object was exceeding its memory limit mid-tick, so
   accounts it claimed went unsynced until their leases expired; the GKE
   poller had been quietly finishing them. To return to the split once that is
   fixed: set the var to `"false"`, deploy, confirm accounts sync, then set
   `POLLER_SCOPE = "gateway"` in `app_env`.
3. Drop `web` to the replica count the remaining session work needs.

**Rollback**: restore the poller's replicas first, then set
`lambda_initial_image_tag = ""` and apply. That deletes the functions and
drops `LAMBDA_GATEWAY_URL` from `infrawrench-env`; re-run `deploy-edge` and
the Worker sends every Node request to the pods again, exactly as before the
Lambda tier existed.

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

## Oracle Cloud

The session gateway (the third tier, after the edge Worker and the Lambda:
WebSockets, SSE, SSH and kubectl PTYs, uploads over 4 MiB) and the
github-watcher run on Oracle Cloud's Always Free tier, in place of the GKE
`web` and `github-watcher` Deployments. The cluster stays: ClickHouse and the
`cloudflared` connector the edge and the Lambda reach it through run there.
Terraform is `infra/terraform/oci.tf`; the VMs' side is `infra/oci/`.

- **Web**: two Ampere A1 VMs (2 OCPU, 6 GB), each running the web image and a
  connector for the Cloudflare Tunnel `infrawrench-session-gateway`, whose
  routes are `app.infrawrench.com` and `oci-gateway.infrawrench.com` (a test
  hostname) to `http://localhost:3000`. `app.infrawrench.com` is a proxied
  CNAME to the tunnel, so the Worker's `fetch(request)` to its own host lands
  there. Cloudflare spreads requests over the connected replicas; a VM that
  dies drops out, and so does one whose app fails `/healthz`, because the
  agent stops its connector. The cross-replica relay uses the VMs' private
  IPs (`POD_IP`), port 3000 inside the VCN.
- **github-watcher**: one E2.1.Micro VM (1/8 OCPU, 1 GB, 2 GB swap). The
  micro shape is only offered in AD-2 of us-ashburn-1.
- **Configuration**: the same as the Lambda's, `app_env` merged with
  `lambda_app_env` (ClickHouse through the tunnel hostname). Terraform writes
  it to the private bucket `infrawrench-runtime`; nothing listens publicly.
- **Deploys**: CI's `deploy-oci` job copies each deploy's `web:<sha>-arm64`
  (built on an arm runner) and `github-watcher:<sha>` from Artifact Registry
  to OCIR as `web:oci-arm64` and `github-watcher:oci`. Each VM's agent
  (`infra/oci/agent.sh`, every minute) pulls the tag and restarts on a new
  image id; web-2 waits three minutes after web-1, and a web VM's connector is
  down while its app restarts. OCIR, not Artifact Registry, because the GCP
  org policy forbids service-account keys.

### Provisioning (once)

1. API key: Console > My profile > Tokens and keys > Add API key (paste a
   public key), then put the preview in `~/.oci/config` with `key_file`. The
   tenancy's region is its home region, the only one with Always Free
   compute.
2. Cloudflare: a remotely-managed tunnel with the two routes above, and the
   `oci-gateway` proxied CNAME to `<tunnel id>.cfargotunnel.com`. Its token is
   `oci_tunnel_token`.
3. `oci_*` variables in `terraform.tfvars` (see the example), then
   `terraform apply`. **Ampere capacity**: us-ashburn-1 often answers "Out of
   host capacity" in every availability domain. Retry, moving the failing
   node between domains with `oci_web_availability_domains`; capacity comes
   and goes through the day.
4. CI: repo variables `OCI_DEPLOY_ENABLED=true` and `OCIR_REGISTRY`
   (`terraform output ocir`), `production` environment secrets
   `OCIR_USERNAME` and `OCIR_TOKEN` (`terraform output -raw ocir_token`).

### Cutover order

1. Check the VMs through the test hostname: `curl
https://oci-gateway.infrawrench.com/healthz` answers `ok`, and stopping
   one VM's connector (`sudo docker stop cloudflared`) keeps it answering.
2. Point `app.infrawrench.com` at the tunnel: change its record to a proxied
   CNAME to `<tunnel id>.cfargotunnel.com`. Watch WebSocket features (a
   terminal session) and `/healthz`.
3. Set `replicas: 0` in `infra/k8s/web-deployment.yaml` and
   `github-watcher-deployment.yaml`. Leave the cluster and everything else on
   it alone.

**Rollback**: put `app.infrawrench.com` back to the proxied A record
`34.48.86.92` (the GKE ingress) and restore the replicas (web 2,
github-watcher 1). The watcher is safe to run in both places at once.

### Day-2

- **Logs**: `ssh ubuntu@<ip>` (`terraform output oci_instances`; SSH is open
  to `oci_admin_cidrs` only), then `sudo docker logs app`, `sudo docker logs
cloudflared`, `sudo journalctl -u infrawrench-agent`.
- **Configuration change**: edit `app_env` or `lambda_app_env`, `terraform
apply`; the agents restart the app within a minute.
- **Agent change**: edit `infra/oci/agent.sh`, `terraform apply`. Changes to
  `cloud-init.yaml` only reach new VMs (metadata changes are ignored).
- **OCIR storage** counts against the 20 GB Always Free object storage, and
  every deploy leaves an untagged image behind. Set an image retention policy
  (Console > Developer Services > Container Registry > the `infrawrench/*`
  repositories) that deletes untagged images after a day.

## Day-2 notes

- **Deploys are push-to-main.** Every deploy is a full image rebuild pinned to
  the commit SHA — `kubectl -n infrawrench get deploy -o wide` shows exactly
  which commit is live, and rolling back is `kustomize edit set image ...` with
  an older SHA (or revert the commit).
- **Cluster access**: `gcloud container clusters get-credentials infrawrench-prod --region us-east4`.
  Needs the `gke-gcloud-auth-plugin` component
  (`gcloud components install gke-gcloud-auth-plugin`). On a Homebrew-installed
  SDK the binary lands in `/opt/homebrew/share/google-cloud-sdk/bin` without
  being symlinked onto `PATH`, so add that directory to `PATH` or `kubectl`
  fails with "executable gke-gcloud-auth-plugin not found".
- **Secrets rotate through terraform**: edit `app_env` in `terraform.tfvars`,
  `terraform apply`, then `kubectl -n infrawrench rollout restart deploy` so
  pods pick up the new values.
- **Migrations run before rollout**, so schema changes must be
  backward-compatible with the previous release (expand → deploy → contract).
- **Scaling**: bump `replicas` in `infra/k8s/*-deployment.yaml` for web/poller;
  the node pool autoscales between the terraform `node_count_min/max`. Keep
  github-watcher at 1.
- **Image retention**: Artifact Registry keeps the 30 most recent versions per
  image and deletes anything older than 90 days. Rollback targets beyond that
  window need a rebuild.
- Terraform state is local by default — move it to a GCS backend before a
  second operator touches this.
