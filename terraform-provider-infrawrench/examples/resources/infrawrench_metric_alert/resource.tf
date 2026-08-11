# Resources are selected by query, never by id, so one rule written once covers
# every instance the team creates afterwards.
resource "infrawrench_metric_alert" "cpu" {
  name       = "Platform CPU sustained"
  tag_key    = "team"
  tag_value  = "platform"
  metric_key = "CPU %"

  comparator = ">"
  threshold  = 90

  # A momentary spike is not an incident.
  for_minutes      = 20
  cooldown_minutes = 60
}
