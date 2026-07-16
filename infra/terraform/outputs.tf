output "cluster_name" {
  description = "DOKS cluster name — CI runs `doctl kubernetes cluster kubeconfig save <this>`."
  value       = digitalocean_kubernetes_cluster.prod.name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = digitalocean_kubernetes_cluster.prod.endpoint
}

output "registry_endpoint" {
  description = "DOCR endpoint images are pushed to (registry.digitalocean.com/<name>)."
  value       = digitalocean_container_registry.prod.endpoint
}

output "dns_next_step" {
  description = "Manual step: ingress LB IP for the app domain."
  value       = "Point app.infrawrench.com (A record) at: kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}'"
}
