# Hosted Docker builds for Infrafile web deploys.
#
# Builds run on Cloud Build — Google-managed workers — rather than in this
# cluster, and that is the whole point of the file. A Dockerfile's `RUN` is
# arbitrary customer code with network access, so an in-cluster build would sit
# one `curl` from the GKE metadata server (node service-account credentials) and
# every other pod in the VPC. Cloud Build has no path back here, so the
# isolation is structural instead of something a NetworkPolicy has to keep
# getting right.
#
# The runtime side is app/packages/server-core/src/infrafile/build-cloud.ts,
# which reads GCP_BUILD_PROJECT_ID / _STAGING_BUCKET / _STAGING_REPO / _REGION
# out of var.app_env. The outputs in outputs.tf print the exact values to paste
# there. Without them the web app simply reports that hosted builds are
# unavailable, so this whole file is optional.

data "google_project" "this" {
  project_id = var.project_id
}

# artifactregistry.googleapis.com is already in google_project_service.required
# (main.tf) for the production image repo, so only these two are new.
resource "google_project_service" "builds" {
  for_each = toset([
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
  ])

  service = each.key

  # Same reasoning as main.tf: a `terraform destroy` should not be able to take
  # the API down underneath anything still running.
  disable_on_destroy = false
}

locals {
  build_bucket = coalesce(var.build_bucket_name, "${var.project_id}-infrawrench-builds")

  # The web pods' Workload Identity account. It is named for Vertex because
  # inference was the first thing to need it (vertex.tf), but it is the single
  # Google identity the `web` deployment runs as — hosted builds get the same
  # keyless treatment rather than a JSON key of their own.
  build_caller = "serviceAccount:${google_service_account.vertex.email}"

  # Which account a build itself runs as depends on when the project was
  # created: projects that enabled the Cloud Build API before Google's default
  # service account change use the legacy
  # PROJECT_NUMBER@cloudbuild.gserviceaccount.com, newer ones fall back to the
  # Compute Engine default account. build-cloud.ts submits builds without
  # naming one, so var.build_service_account is how an older project points the
  # grants below at the right principal.
  build_service_account = coalesce(
    var.build_service_account,
    "${data.google_project.this.number}-compute@developer.gserviceaccount.com",
  )
}

# ---------------------------------------------------------------------------
# Staging bucket
# ---------------------------------------------------------------------------

# Two things live here: the source tarball a deploy uploads for Cloud Build to
# extract into /workspace, and the build's log — builds run with
# `logging: GCS_ONLY`, so this bucket holds the only copy of it, and run()
# reads it back to recover the command's stdout.
resource "google_storage_bucket" "builds" {
  name     = local.build_bucket
  location = var.region

  # Both are scratch: read minutes after they are written and never again. A
  # short TTL keeps this from growing without bound, and — since the tarballs
  # are customer source — keeps other people's code from accumulating in our
  # project indefinitely.
  lifecycle_rule {
    condition {
      age = 3
    }
    action {
      type = "Delete"
    }
  }

  # Soft delete would retain those same tarballs for a week past the TTL above,
  # billed and readable, which defeats the point of having a TTL at all.
  soft_delete_policy {
    retention_duration_seconds = 0
  }

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Nothing in here outlives the lifecycle rule, so it should never be the
  # reason a destroy fails.
  force_destroy = true

  depends_on = [google_project_service.builds]
}

# ---------------------------------------------------------------------------
# Staging repository
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "builds" {
  location      = var.region
  repository_id = var.build_repository_id
  description   = "Scratch images for hosted Infrafile builds — pulled by run() steps, never deployed"
  format        = "DOCKER"

  # Every hosted build pushes its image here even when the Infrafile publishes
  # nowhere, because a Cloud Build step pulls its image from a registry and an
  # image built on one worker does not exist on the next one. The deployed
  # image still goes to the customer's own registry; this is only how a later
  # run() step in the same deploy gets something to pull.
  #
  # build-cloud.ts deletes the tag when the deploy finishes, but that is best
  # effort — a pod killed mid-deploy never gets there. One day is far past the
  # 20-minute build timeout, so anything this policy catches is orphaned.
  cleanup_policies {
    id     = "delete-stale"
    action = "DELETE"
    condition {
      older_than = "86400s" # 1 day
    }
  }

  depends_on = [google_project_service.builds]
}

# ---------------------------------------------------------------------------
# What the web pods may do
# ---------------------------------------------------------------------------

# cloudbuild.builds.create is authorized against the project, so this one
# cannot be narrowed. builds.editor is still short of builds.builder — it can
# submit and watch builds, not act as the build account.
resource "google_project_iam_member" "web_cloudbuild" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = local.build_caller

  depends_on = [google_project_service.builds]
}

# Bucket-scoped rather than project-wide: the pods upload source and read logs
# back, and have no business anywhere else in the project's storage.
resource "google_storage_bucket_iam_member" "web_builds_bucket" {
  bucket = google_storage_bucket.builds.name
  role   = "roles/storage.objectAdmin"
  member = local.build_caller
}

