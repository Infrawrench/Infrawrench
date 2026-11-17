variable "project_id" {
  description = "GCP project id that owns the Artifact Registry repo and the CI identity."
  type        = string
}

variable "region" {
  description = <<-EOT
    GCP region of the Artifact Registry repo, and so the first part of its
    hostname: `<region>-docker.pkg.dev/<project>/<repo>`.
  EOT
  type        = string
  default     = "us-east4"
}

variable "cluster_name" {
  description = <<-EOT
    Name prefix for the stack's resources (the Lambda functions, the session
    gateway, service accounts). It named the GKE cluster until that was
    removed on 2026-11-17, hence the variable name.
  EOT
  type        = string
  default     = "infrawrench-prod"
}

variable "repository_id" {
  description = <<-EOT
    Artifact Registry repository name. If you change this from the default,
    also update the AR_REGISTRY repository variable used by
    .github/workflows/web-deploy.yml.
  EOT
  type        = string
  default     = "infrawrench"
}

variable "github_repository" {
  description = <<-EOT
    `owner/repo` allowed to impersonate the CI service account through Workload
    Identity Federation. Only main-branch runs from this repository can push
    images — no long-lived JSON key exists to leak.
  EOT
  type        = string

  # Case-sensitive: GitHub sends the canonical casing in the OIDC claim, and a
  # mismatch fails the attribute_condition with no useful error on the CI side.
  default = "Infrawrench/Infrawrench"
}

variable "github_deploy_environment" {
  description = <<-EOT
    GitHub environment a job must declare to impersonate the CI service
    account, on top of running from refs/heads/main. The web-deploy jobs run
    under it, and its deployment branch rule (main only) is what keeps
    environment-scoped secrets such as PROD_DATABASE_URL away from other
    branches.
  EOT
  type        = string
  default     = "production"
}

variable "app_env" {
  description = <<-EOT
    Runtime environment for every runtime: the Lambda functions, the AWS
    session gateway and Oracle github-watcher (merged with lambda_app_env),
    and the edge Workers (the edge-env secret in lambda.tf). See
    terraform.tfvars.example for the full key list (DATABASE_URL, WorkOS,
    Stripe, GitHub App, encryption key, ...).
  EOT
  type        = map(string)
  sensitive   = true
}
