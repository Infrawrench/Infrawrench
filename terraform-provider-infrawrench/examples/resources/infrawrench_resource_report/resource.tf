resource "infrawrench_cost_report_folder" "platform" {
  name = "Platform"
}

# Every production EC2 instance and RDS database, most expensive first, with
# the owning team and last month's spend beside this month's.
resource "infrawrench_resource_report" "prod_compute" {
  name      = "Production compute by cost"
  folder_id = infrawrench_cost_report_folder.platform.id

  columns = [
    "core:name",
    "core:type",
    "core:account",
    "core:region",
    "field:instanceType",
    "tag:team",
    "cost:mtd",
    "cost:previous_month",
  ]
  sort_column    = "cost:mtd"
  sort_direction = "desc"

  plugin_ids = ["aws"]

  resource_type {
    plugin_id        = "aws"
    resource_type_id = "ec2-instance"
  }
  resource_type {
    plugin_id        = "aws"
    resource_type_id = "rds-instance"
  }

  tag_filter {
    source = "tag"
    key    = "env"
    op     = "in"
    values = ["prod", "production"]
  }
}

# Untagged resources created this year, for a tagging clean-up.
resource "infrawrench_resource_report" "untagged" {
  name         = "Untagged since January"
  columns      = ["core:name", "core:provider", "core:account", "core:created", "cost:range"]
  created_from = "2026-01-01"

  cost_range_preset = "90d"

  tag_filter {
    source = "tag"
    key    = "team"
    op     = "missing"
  }
}
