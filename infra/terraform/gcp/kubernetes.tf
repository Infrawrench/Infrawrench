# In-cluster plumbing the workloads (infra/k8s, applied by CI) depend on: the
# namespace and the shared app-env secret.
#
# There is no image pull secret here, unlike the DigitalOcean stack — the node
# pool's service account holds artifactregistry.reader, so kubelet pulls from
# Artifact Registry with its own identity and the deployments need no
# imagePullSecrets at all.

resource "kubernetes_namespace" "infrawrench" {
  metadata {
    name = "infrawrench"
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
