# Extra addresses on budgets, cost change alerts and routing rules must be on a
# domain a member signs in with, or on one of these.
resource "infrawrench_alert_email_settings" "this" {
  external_policy = "member-domains"
  allowed_domains = ["partner-agency.com"]
}
