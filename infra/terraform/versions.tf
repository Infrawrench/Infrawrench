terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.20"
    }
    # The Lambda gateway (lambda.tf). 6.x for `invoked_via_function_url` on
    # aws_lambda_permission, which public function URLs need since October 2025.
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.20"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Key pair for the Oracle Cloud CI user (oci.tf).
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    # The Oracle Cloud session gateway and github-watcher (oci.tf).
    oci = {
      source  = "oracle/oci"
      version = "~> 9.9"
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
