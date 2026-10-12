# Every critical incident and posture finding, signed, to your own receiver.
resource "infrawrench_event_subscription" "security_feed" {
  name         = "Security feed"
  webhook_url  = "https://hooks.example.com/infrawrench"
  event_types  = ["posture.finding.detected", "incident.declared", "incident.resolved"]
  min_severity = "warning"

  # Bump to reroll; the previous secret keeps signing for 24 hours.
  secret_version = 1
}

# Hand the secret to whatever verifies the signature.
output "security_feed_secret" {
  value     = infrawrench_event_subscription.security_feed.signing_secret
  sensitive = true
}

# Production cost and drift events onto an EventBridge rule's bus.
resource "infrawrench_event_subscription" "prod_bus" {
  name                     = "Prod event bus"
  publish_account_id       = "acc_0a1b2c3d"
  publish_resource_type_id = "eventbridge-rule"
  publish_resource_id      = "res_4e5f6a7b"
  event_types              = ["cost.anomaly.detected", "budget.threshold.crossed", "drift.detected"]
  environments             = ["prod"]
}
