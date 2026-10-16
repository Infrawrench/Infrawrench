resource "infrawrench_cost_report_folder" "platform" {
  name = "Platform"
}

# How efficiently each team's workloads use what they request, last 30 days,
# with idle capacity shared out across the teams that run on each cluster.
resource "infrawrench_kubernetes_efficiency_report" "by_team" {
  name        = "Kubernetes efficiency by team"
  folder_id   = infrawrench_cost_report_folder.platform.id
  date_preset = "30d"
  granularity = "week"

  group_by           = "label"
  group_by_label_key = "k8s_pod_label:team"
  idle               = "spread"
  basis              = "allocated"

  filter {
    dimension = "tag"
    tag_key   = "namespace"
    op        = "not_in"
    values    = ["kube-system"]
  }
}

# GPU and CPU waste per node pool in one cluster, for a fixed quarter.
resource "infrawrench_kubernetes_efficiency_report" "gpu_pools" {
  name       = "GPU pools Q3"
  date_from  = "2026-07-01"
  date_to    = "2026-09-30"
  group_by   = "node_pool"
  categories = ["gpu", "cpu"]

  filter {
    dimension = "account"
    op        = "in"
    values    = ["7b8c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e"]
  }
}
