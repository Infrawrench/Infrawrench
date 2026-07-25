# Gemini chat inference through Vertex AI.
#
# The web pods call Vertex with Application Default Credentials rather than an
# API key: the `web` Kubernetes service account below is bound to a Google
# service account through Workload Identity, so the GKE metadata server mints
# short-lived tokens in-pod. Nothing secret is written to infrawrench-env and
# there is no key to rotate.
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

# The pod identity. Only `web` gets it — poller and github-watcher run no
# inference and keep using the namespace default service account.
resource "kubernetes_service_account" "web" {
  metadata {
    name      = "web"
    namespace = kubernetes_namespace.infrawrench.metadata[0].name
    annotations = {
      "iam.gke.io/gcp-service-account" = google_service_account.vertex.email
    }
  }
}

resource "google_service_account_iam_member" "web_workload_identity" {
  service_account_id = google_service_account.vertex.name
  role               = "roles/iam.workloadIdentityUser"
  member = format(
    "serviceAccount:%s.svc.id.goog[%s/%s]",
    var.project_id,
    kubernetes_namespace.infrawrench.metadata[0].name,
    kubernetes_service_account.web.metadata[0].name,
  )
}
