data "infrawrench_members" "lead" {
  email = "dana@example.com"
}

resource "infrawrench_slo" "checkout_availability" {
  name           = "Checkout availability"
  sli_kind       = "probe_availability"
  probe_id       = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"
  target_percent = 99.9
}

# Everything tagged service=checkout belongs, on any provider, plus the
# AWS resources whose names start with checkout-. A resource created tomorrow
# with the tag joins without anyone editing this block.
resource "infrawrench_service" "checkout" {
  name        = "Checkout API"
  slug        = "checkout-api"
  description = "Cart, payment and order confirmation."
  tier        = 1
  owner_team  = "Payments"

  owner_user_ids      = [data.infrawrench_members.lead.members[0].id]
  on_call_schedule_id = "1f0c2b3a-4d5e-4f60-8a71-9b2c3d4e5f60" # an infrawrench_on_call_schedule
  slo_ids             = [infrawrench_slo.checkout_availability.id]

  monthly_budget  = 4000
  budget_currency = "USD"

  link {
    label = "Grafana dashboard"
    url   = "https://grafana.example.com/d/checkout"
  }
  link {
    label = "Repository"
    url   = "https://github.com/example/checkout"
  }

  rule {
    kind  = "tag"
    key   = "service"
    value = "checkout"
  }
  rule {
    kind       = "name"
    value      = "checkout-"
    name_match = "prefix"
    plugin_id  = "aws"
  }
}
