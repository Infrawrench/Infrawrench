# Ingress + TLS machinery. The chart's LoadBalancer Service provisions a GCP
# regional external passthrough load balancer, pinned to the address reserved
# in main.tf — point app.infrawrench.com's A record at that IP.

resource "helm_release" "ingress_nginx" {
  name             = "ingress-nginx"
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  namespace        = "ingress-nginx"
  create_namespace = true
  version          = "4.13.3"

  set {
    name  = "controller.replicaCount"
    value = "2"
  }

  # Reserved static IP (google_compute_address.ingress). spec.loadBalancerIP is
  # deprecated upstream in Kubernetes but is still how GKE pins a passthrough
  # LB to a reserved regional address.
  set {
    name  = "controller.service.loadBalancerIP"
    value = google_compute_address.ingress.address
  }

  # GCP passthrough LBs deliver packets with the original source IP intact, but
  # only when the receiving node also serves the pod — otherwise kube-proxy
  # SNATs on the second hop and every client looks like a node.
  set {
    name  = "controller.service.externalTrafficPolicy"
    value = "Local"
  }

  depends_on = [google_container_node_pool.default]
}

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
