# Turning this on runs flow-log queries that your cloud provider bills to your
# own account, every day, until it is turned off — which is exactly why it is
# worth deciding in a pull request rather than in a settings page.
resource "infrawrench_network_flow_settings" "this" {
  enabled = true

  # The expensive number: the first pass queries this many days at once and the
  # provider bills for the log data it scans. Steady-state collection then moves
  # forward a day at a time.
  initial_lookback_days = 7
}
