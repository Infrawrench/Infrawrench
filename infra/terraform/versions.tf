terraform {
  required_version = ">= 1.6"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
  }

  # State is local by default. For anything beyond a single operator, move it
  # to a backend (e.g. DO Spaces via the s3 backend, or Terraform Cloud).
}

provider "digitalocean" {
  token = var.do_token
}

provider "kubernetes" {
  host  = digitalocean_kubernetes_cluster.prod.endpoint
  token = digitalocean_kubernetes_cluster.prod.kube_config[0].token
  cluster_ca_certificate = base64decode(
    digitalocean_kubernetes_cluster.prod.kube_config[0].cluster_ca_certificate,
  )
}

provider "helm" {
  kubernetes {
    host  = digitalocean_kubernetes_cluster.prod.endpoint
    token = digitalocean_kubernetes_cluster.prod.kube_config[0].token
    cluster_ca_certificate = base64decode(
      digitalocean_kubernetes_cluster.prod.kube_config[0].cluster_ca_certificate,
    )
  }
}
