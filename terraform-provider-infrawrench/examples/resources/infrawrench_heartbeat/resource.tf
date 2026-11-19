resource "infrawrench_heartbeat" "nightly_backup" {
  name            = "Nightly backup"
  cron_expression = "0 2 * * *"
  timezone        = "Europe/London"

  # How late the ping may be before the heartbeat goes down and alerts.
  grace_minutes = 30
}

resource "infrawrench_heartbeat" "queue_drain" {
  name             = "Queue drain"
  interval_minutes = 15
  grace_minutes    = 5
}

# Hand the job its ping URL without it appearing in plan output.
output "nightly_backup_ping_url" {
  value     = infrawrench_heartbeat.nightly_backup.ping_url
  sensitive = true
}
