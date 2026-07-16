# Production infrastructure for the Infrawrench web stack on DigitalOcean:
# a DOKS cluster running web + poller + github-watcher, and a container
# registry that CI pushes commit-SHA-tagged images to. The workloads
# themselves live in infra/k8s (kustomize) and are applied by CI — terraform
# owns the platform (cluster, registry, namespace, secrets, ingress, TLS).

data "digitalocean_kubernetes_versions" "current" {}

resource "digitalocean_vpc" "prod" {
  name   = "${var.cluster_name}-vpc"
  region = var.region
}

resource "digitalocean_kubernetes_cluster" "prod" {
  name     = var.cluster_name
  region   = var.region
  version  = data.digitalocean_kubernetes_versions.current.latest_version
  vpc_uuid = digitalocean_vpc.prod.id

  auto_upgrade  = true
  surge_upgrade = true

  maintenance_policy {
    day        = "sunday"
    start_time = "04:00"
  }

  node_pool {
    name       = "default"
    size       = var.node_size
    auto_scale = true
    min_nodes  = var.node_count_min
    max_nodes  = var.node_count_max
  }

  # auto_upgrade patches the cluster outside terraform; don't fight it.
  lifecycle {
    ignore_changes = [version]
  }
}

resource "digitalocean_container_registry" "prod" {
  name                   = var.registry_name
  subscription_tier_slug = "basic" # 5 repos — web, poller, github-watcher fit
  region                 = var.region
}

resource "digitalocean_project" "prod" {
  name        = "infrawrench-prod"
  description = "Infrawrench production web stack"
  purpose     = "Web Application"
  environment = "Production"
  resources   = [digitalocean_kubernetes_cluster.prod.urn]
}
