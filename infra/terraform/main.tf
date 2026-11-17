# What is left on GCP: the Artifact Registry repo CI pushes commit-SHA-tagged
# images to (deploy-oci and deploy-aws-web copy them on to OCIR and ECR) and
# the keyless CI identity (ci.tf). Chat ran Gemini on Vertex AI until it moved
# to Claude through Cloudflare AI Gateway on 2026-11-17.
# The GKE cluster that used to run web, poller and github-watcher was removed
# on 2026-11-17; those run on AWS, AWS Lambda and Oracle Cloud now.

resource "google_project_service" "required" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])

  service = each.key

  # Leave them enabled if this config is ever destroyed (or an entry leaves
  # this list): turning one off breaks whatever else in the project uses it.
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "prod" {
  location      = var.region
  repository_id = var.repository_id
  description   = "Infrawrench production images — web, poller, github-watcher"
  format        = "DOCKER"

  # Deploys are pinned to commit SHAs and rollbacks re-point at old tags, so
  # keep a generous window of history but don't accumulate forever.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 30
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "7776000s" # 90 days
    }
  }

  depends_on = [google_project_service.required]
}
