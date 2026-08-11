data "infrawrench_slack_installations" "workspace" {}

resource "infrawrench_slack_channel" "platform" {
  installation_id = data.infrawrench_slack_installations.workspace.installations[0].id
  channel_id      = "C0123456789"
  channel_name    = "platform-alerts"
}

# One resource holds every rule, in order, because order is the semantics: the
# list is first-match-wins unless a rule sets continue_on_match.
resource "infrawrench_alert_routing" "org" {
  rule {
    name = "Spend goes to the platform channel"

    condition {
      field  = "trigger"
      op     = "in"
      values = ["budgetAlerts", "anomalyAlerts", "costChangeAlerts"]
    }

    destination {
      kind       = "slack"
      channel_id = infrawrench_slack_channel.platform.id
    }
  }

  rule {
    name = "Anything critical also wakes phones"

    condition {
      field    = "severity"
      op       = "gte"
      severity = "critical"
    }

    destination {
      kind = "push"
    }

    # Held overnight, not dropped: a held alert is delivered when the window
    # closes, and critical is exempt from the hold entirely.
    quiet_hours {
      timezone        = "Europe/Berlin"
      start_minute    = 1320 # 22:00
      end_minute      = 420  # 07:00 — an overnight window
      days            = [1, 2, 3, 4, 5]
      urgent_override = "critical"
    }

    escalation {
      after_minutes = 15

      destination {
        kind       = "slack"
        channel_id = infrawrench_slack_channel.platform.id
      }
    }
  }

  rule {
    name = "Swallow drift chatter"

    condition {
      field  = "trigger"
      op     = "in"
      values = ["resourceDrift"]
    }
    # No destination: an enabled rule with nowhere to go silences the category
    # without deleting the rules that would otherwise catch it.
  }
}
