# A weekly rotation. The order of participant_user_ids *is* the rotation, so
# reordering the list re-plans every future shift.
resource "infrawrench_on_call_schedule" "platform_primary" {
  name     = "Platform primary"
  timezone = "Europe/London"

  rotation_days = 7
  handoff_time  = "09:00"

  # Every later handover is derived from this date, so moving it re-anchors the
  # whole rotation rather than shifting only the next shift.
  start_date = "2026-08-03"

  participant_user_ids = [
    "1f0c2b3a-4d5e-4f60-8a71-9b2c3d4e5f60",
    "2a1d3c4b-5e6f-4071-9b82-0c3d4e5f6071",
    "3b2e4d5c-6f70-4182-8c93-1d4e5f607182",
  ]
}

# What the rotation is for: a rule that reaches whoever is holding it when the
# alert fires, rather than a person named when the rule was written.
resource "infrawrench_alert_routing" "org" {
  rule {
    name = "Critical pages the rota"

    condition {
      field    = "severity"
      op       = "gte"
      severity = "critical"
    }

    destination {
      kind        = "on-call"
      schedule_id = infrawrench_on_call_schedule.platform_primary.id
    }
  }
}
