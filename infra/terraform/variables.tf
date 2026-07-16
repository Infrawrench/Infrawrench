variable "do_token" {
  description = "DigitalOcean API token with write access (export TF_VAR_do_token=...)."
  type        = string
  sensitive   = true
}

variable "region" {
  description = "DigitalOcean region for the cluster and VPC."
  type        = string
  default     = "nyc1"
}

variable "cluster_name" {
  description = "DOKS cluster name. CI references this name to fetch a kubeconfig."
  type        = string
  default     = "infrawrench-prod"
}

variable "node_size" {
  description = "Droplet size slug for the default node pool."
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "node_count_min" {
  description = "Autoscaler floor for the default node pool."
  type        = number
  default     = 2
}

variable "node_count_max" {
  description = "Autoscaler ceiling for the default node pool."
  type        = number
  default     = 4
}

variable "registry_name" {
  description = <<-EOT
    DOCR registry name (globally unique across DigitalOcean). If you change
    this from the default, also update the image names in infra/k8s/ and the
    DOCR_NAME repository variable used by .github/workflows/web-deploy.yml.
  EOT
  type        = string
  default     = "infrawrench"
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
