# Production infrastructure for the Infrawrench web stack on GCP: a regional
# GKE cluster running web + poller + github-watcher, and an Artifact Registry
# repo that CI pushes commit-SHA-tagged images to. The workloads themselves
# live in infra/k8s (kustomize) and are applied by CI — terraform owns the
# platform (network, cluster, registry, namespace, secrets, ingress, TLS).

resource "google_project_service" "required" {
  for_each = toset([
    "compute.googleapis.com",
    "container.googleapis.com",
    "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])

  service = each.key

  # Turning these off would tear down the cluster; leave them enabled if this
  # config is ever destroyed.
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

resource "google_compute_network" "prod" {
  name                    = "${var.cluster_name}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
}

# Pods and Services get secondary ranges so GKE can run VPC-native (alias IP),
# which is required for private nodes.
resource "google_compute_subnetwork" "prod" {
  name          = "${var.cluster_name}-subnet"
  network       = google_compute_network.prod.id
  region        = var.region
  ip_cidr_range = "10.0.0.0/20"

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.4.0.0/14"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.8.0.0/20"
  }

  private_ip_google_access = true
}

# Nodes have no external IPs, so all egress leaves through Cloud NAT. Pinning
# it to a reserved address gives the fleet one stable source IP — that is the
# address to allowlist in ClickHouse Cloud and Neon.
resource "google_compute_address" "nat" {
  name         = "${var.cluster_name}-nat"
  region       = var.region
  address_type = "EXTERNAL"
}

resource "google_compute_router" "prod" {
  name    = "${var.cluster_name}-router"
  region  = var.region
  network = google_compute_network.prod.id
}

resource "google_compute_router_nat" "prod" {
  name                               = "${var.cluster_name}-nat"
  router                             = google_compute_router.prod.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat.self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Reserved in advance so the ingress load balancer's address survives a
# reinstall of the ingress-nginx release — DNS for app.infrawrench.com points
# here and shouldn't have to change again.
resource "google_compute_address" "ingress" {
  name         = "${var.cluster_name}-ingress"
  region       = var.region
  address_type = "EXTERNAL"
}

# ---------------------------------------------------------------------------
# Cluster
# ---------------------------------------------------------------------------

# Least-privilege identity for the nodes themselves: enough to pull images and
# ship logs/metrics, nothing more. (The default compute service account
# carries project Editor, which nodes have no business holding.)
resource "google_service_account" "nodes" {
  account_id   = "${var.cluster_name}-nodes"
  display_name = "GKE node pool — ${var.cluster_name}"
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/artifactregistry.reader",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
  ])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_container_cluster" "prod" {
  name     = var.cluster_name
  location = var.region

  network    = google_compute_network.prod.id
  subnetwork = google_compute_subnetwork.prod.id

  # The default pool exists only long enough to create the cluster; the real
  # one is google_container_node_pool.default below.
  remove_default_node_pool = true
  initial_node_count       = 1

  deletion_protection = true

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Nodes are private (no external IPs); the control plane endpoint stays
  # public so GitHub Actions can reach it without a bastion or VPN.
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  maintenance_policy {
    recurring_window {
      # Sundays 04:00–08:00 UTC, matching the old DOKS window.
      start_time = "2025-01-05T04:00:00Z"
      end_time   = "2025-01-05T08:00:00Z"
      recurrence = "FREQ=WEEKLY;BYDAY=SU"
    }
  }

  # The REGULAR channel patches the control plane outside terraform; don't
  # fight it.
  lifecycle {
    ignore_changes = [min_master_version]
  }

  depends_on = [google_project_service.required]
}

resource "google_container_node_pool" "default" {
  name     = "default"
  cluster  = google_container_cluster.prod.id
  location = var.region

  # Region-wide bounds rather than per-zone: a regional cluster spans three
  # zones, so a per-zone min of 2 would floor the pool at 6 nodes.
  autoscaling {
    total_min_node_count = var.node_count_min
    total_max_node_count = var.node_count_max
    location_policy      = "BALANCED"
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type    = var.machine_type
    disk_size_gb    = 50
    disk_type       = "pd-balanced"
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  # The autoscaler owns the node count after creation.
  lifecycle {
    ignore_changes = [node_count]
  }
}

# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "prod" {
  location      = var.region
  repository_id = var.repository_id
  description   = "Infrawrench production images — web, poller, github-watcher"
  format        = "DOCKER"

  # Deploys are pinned to commit SHAs and rollbacks re-point at old tags, so
  # keep a generous window of history but don't accumulate forever.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 30
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "7776000s" # 90 days
    }
  }

  depends_on = [google_project_service.required]
}
