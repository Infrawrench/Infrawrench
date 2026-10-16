resource "infrawrench_cost_report_folder" "network" {
  name = "Network"
}

# Cross-zone and cross-region traffic out of one VPC, by flow pair, per day.
resource "infrawrench_network_flow_report" "cross_zone_pairs" {
  name            = "Cross-zone traffic by pair"
  folder_id       = infrawrench_cost_report_folder.network.id
  date_preset     = "30d"
  granularity     = "daily"
  group_by        = "pair"
  metric          = "both"
  networks        = ["vpc-0a1b2c3d4e5f60718"]
  traffic_classes = ["cross_zone", "cross_region"]
}

# Internet egress per week over a fixed window, the heaviest 50 sources.
resource "infrawrench_network_flow_report" "egress_by_source" {
  name            = "Internet egress by source"
  folder_id       = infrawrench_cost_report_folder.network.id
  date_from       = "2026-08-01"
  date_to         = "2026-09-30"
  granularity     = "weekly"
  group_by        = "source"
  metric          = "cost"
  top_n           = 50
  traffic_classes = ["internet_egress", "nat_gateway"]
  directions      = ["egress"]
}
