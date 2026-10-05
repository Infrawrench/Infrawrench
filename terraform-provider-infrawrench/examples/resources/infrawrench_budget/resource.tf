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

  # Emailed on top of whatever the alert routing rules decide. Member ids come
  # from data.infrawrench_members; addresses must pass the external-address
  # policy in infrawrench_alert_email_settings.
  email_addresses = ["finance@example.com"]
}

# A child budget rolls up into the one above: the parent's actual and forecast
# are the sum of its children's, measured over the parent's period.
resource "infrawrench_budget" "platform_ci" {
  name             = "Platform CI"
  amount_cents     = 500000 # $5,000
  parent_budget_id = infrawrench_budget.platform.id

  filter {
    dimension = "service"
    op        = "in"
    values    = ["CodeBuild"]
  }

  threshold {
    type    = "actual"
    percent = 100
  }
}

# A usage budget on a two-week cadence: tokens instead of money.
resource "infrawrench_budget" "llm_tokens" {
  name         = "LLM tokens per sprint"
  measure      = "usage"
  usage_unit   = "tokens"
  usage_amount = 250000000

  recurring_period {
    unit       = "week"
    interval   = 2
    start_date = "2026-10-05"
  }

  threshold {
    type    = "forecast"
    percent = 90
  }
}

# An explicit list of periods, each with its own amount.
resource "infrawrench_budget" "launch" {
  name = "Launch quarter"

  explicit_period {
    start        = "2026-10-01"
    end          = "2026-10-31"
    amount_cents = 2000000
  }

  explicit_period {
    start        = "2026-11-01"
    end          = "2026-12-31"
    amount_cents = 6000000
  }

  threshold {
    type    = "actual"
    percent = 80
  }
}
