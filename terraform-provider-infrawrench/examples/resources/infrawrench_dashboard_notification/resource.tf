# Dashboards are not managed by this provider yet. Take the id from the
# dashboard's URL in the web app, or from `infrawrench config export`.
variable "ops_dashboard_id" {
  type = string
}

data "infrawrench_slack_installations" "workspace" {}

resource "infrawrench_slack_channel" "ops" {
  installation_id = data.infrawrench_slack_installations.workspace.installations[0].id
  channel_id      = "C0123456789"
  channel_name    = "ops"
}

# The ops dashboard lands in Slack and the leadership inbox as a PDF every
# Monday morning.
resource "infrawrench_dashboard_notification" "ops_weekly" {
  dashboard_id      = var.ops_dashboard_id
  cadence           = "weekly"
  send_day          = 1
  hour              = 9
  timezone          = "Europe/Berlin"
  slack_channel_ids = [infrawrench_slack_channel.ops.id]
  email_recipients  = ["leadership@example.com"]
}
