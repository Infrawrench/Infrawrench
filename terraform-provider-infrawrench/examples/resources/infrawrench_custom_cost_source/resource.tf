resource "infrawrench_custom_cost_source" "colo" {
  name             = "Colo invoices"
  description      = "Monthly rack and power bill, uploaded as CSV."
  default_currency = "EUR"
}

# Each source is its own provider in the cost dimensions, so a budget can
# watch it like any collected provider.
resource "infrawrench_saved_filter" "colo" {
  name = "Colo"

  filter {
    dimension = "provider"
    op        = "in"
    values    = [infrawrench_custom_cost_source.colo.plugin_id]
  }
}
