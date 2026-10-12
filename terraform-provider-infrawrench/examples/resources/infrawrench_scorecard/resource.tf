# The bar for customer-facing services: tier 1 and 2 only.
resource "infrawrench_scorecard" "critical" {
  name             = "Critical service readiness"
  description      = "What every tier 1 and tier 2 service needs before launch."
  applicable_tiers = [1, 2]

  check {
    type   = "has_owner"
    weight = 2
  }
  check {
    type   = "has_on_call"
    weight = 3
  }
  check {
    type                         = "slo_within_budget"
    weight                       = 3
    min_budget_remaining_percent = 10
  }
  check {
    type              = "backups_verified"
    weight            = 2
    drill_within_days = 30
  }
  check {
    type       = "no_critical_posture"
    weight     = 2
    severities = ["critical", "high"]
  }
  check {
    type = "required_tags"
    name = "Cost allocation tags"
    tags = ["team", "cost-centre"]
  }

  # Lowest first.
  level {
    key       = "bronze"
    name      = "Bronze"
    min_score = 50
    color     = "#b0793e"
  }
  level {
    key       = "silver"
    name      = "Silver"
    min_score = 75
    color     = "#9aa4ad"
  }
  level {
    key       = "gold"
    name      = "Gold"
    min_score = 90
    color     = "#d4a72c"
  }
}
