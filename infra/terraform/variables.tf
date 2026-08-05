variable "project_id" {
  description = "GCP project id that owns the cluster, registry, and network."
  type        = string
}

variable "region" {
  description = <<-EOT
    GCP region for the cluster, network, and Artifact Registry. The cluster is
    regional (control plane replicated across the region's zones), so this is
    also what goes in the Artifact Registry hostname:
    `<region>-docker.pkg.dev/<project>/<repo>`.
  EOT
  type        = string
  default     = "us-east4"
}

variable "cluster_name" {
  description = "GKE cluster name. CI references this name to fetch credentials."
  type        = string
  default     = "infrawrench-prod"
}

variable "machine_type" {
  description = "Machine type for the default node pool (2 vCPU / 8 GB by default)."
  type        = string
  default     = "e2-standard-2"
}

variable "node_count_min" {
  description = <<-EOT
    Autoscaler floor for the default node pool, counted across the whole
    region rather than per zone — a regional cluster with a per-zone floor of
    2 would sit at 6 nodes.
  EOT
  type        = number
  default     = 2
}

variable "node_count_max" {
  description = "Autoscaler ceiling for the default node pool, region-wide."
  type        = number
  default     = 4
}

variable "clickhouse_machine_type" {
  description = <<-EOT
    Machine type for the dedicated ClickHouse node pool (one node per replica,
    two replicas). 4 vCPU / 16 GB by default — ClickHouse is memory-hungry and
    shares its node with nothing else.
  EOT
  type        = string
  default     = "e2-standard-4"
}

variable "clickhouse_disk_gb" {
  description = <<-EOT
    Size of each ClickHouse replica's data volume (pd-balanced), in GiB.
    Growing it later is an online resize (edit + apply); shrinking is not.
    The default is sized to fit the project's 500 GB regional SSD_TOTAL_GB
    quota (automated increase requests are denied on this account) — raise
    the quota before raising this meaningfully.
  EOT
  type        = number
  default     = 100
}

variable "repository_id" {
  description = <<-EOT
    Artifact Registry repository name. If you change this from the default,
    also update the image names in infra/k8s/ and the AR_REPOSITORY repository
    variable used by .github/workflows/web-deploy.yml.
  EOT
  type        = string
  default     = "infrawrench"
}

variable "build_repository_id" {
  description = <<-EOT
    Artifact Registry repository hosted Infrafile builds stage images to
    (builds.tf). Separate from var.repository_id on purpose: this one holds
    scratch images built from customer Dockerfiles and is emptied daily, and
    nothing in it is ever deployed. Its full path is the build_staging_repo
    output, which is what GCP_BUILD_STAGING_REPO wants.
  EOT
  type        = string
  default     = "infrawrench-builds"
}

variable "build_bucket_name" {
  description = <<-EOT
    GCS bucket for hosted-build sources and logs. Bucket names are globally
    unique, so leave this unset unless `<project_id>-infrawrench-builds` is
    taken. Set GCP_BUILD_STAGING_BUCKET to the build_staging_bucket output.
  EOT
  type        = string
  default     = null
}

variable "build_service_account" {
  description = <<-EOT
    The account Cloud Build runs builds as, if it is not the Compute Engine
    default. Builds are submitted without naming one, so the project's default
    applies: projects that enabled the Cloud Build API before Google's default
    service account change use the legacy
    `<project-number>@cloudbuild.gserviceaccount.com` — set that here so the
    grants in builds.tf land on the account actually doing the work. Check with
    `gcloud builds get-default-service-account`.
  EOT
  type        = string
  default     = null
}

variable "github_repository" {
  description = <<-EOT
    `owner/repo` allowed to impersonate the CI service account through Workload
    Identity Federation. Only pushes from this repository can push images or
    reach the cluster — no long-lived JSON key exists to leak.
  EOT
  type        = string

  # Case-sensitive: GitHub sends the canonical casing in the OIDC claim, and a
  # mismatch fails the attribute_condition with no useful error on the CI side.
  default = "Infrawrench/Infrawrench"
}

variable "vertex_location" {
  description = <<-EOT
    Vertex AI location for Gemini chat inference, published to the workloads as
    GOOGLE_CLOUD_LOCATION. `global` is the multi-region endpoint — widest model
    availability and the fewest capacity-driven 429s. Pin it to a single region
    only if data residency requires it; not every model is offered in every
    region.
  EOT
  type        = string
  default     = "global"
}

variable "app_env" {
  description = <<-EOT
    Runtime environment for all three services, written to the
    `infrawrench-env` k8s secret that the deployments envFrom. See
    terraform.tfvars.example for the full key list (DATABASE_URL, WorkOS,
    Stripe, ClickHouse, GitHub App, encryption key, ...).
  EOT
  type        = map(string)
  sensitive   = true
}
