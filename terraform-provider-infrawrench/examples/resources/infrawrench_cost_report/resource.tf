resource "infrawrench_cost_report_folder" "platform" {
  name = "Platform"
}

resource "infrawrench_cost_report" "by_service" {
  name      = "Platform spend by service"
  folder_id = infrawrench_cost_report_folder.platform.id

  config {
    chart_type = "stacked_bar"
    binning    = "daily"
    group_by   = "service"
    top_n      = 10

    date_range {
      kind   = "relative"
      preset = "last_30_days"
    }

    filter {
      dimension = "tag"
      tag_key   = "team"
      op        = "in"
      values    = ["platform"]
    }
  }
}

# How many services were billed each quarter, drawn as a table.
resource "infrawrench_cost_report" "services_billed" {
  name = "Services billed per quarter"

  config {
    chart_type = "table"
    binning    = "quarterly"
    group_by   = "service"
    measure    = "count"

    date_range {
      kind   = "relative"
      preset = "12m"
    }
  }
}
