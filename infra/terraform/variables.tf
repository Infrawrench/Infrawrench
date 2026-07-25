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

variable "repository_id" {
  description = <<-EOT
    Artifact Registry repository name. If you change this from the default,
    also update the image names in infra/k8s/ and the AR_REPOSITORY repository
    variable used by .github/workflows/web-deploy.yml.
  EOT
  type        = string
  default     = "infrawrench"
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
