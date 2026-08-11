resource "infrawrench_saved_filter" "platform" {
  name = "Platform team"

  filter {
    dimension = "tag"
    tag_key   = "team"
    op        = "in"
    values    = ["platform"]
  }
}

resource "infrawrench_budget" "platform" {
  name            = "Platform monthly"
  amount_cents    = 4500000 # $45,000
  currency        = "USD"
  saved_filter_id = infrawrench_saved_filter.platform.id
  cost_basis      = "amortized"

  threshold {
    type    = "actual"
    percent = 80
  }

  threshold {
    type    = "forecast"
    percent = 100
  }
}
