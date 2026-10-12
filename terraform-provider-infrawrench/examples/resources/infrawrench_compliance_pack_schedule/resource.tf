data "infrawrench_slack_installations" "workspace" {}

resource "infrawrench_slack_channel" "security" {
  installation_id = data.infrawrench_slack_installations.workspace.installations[0].id
  channel_id      = "C0123456789"
  channel_name    = "security"
}

# Last quarter's SOC 2 evidence pack lands with the auditors' contact and the
# security channel on the 2nd of January, April, July and October.
resource "infrawrench_compliance_pack_schedule" "soc2_quarterly" {
  framework_id      = "soc2"
  cadence           = "quarterly"
  send_day_of_month = 2
  hour              = 8
  timezone          = "Europe/London"
  email_recipients  = ["compliance@example.com"]
  slack_channel_ids = [infrawrench_slack_channel.security.id]
}
