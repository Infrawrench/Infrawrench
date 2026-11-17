# The cluster's Cloudflare Tunnel connector, which publishes
# jeeves.infrawrench.com without a load balancer or a public address. It once
# also carried the edge Workers' private route to the in-cluster ClickHouse,
# which is gone now that the analytics tables live in Postgres.
#
# Everything here is gated on `cloudflare_tunnel_token`, so a cluster without
# a tunnel runs nothing extra. The tunnel and its routes are Cloudflare-side
# objects; the README has the commands.

variable "cloudflare_tunnel_token" {
  description = <<-EOT
    Token of the remotely-managed Cloudflare Tunnel whose connector runs in
    the cluster (the `eyJ...` string from `Networking > Tunnels > Add a
    replica`, or `cloudflared tunnel token <id>`). Empty disables the connector.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

locals {
  tunnel_enabled = var.cloudflare_tunnel_token != ""

  # kubelet probes come from the node, not a pod, so only the node subnet can
  # express them. The Calico addon does not exempt them the way Dataplane V2
  # does, and a blocked probe restarts the pod.
  node_cidr = google_compute_subnetwork.prod.ip_cidr_range
}

resource "kubernetes_secret" "cloudflared" {
  count = local.tunnel_enabled ? 1 : 0

  metadata {
    name      = "cloudflared-tunnel"
    namespace = kubernetes_namespace.infrawrench.metadata[0].name
  }
  type = "Opaque"
  data = {
    token = var.cloudflare_tunnel_token
  }
}

resource "kubernetes_deployment_v1" "cloudflared" {
  count = local.tunnel_enabled ? 1 : 0

  metadata {
    name      = "cloudflared"
    namespace = kubernetes_namespace.infrawrench.metadata[0].name
    labels = {
      app = "cloudflared"
    }
  }

  spec {
    # Two connectors: a Tunnel survives losing one, and Cloudflare spreads
    # requests across every healthy replica.
    replicas = 2

    selector {
      match_labels = {
        app = "cloudflared"
      }
    }

    template {
      metadata {
        labels = {
          app = "cloudflared"
        }
        annotations = {
          # Roll the pods when the token rotates.
          "infrawrench.com/token-hash" = sha256(var.cloudflare_tunnel_token)
        }
      }

      spec {
        automount_service_account_token = false

        security_context {
          run_as_non_root = true
          # The image's own nonroot user.
          run_as_user  = 65532
          run_as_group = 65532
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name = "cloudflared"
          # Pinned: `latest` would change the connector under a running cluster.
          image = "cloudflare/cloudflared:2026.10.0"
          args = [
            "tunnel",
            "--no-autoupdate",
            "--loglevel", "info",
            "--output", "json",
            "--metrics", "0.0.0.0:2000",
            "run",
          ]

          env {
            name = "TUNNEL_TOKEN"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.cloudflared[0].metadata[0].name
                key  = "token"
              }
            }
          }

          security_context {
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            capabilities {
              drop = ["ALL"]
            }
          }

          resources {
            requests = {
              cpu    = "50m"
              memory = "64Mi"
            }
            limits = {
              memory = "256Mi"
            }
          }

          # /ready is 200 only while the connector holds a live connection to
          # Cloudflare's edge.
          readiness_probe {
            http_get {
              path = "/ready"
              port = 2000
            }
            period_seconds = 10
          }
          liveness_probe {
            http_get {
              path = "/ready"
              port = 2000
            }
            initial_delay_seconds = 15
            period_seconds        = 10
            failure_threshold     = 6
          }
        }
      }
    }
  }
}

# The connector needs exactly two things: jeeves's HTTP port and Cloudflare's
# edge (7844 over QUIC or HTTP/2, plus 443 for the API it registers with). It is deliberately *not* in `app-egress`
# (infra/k8s/network-policy.yaml): that policy opens the public internet to
# the app pods, which this pod has no reason to reach.
resource "kubernetes_network_policy_v1" "cloudflared" {
  count = local.tunnel_enabled ? 1 : 0

  metadata {
    name      = "cloudflared"
    namespace = kubernetes_namespace.infrawrench.metadata[0].name
  }

  spec {
    pod_selector {
      match_labels = {
        app = "cloudflared"
      }
    }
    policy_types = ["Ingress", "Egress"]

    # kubelet probes come from the node subnet.
    ingress {
      from {
        ip_block {
          cidr = local.node_cidr
        }
      }
      ports {
        protocol = "TCP"
        port     = "2000"
      }
    }

    # jeeves.infrawrench.com is a route on this tunnel too (since
    # 2026-10-13, when ingress-nginx and its load balancer were removed):
    # the jeeves Service's pods on 8080.
    egress {
      to {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "jeeves"
          }
        }
        pod_selector {
          match_labels = {
            app = "jeeves"
          }
        }
      }
      ports {
        protocol = "TCP"
        port     = "8080"
      }
    }

    # Cluster DNS, for the jeeves Service name and for Cloudflare's edge
    # hostnames. Same pair as app-egress (NodeLocal DNSCache
    # intercepts the kube-dns ClusterIP on the node).
    egress {
      to {
        ip_block {
          cidr = "10.8.0.10/32"
        }
      }
      to {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "kube-system"
          }
        }
        pod_selector {
          match_labels = {
            "k8s-app" = "kube-dns"
          }
        }
      }
      ports {
        protocol = "UDP"
        port     = "53"
      }
      ports {
        protocol = "TCP"
        port     = "53"
      }
    }

    egress {
      to {
        ip_block {
          cidr = "0.0.0.0/0"
          except = [
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "100.64.0.0/10",
            "169.254.0.0/16",
          ]
        }
      }
      ports {
        protocol = "TCP"
        port     = "7844"
      }
      ports {
        protocol = "UDP"
        port     = "7844"
      }
      ports {
        protocol = "TCP"
        port     = "443"
      }
    }
  }
}
