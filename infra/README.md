# Production infrastructure (GCP)

Prod web stack on GKE: `web` (Hono + WebSockets, 2 replicas), `poller`
(2 replicas — safe, it claims work atomically), and `github-watcher`
(1 replica — its SHA CAS makes overlap safe, but replicas just multiply
GitHub API reads). Postgres stays on Neon, metrics on ClickHouse Cloud;
the CF Workers deployables (website, telemetry) are not part of this.

| Layer                                                                 | Owner                                    |
| --------------------------------------------------------------------- | ---------------------------------------- |
| Network, cluster, registry, namespace, secrets, ingress, cert-manager | `infra/terraform/gcp` (applied manually) |
| Deployments, Service, Ingress, ClusterIssuer                          | `infra/k8s` (applied by CI)              |
| Images `web` / `poller` / `github-watcher`, tagged `:<commit sha>`    | `.github/workflows/web-deploy.yml`       |
| Container registry `registry.infrawrench.com` (CF Worker + R2)        | `infra/registry` (deployed manually)     |
| Image `bastion-agent`, tagged `:<commit sha>` + `:latest`             | `.github/workflows/bastion-deploy.yml`   |

`infra/terraform/digitalocean` is the previous DOKS stack, kept only so it can
be destroyed after cutover — see [Migrating off DigitalOcean](#migrating-off-digitalocean).

## Shape of the GCP stack

- **Regional GKE cluster** in `us-east4`, REGULAR release channel, autoscaling
  between 2 and 4 `e2-standard-2` nodes **region-wide** (not per zone — a
  three-zone cluster with a per-zone floor of 2 would sit at 6 nodes).
- **Private nodes.** Nodes have no external IPs; egress leaves through Cloud
  NAT pinned to a reserved address, so the whole fleet has one stable source
  IP. The control plane endpoint stays public so GitHub Actions can reach it
  without a bastion.
- **No image pull secret.** The node pool runs as a dedicated service account
  holding `artifactregistry.reader`, so kubelet pulls with its own identity.
  (The DOKS stack needed a `docr-pull` dockerconfigjson secret; this one
  doesn't, which is why the Deployments have no `imagePullSecrets`.)
- **Keyless CI.** GitHub's OIDC token is exchanged for short-lived credentials
  on a CI service account via Workload Identity Federation, restricted to this
  repository. No GCP JSON key exists in repo secrets.
- **Static ingress IP**, reserved separately from the ingress-nginx release, so
  reinstalling the chart never changes the address DNS points at.

## One-time bootstrap

1. **Terraform** — authenticate as a principal with Owner (or Project IAM
   Admin + Kubernetes Engine Admin + Artifact Registry Admin) on the project:

   ```sh
   gcloud auth application-default login
   cd infra/terraform/gcp
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

   - Secrets: `PROD_DATABASE_URL`
   - Variables: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`,
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
   [Migrating off DigitalOcean](#migrating-off-digitalocean) for why.

## Migrating off DigitalOcean

The two stacks can run side by side; the only shared, non-duplicable thing is
the DNS record, so that's the cutover point.

`app.infrawrench.com` is an **A record proxied through Cloudflare** (zone
`infrawrench.com`). Two consequences that drive the order of operations:

- Visitors terminate TLS at Cloudflare's edge cert, not at the origin, so
  swapping the origin's certificate is not user-visible.
- cert-manager's HTTP-01 challenge cannot be satisfied before cutover: Let's
  Encrypt resolves the public name, which still points at the old origin, so
  the solver never sees the request. And if the zone's SSL/TLS mode is
  **Full (strict)**, flipping the proxied record to a cluster holding only
  ingress-nginx's self-signed default cert gives 526s _and_ keeps the
  challenge failing — a deadlock. Cutting over unproxied breaks it.

1. Bootstrap GCP through step 4 above, but **don't** move DNS yet.
2. Smoke-test against the ingress IP directly, with `curl --resolve` and the
   real Host header, so the app, the API, and WebSocket upgrade are all
   exercised. Use `-k`: the origin still has ingress-nginx's fake cert at this
   point, and that is expected, not a failure.
3. Scale the DOKS `poller` and `github-watcher` to 0, against the DO
   kubeconfig:

   ```sh
   kubectl -n infrawrench scale deploy/poller deploy/github-watcher --replicas=0
   ```

   Both write to the shared Neon database, and running them in two clusters at
   once is wasteful even though the atomic-claim and CAS logic make it safe.

4. Point the A record at the `ingress_ip` output **with the proxy off**
   (`proxied: false`, low TTL). Let's Encrypt now validates directly against
   the cluster and issues within a minute or two:

   ```sh
   kubectl -n infrawrench get certificate web-tls -w
   ```

   The origin IP is briefly exposed and unprotected during this window, so keep
   it short.

5. Once `web-tls` reports `READY=True`, turn the proxy back on
   (`proxied: true`). The origin now presents a publicly-trusted certificate,
   which satisfies Full (strict) as well as the laxer modes.
6. Leave DOKS running for a day, then tear it down:

   ```sh
   cd infra/terraform/digitalocean
   terraform destroy
   ```

   Then delete that directory and the `DIGITALOCEAN_ACCESS_TOKEN` repo secret.

Nothing in the application changed: the database is the same Neon instance
reached over plain TCP with `postgres.js`, ClickHouse Cloud is untouched, and
the images are byte-identical builds from `infra/docker/service.Dockerfile`.

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
