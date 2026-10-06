# Mirror PagerDuty incidents into Infrawrench. PagerDuty's webhook is
# subscribed automatically when inbound is turned on.
resource "infrawrench_paging_provider_settings" "pagerduty" {
  account_id      = var.pagerduty_account_id
  inbound_enabled = true
}

# incident.io has no API for webhook endpoints: add the webhook_url output as
# an endpoint in incident.io (Settings > Webhooks) and pass its signing secret.
resource "infrawrench_paging_provider_settings" "incident_io" {
  account_id      = var.incident_io_account_id
  inbound_enabled = true
  webhook_secret  = var.incident_io_webhook_secret
}

output "incident_io_webhook_url" {
  value = infrawrench_paging_provider_settings.incident_io.webhook_url
}
