output "cluster_name" {
  description = "GKE cluster name — CI runs `gcloud container clusters get-credentials <this>`."
  value       = google_container_cluster.prod.name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = google_container_cluster.prod.endpoint
}

output "registry_endpoint" {
  description = "Artifact Registry path images are pushed to. Set as the AR_REGISTRY repository variable in GitHub."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.prod.repository_id}"
}

output "ci_service_account" {
  description = "Set as the GCP_SERVICE_ACCOUNT repository variable in GitHub."
  value       = google_service_account.ci.email
}

output "workload_identity_provider" {
  description = "Set as the GCP_WORKLOAD_IDENTITY_PROVIDER repository variable in GitHub."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "ingress_ip" {
  description = "Static IP the ingress load balancer answers on — the A record for app.infrawrench.com."
  value       = google_compute_address.ingress.address
}

output "egress_ip" {
  description = "Cloud NAT address every pod's outbound traffic leaves from — allowlist this in ClickHouse Cloud and Neon."
  value       = google_compute_address.nat.address
}
