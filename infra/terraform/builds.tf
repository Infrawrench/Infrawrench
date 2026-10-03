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
# Cloud Build has a metadata server of its own, though, and every step can mint
# a token for the account the build runs as. The customer decides what the
# steps run, so that account is effectively theirs for the length of the build,
# and every tenant's build runs as the same one. Hence the shape of the grants
# below: the build account can read no other build's anything. It holds no
# storage, registry or project-wide Secret Manager access; source, the staged
# image and run() output move through per-object signed URLs the web pods mint,
# and each per-build secret is bound to it individually.
#
# The runtime side is app/packages/server-core/src/infrafile/build-cloud.ts,
# which reads GCP_BUILD_PROJECT_ID / _STAGING_BUCKET / _SERVICE_ACCOUNT /
# _REGION out of var.app_env. The outputs in outputs.tf print the exact values
# to paste there. Without them the web app simply reports that hosted builds
# are unavailable, so this whole file is optional.

data "google_project" "this" {
  project_id = var.project_id
}

# iamcredentials.googleapis.com (signBlob, for the signed URLs) is already in
# google_project_service.required (main.tf), so only these are new.
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

  build_worker = "serviceAccount:${google_service_account.build.email}"
}

# ---------------------------------------------------------------------------
# The account builds run as
# ---------------------------------------------------------------------------

# Dedicated, and named on every submission (`serviceAccount` in build-cloud.ts).
# Left to itself Cloud Build runs as the project default: the legacy Cloud
# Build account or the Compute Engine default, either of which is shared with
# everything else in the project, and the latter of which is granted project
# Editor on creation in most projects. A customer build holding Editor could
# read and overwrite anything here.
#
# MANUAL STEP: this config does not, and should not blindly, take Editor away
# from `<project-number>-compute@developer.gserviceaccount.com`; other things
# outside Terraform may run as it. Once hosted builds run as this account,
# check what else uses the default one and remove its Editor binding by hand.
# See infra/README.md.
resource "google_service_account" "build" {
  account_id   = "${var.cluster_name}-build"
  display_name = "Hosted Infrafile builds: runs customer Dockerfiles, holds no data access"
}

# The one project-level grant, and it is write-only: logEntries.create cannot be
# granted below the project. Cloud Build insists on an explicit log destination
# once a build names its own account, and Cloud Logging is the one that costs no
# isolation. The alternative, a logs bucket, needs the build account to hold
# storage access there, which would let one customer's build read another's
# log. A build can add log entries to this project and read none of them.
resource "google_project_iam_member" "builder_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = local.build_worker
}

# Submitting a build that runs as another account is acting as that account,
# so the web pods need actAs on this one. Granted on the account itself, not
# the project, so the pods cannot act as anything else.
resource "google_service_account_iam_member" "web_act_as_builder" {
  service_account_id = google_service_account.build.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.build_caller
}

# ---------------------------------------------------------------------------
# Staging bucket
# ---------------------------------------------------------------------------

# Everything a deploy stages: the source tarball, the `docker save` of the
# built image that later run() builds load, and each run()'s captured output.
# The build account has no access to any of it. The web pods write the source
# and read the output with their own credential, and hand each build signed
# URLs for exactly the objects it needs, so a build that reads its own token
# still cannot see another deploy's source or swap out its image.
resource "google_storage_bucket" "builds" {
  name     = local.build_bucket
  location = var.region

  # All of it is scratch, deleted when the deploy finishes. A short TTL is the
  # backstop for a pod killed mid-deploy, and, since the tarballs are customer
  # source, keeps other people's code from accumulating in our project.
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

# Bucket-scoped rather than project-wide: the pods stage and clean up objects
# here, and have no business anywhere else in the project's storage. A signed
# URL carries its signer's authority, so this is also what the URLs handed to
# builds can do, one object and one method at a time.
resource "google_storage_bucket_iam_member" "web_builds_bucket" {
  bucket = google_storage_bucket.builds.name
  role   = "roles/storage.objectAdmin"
  member = local.build_caller
}

# Signing those URLs. On GKE the pods have no private key, so the IAM
# Credentials API signs for them, and that takes signBlob on their own account
# even when it is signing as itself.
resource "google_service_account_iam_member" "web_sign_urls" {
  service_account_id = google_service_account.vertex.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.build_caller
}

# ---------------------------------------------------------------------------
# Per-build secrets
# ---------------------------------------------------------------------------

# A build that publishes has to authenticate to the customer's registry, and a
# run() step may carry credentials of its own. Neither can be passed as a step
# argument: Cloud Build records a step's args in *our* project's build history
# permanently, so a `docker login --password <value>` would leave a customer's
# credential sitting in our logs. So build-cloud.ts creates a Secret Manager
# secret per build (per variable, for run()), binds the build account to that
# one secret, references it by name from availableSecrets so only the worker
# ever sees the value, and destroys it in a `finally`; a TTL on the secret is
# the backstop.
#
# roles/secretmanager.admin would cover that, but it also carries
# secretmanager.versions.access: the web pods could read the payload of every
# secret in the project. They only ever write, so these custom roles drop it.

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

# setIamPolicy is how each secret is shared with the build account and nothing
# else. It is confined to these secrets by the condition below, so the pods can
# grant access to the credentials they staged and to no other secret.
resource "google_project_iam_custom_role" "build_secret_manage" {
  project     = var.project_id
  role_id     = "infrawrenchBuildSecretManage"
  title       = "Infrawrench hosted build: write, share and destroy a build secret"
  description = "Add a version to, bind the build account to, and delete a per-build secret. Cannot read any payload."
  permissions = [
    "secretmanager.secrets.delete",
    "secretmanager.secrets.setIamPolicy",
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

# Writing, sharing and destroying name a secret that already exists, so they
# are confined to the ones this feature creates.
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

# There is deliberately no project-level secretAccessor for the build account,
# not even one conditioned on the name prefix. Every tenant's build runs as the
# same account, so a prefix grant would let any build read any other build's
# credential by name. The per-secret binding build-cloud.ts adds is the only
# way the account reads a secret, and it has no secrets.list to discover one.
