# Gemini chat inference through Vertex AI.
#
# The provider calls Vertex with Application Default Credentials rather than an
# API key. The GKE `web` pods got them through Workload Identity, bound to the
# service account below; that binding went with the cluster on 2026-11-17, and
# the runtimes that replaced the pods (AWS, Lambda, the edge Workers) have no
# Google credentials yet, so the account is kept for whatever federation gives
# them some.
#
# Vertex (not the AI Studio developer API) is also what makes this spend
# eligible for Google Cloud credits and committed-use discounts — Gemini
# Developer API usage is excluded from Cloud welcome/free-trial credits.

resource "google_service_account" "vertex" {
  account_id   = "${var.cluster_name}-vertex"
  display_name = "Vertex AI inference — ${var.cluster_name} web"
}

# aiplatform.user covers predict/streamGenerateContent. Deliberately not
# aiplatform.admin: the workload only ever calls models, never manages
# endpoints, datasets, or tuning jobs.
resource "google_project_iam_member" "vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.vertex.email}"
}
