# Production infrastructure (DigitalOcean)

Prod web stack on DOKS: `web` (Hono + WebSockets, 2 replicas), `poller`
(2 replicas — safe, it claims work atomically), and `github-watcher`
(1 replica — its SHA CAS makes overlap safe, but replicas just multiply
GitHub API reads). Postgres stays on Neon, metrics on ClickHouse Cloud;
the CF Workers deployables (website, telemetry) are not part of this.

| Layer                                                              | Owner                                |
| ------------------------------------------------------------------ | ------------------------------------ |
| Cluster, registry, namespace, secrets, ingress-nginx, cert-manager | `infra/terraform` (applied manually) |
| Deployments, Service, Ingress, ClusterIssuer                       | `infra/k8s` (applied by CI)          |
| Images `web` / `poller` / `github-watcher`, tagged `:<commit sha>` | `.github/workflows/web-deploy.yml`   |

## One-time bootstrap

1. **Terraform** — needs a DO API token with write access:

   ```sh
   cd infra/terraform
   cp terraform.tfvars.example terraform.tfvars   # fill in app_env
   export TF_VAR_do_token=dop_v1_...
   terraform init && terraform apply
   ```

2. **GitHub repo settings**
   - Secrets: `DIGITALOCEAN_ACCESS_TOKEN`, `PROD_DATABASE_URL`
   - Variables (only if you changed the terraform defaults): `DOCR_NAME`, `DOKS_CLUSTER`

3. **First deploy** — push to `main` (or run the `web-deploy` workflow manually).
   CI builds the three images, tags them with the commit SHA, pushes to DOCR,
   runs drizzle migrations against Neon, updates the kustomize image tags, and
   applies the manifests.

4. **DNS** — point `app.infrawrench.com` (A record) at the ingress LB:

   ```sh
   kubectl -n ingress-nginx get svc ingress-nginx-controller \
     -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
   ```

   cert-manager then issues the Let's Encrypt cert via HTTP-01 (the ACME email
   is in `infra/k8s/cluster-issuer.yaml` — change it if needed).

## Day-2 notes

- **Deploys are push-to-main.** Every deploy is a full image rebuild pinned to
  the commit SHA — `kubectl -n infrawrench get deploy -o wide` shows exactly
  which commit is live, and rolling back is `kustomize edit set image ...` with
  an older SHA (or revert the commit).
- **Secrets rotate through terraform**: edit `app_env` in `terraform.tfvars`,
  `terraform apply`, then `kubectl -n infrawrench rollout restart deploy` so
  pods pick up the new values.
- **Migrations run before rollout**, so schema changes must be
  backward-compatible with the previous release (expand → deploy → contract).
- **Scaling**: bump `replicas` in `infra/k8s/*-deployment.yaml` for web/poller;
  the node pool autoscales between the terraform `node_count_min/max`. Keep
  github-watcher at 1.
- Terraform state is local by default — move it to a remote backend before a
  second operator touches this.
