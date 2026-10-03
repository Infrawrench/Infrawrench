# Keyless CI auth. GitHub Actions presents its OIDC token to GCP's STS, which
# swaps it for a short-lived credential on the service account below — no JSON
# key exists to leak or rotate. Only main-branch jobs in var.github_repository
# that run under the var.github_deploy_environment GitHub environment can do it
# (attribute_condition), and the account can do exactly two things: push to
# the Artifact Registry repo, and talk to the cluster.

resource "google_service_account" "ci" {
  account_id   = "${var.cluster_name}-ci"
  display_name = "GitHub Actions — build, push, deploy"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # Without the repository check the provider would trust every repository on
  # GitHub. Without the ref and environment checks it would trust every branch
  # of this one: anyone who can push a branch could add a workflow that mints
  # a token, and the CI account can read cluster Secrets and roll out any
  # image. `ref` is set by GitHub from the triggering event, so a workflow file
  # cannot forge it; `environment` is only present when the job declares one,
  # and the environment's deployment branch rule limits which refs may enter
  # it. A missing claim makes the expression error, which STS treats as a
  # denial.
  attribute_condition = join(" && ", [
    "assertion.repository == '${var.github_repository}'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == '${var.github_deploy_environment}'",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "ci_impersonation" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

resource "google_artifact_registry_repository_iam_member" "ci_push" {
  location   = google_artifact_registry_repository.prod.location
  repository = google_artifact_registry_repository.prod.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.ci.email}"
}

# container.developer is namespace-level Kubernetes access (apply manifests,
# read rollout status) without the ability to reshape the cluster itself.
resource "google_project_iam_member" "ci_cluster" {
  project = var.project_id
  role    = "roles/container.developer"
  member  = "serviceAccount:${google_service_account.ci.email}"
}
