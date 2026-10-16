# The open findings worth an afternoon: production, over $100 a month, biggest
# first. Opens from the view picker on Costs > Savings and from
# `infrawrench savings findings --view "Production waste"`.
resource "infrawrench_savings_view" "production_waste" {
  name        = "Production waste"
  description = "Open findings on production over $100 a month."
  status      = "open"

  kinds               = ["orphan", "oversized"]
  min_monthly_savings = 100

  tag {
    key    = "env"
    values = ["prod", "production"]
  }

  sort_field     = "savings"
  sort_direction = "desc"
}
