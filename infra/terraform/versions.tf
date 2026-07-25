terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.20"
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
  # to a GCS backend (`backend "gcs" { bucket = ... }`) — the bucket has to be
  # created outside this config, so it's a deliberate second step.
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# GKE's API server takes an OAuth2 access token rather than a static
# kubeconfig; this data source mints one from whatever credentials terraform
# is already running as (gcloud ADC).
data "google_client_config" "default" {}

provider "kubernetes" {
  host                   = "https://${google_container_cluster.prod.endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(google_container_cluster.prod.master_auth[0].cluster_ca_certificate)
}

provider "helm" {
  kubernetes {
    host                   = "https://${google_container_cluster.prod.endpoint}"
    token                  = data.google_client_config.default.access_token
    cluster_ca_certificate = base64decode(google_container_cluster.prod.master_auth[0].cluster_ca_certificate)
  }
}
