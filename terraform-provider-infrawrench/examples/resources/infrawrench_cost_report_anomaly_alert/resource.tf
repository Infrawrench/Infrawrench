# Page the platform team when the platform report's own scope spikes, at a
# lower bar than the organization-wide anomaly settings.
resource "infrawrench_cost_report_anomaly_alert" "platform" {
  cost_report_id  = infrawrench_cost_report.platform.id
  sigmas          = 2.5
  min_delta_cents = 5000

  destination {
    kind       = "slack"
    channel_id = infrawrench_slack_channel.platform_costs.id
  }

  destination {
    kind    = "email-address"
    address = "platform-finance@example.com"
  }
}
