# TLS machinery. ingress-nginx (and its regional passthrough load balancer
# and reserved address) were removed on 2026-10-13: app.infrawrench.com and
# jeeves.infrawrench.com are both served through Cloudflare Tunnels now
# (aws-web.tf, edge.tf), so nothing in the cluster takes public traffic.
# cert-manager stays installed; it requests no resources.

resource "helm_release" "cert_manager" {
  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  namespace        = "cert-manager"
  create_namespace = true
  version          = "v1.19.1"

  set {
    name  = "crds.enabled"
    value = "true"
  }

  depends_on = [google_container_node_pool.default]
}

# The letsencrypt-prod ClusterIssuer is a cert-manager CRD instance, so it
# lives in infra/k8s/cluster-issuer.yaml and is applied by CI — applying it
# from terraform would fail on the first run because the CRDs don't exist at
# plan time.
