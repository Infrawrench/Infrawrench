# Production infrastructure (GCP)

Prod web stack on GKE: `web` (Hono + WebSockets, 2 replicas), `poller`
(2 replicas — safe, it claims work atomically), and `github-watcher`
(1 replica — its SHA CAS makes overlap safe, but replicas just multiply
GitHub API reads). Postgres stays on Neon, metrics on ClickHouse Cloud;
the CF Workers deployables (website, telemetry) are not part of this.

| Layer                                                                 | Owner                                       |
| --------------------------------------------------------------------- | ------------------------------------------- |
| Network, cluster, registry, namespace, secrets, ingress, cert-manager | `infra/terraform` (applied manually)        |
| Deployments, Service, Ingress, ClusterIssuer                          | `infra/k8s` (applied by CI)                 |
| Images `web` / `poller` / `github-watcher`, tagged `:<commit sha>`    | `.github/workflows/web-deploy.yml`          |
| Container registry `registry.infrawrench.com` (CF Worker + R2)        | `infra/registry` (deployed manually)        |
| Image `bastion-agent`, tagged `:<commit sha>` + `:latest`             | `.github/workflows/bastion-deploy.yml`      |
| Workflow egress proxy `egress.infrawrench.com` (CF Worker)            | `.github/workflows/egress-proxy-deploy.yml` |

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
  kube-dns, the GKE metadata server's Workload Identity endpoints, ClickHouse,
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
