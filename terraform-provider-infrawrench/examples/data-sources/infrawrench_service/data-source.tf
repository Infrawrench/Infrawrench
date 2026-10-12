# Look a service up by slug (or by id) to build on one managed elsewhere.
data "infrawrench_service" "checkout" {
  slug = "checkout-api"
}

# Fail the plan if a tier 1 service has nobody on call.
resource "terraform_data" "checkout_has_on_call" {
  lifecycle {
    precondition {
      condition     = data.infrawrench_service.checkout.tier != 1 || data.infrawrench_service.checkout.on_call_schedule_id != null
      error_message = "Tier 1 services need an on-call schedule."
    }
  }
}
