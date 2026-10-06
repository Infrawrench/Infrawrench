# The cluster end of the Cloudflare edge split (see "Cloudflare edge" in
# infra/README.md): a Cloudflare Tunnel connector that lets the web and poller
# Workers reach the in-cluster ClickHouse over a Workers VPC service binding,
# without ClickHouse ever getting a public address.
#
# Everything here is gated on `cloudflare_tunnel_token`, so a cluster that has
# not adopted the edge runs nothing extra. The Workers themselves, the
# Hyperdrive config, the queue and the VPC service are Cloudflare-side objects
# made with wrangler; the README has the commands.

variable "cloudflare_tunnel_token" {
  description = <<-EOT
    Token of the remotely-managed Cloudflare Tunnel the edge Workers reach
    ClickHouse through (the `eyJ...` string from `Networking > Tunnels > Add a
    replica`, or `cloudflared tunnel token <id>`). Empty disables the connector.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

locals {
  tunnel_enabled = var.cloudflare_tunnel_token != ""
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

# The connector needs exactly two things: ClickHouse's HTTP port, and
# Cloudflare's edge (7844 over QUIC or HTTP/2, plus 443 for the API it
# registers with). It is deliberately *not* in `app-egress`
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

    egress {
      to {
        pod_selector {
          match_labels = {
            app = "clickhouse"
          }
        }
      }
      ports {
        protocol = "TCP"
        port     = "8123"
      }
    }

    # Cluster DNS, for the Service name the VPC service points at and for
    # Cloudflare's edge hostnames. Same pair as app-egress (NodeLocal DNSCache
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