# repoAdmin, not writer, and only on this repo. The pods never push — the build
# worker does — but they do delete the staged tag after each deploy, and
# artifactregistry.tags.delete is in repoAdmin only. With writer that cleanup
# would 403 silently and the policy above would be doing all the work.
resource "google_artifact_registry_repository_iam_member" "web_staging_repo" {
  location   = google_artifact_registry_repository.builds.location
  repository = google_artifact_registry_repository.builds.name
  role       = "roles/artifactregistry.repoAdmin"
  member     = local.build_caller
}

# ---------------------------------------------------------------------------
# Per-build secrets
# ---------------------------------------------------------------------------

# A build that publishes has to authenticate to the customer's registry, and a
# run() step may carry credentials of its own. Neither can be passed as a step
# argument: Cloud Build records a step's args in *our* project's build history
# permanently, so a `docker login --password <value>` would leave a customer's
# credential sitting in our logs. So build-cloud.ts creates a Secret Manager
# secret per build (per variable, for run()), references it by name from
# availableSecrets so only the worker ever sees the value, and destroys it in a
# `finally` — the credential outlives neither the build nor a failure of it.
#
# roles/secretmanager.admin would cover that, but it also carries
# secretmanager.versions.access and secrets.setIamPolicy: the web pods could
# read the payload of every secret in the project and grant others the same.
# They only ever write, so these custom roles drop both.

locals {
  # Must match the secretId build-cloud.ts generates: `infrawrench-deploy-<uuid>`.
  build_secret_prefix = "infrawrench-deploy-"

  # Secret Manager normalizes a secret's resource name to the project *number*.
  # The id form is accepted too, because a wrong condition here does not fail
  # loudly — it fails as a bare 403 in the middle of a customer's deploy.
  build_secret_condition = format(
    "resource.name.startsWith('projects/%s/secrets/%s') || resource.name.startsWith('projects/%s/secrets/%s')",
    data.google_project.this.number,
    local.build_secret_prefix,
    var.project_id,
    local.build_secret_prefix,
  )
}

resource "google_project_iam_custom_role" "build_secret_create" {
  project     = var.project_id
  role_id     = "infrawrenchBuildSecretCreate"
  title       = "Infrawrench hosted build — create a build secret"
  description = "Create an empty Secret Manager secret. Held separately because create cannot be name-scoped."
  permissions = ["secretmanager.secrets.create"]
}

resource "google_project_iam_custom_role" "build_secret_manage" {
  project     = var.project_id
  role_id     = "infrawrenchBuildSecretManage"
  title       = "Infrawrench hosted build — write and destroy a build secret"
  description = "Add a version to, and delete, a per-build secret. Cannot read any payload."
  permissions = [
    "secretmanager.secrets.delete",
    "secretmanager.versions.add",
  ]
}

# Unscoped by necessity: the secret being created does not exist yet, so there
# is no resource name to condition on. Splitting create out is what makes that
# tolerable — on its own, this role can produce empty secrets and nothing else.
resource "google_project_iam_member" "web_secret_create" {
  project = var.project_id
  role    = google_project_iam_custom_role.build_secret_create.id
  member  = local.build_caller
}

# Writing and destroying name a secret that already exists, so they are
# confined to the ones this feature creates.
resource "google_project_iam_member" "web_secret_manage" {
  project = var.project_id
  role    = google_project_iam_custom_role.build_secret_manage.id
  member  = local.build_caller

  condition {
    title       = "Per-build secrets only"
    description = "Secrets named by build-cloud.ts (${local.build_secret_prefix}<uuid>)."
    expression  = local.build_secret_condition
  }
}

# ---------------------------------------------------------------------------
# What the build worker may do
# ---------------------------------------------------------------------------

# The worker reads the uploaded source and writes the build log back.
resource "google_storage_bucket_iam_member" "builder_bucket" {
  bucket = google_storage_bucket.builds.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${local.build_service_account}"
}

# Pushing the staged image is the only registry access a build needs. It never
# deletes, so writer rather than the repoAdmin the pods hold.
resource "google_artifact_registry_repository_iam_member" "builder_staging_repo" {
  location   = google_artifact_registry_repository.builds.location
  repository = google_artifact_registry_repository.builds.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${local.build_service_account}"
}

# A per-build secret is created and abandoned with no IAM policy of its own, so
# the worker's read access has to be granted at the project. The condition is
# what keeps a build running a stranger's Dockerfile from reading anything else
# we ever put in Secret Manager.
resource "google_project_iam_member" "builder_secret_access" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${local.build_service_account}"

  condition {
    title       = "Per-build secrets only"
    description = "Secrets named by build-cloud.ts (${local.build_secret_prefix}<uuid>)."
    expression  = local.build_secret_condition
  }
}
