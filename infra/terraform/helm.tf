# Ingress + TLS machinery. The chart's LoadBalancer Service provisions a DO
# load balancer automatically; point app.infrawrench.com's DNS at its IP
# (kubectl -n ingress-nginx get svc ingress-nginx-controller).

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

  # Preserve client IPs and let the DO LB health-check the controller.
  set {
    name  = "controller.service.annotations.service\\.beta\\.kubernetes\\.io/do-loadbalancer-enable-proxy-protocol"
    value = "true"
    type  = "string"
  }
  set {
    name  = "controller.config.use-proxy-protocol"
    value = "true"
    type  = "string"
  }

  depends_on = [digitalocean_kubernetes_cluster.prod]
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

  depends_on = [digitalocean_kubernetes_cluster.prod]
}

# The letsencrypt-prod ClusterIssuer is a cert-manager CRD instance, so it
# lives in infra/k8s/cluster-issuer.yaml and is applied by CI — applying it
# from terraform would fail on the first run because the CRDs don't exist at
# plan time.
