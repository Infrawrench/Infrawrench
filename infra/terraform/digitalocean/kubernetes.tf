# In-cluster plumbing the workloads (infra/k8s, applied by CI) depend on:
# the namespace, the registry pull secret, and the shared app-env secret.

resource "kubernetes_namespace" "infrawrench" {
  metadata {
    name = "infrawrench"
  }
}

# Long-lived read-only credentials so the cluster can pull from DOCR.
resource "digitalocean_container_registry_docker_credentials" "pull" {
  registry_name = digitalocean_container_registry.prod.name
  write         = false
}

resource "kubernetes_secret" "docr_pull" {
  metadata {
    name      = "docr-pull"
    namespace = kubernetes_namespace.infrawrench.metadata[0].name
  }
  type = "kubernetes.io/dockerconfigjson"
  data = {
    ".dockerconfigjson" = digitalocean_container_registry_docker_credentials.pull.docker_credentials
  }
}

# One shared env secret for web, poller, and github-watcher — each deployment
# mounts it wholesale via envFrom. Values come from var.app_env (tfvars).
resource "kubernetes_secret" "app_env" {
  metadata {
    name      = "infrawrench-env"
    namespace = kubernetes_namespace.infrawrench.metadata[0].name
  }
  type = "Opaque"
  data = var.app_env
}
