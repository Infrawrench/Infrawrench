resource "infrawrench_probe" "api" {
  name = "API health"
  url  = "https://api.example.com/health"
}

# 99.9% of probe checks succeed over a rolling 30 days: 43 minutes of budget.
resource "infrawrench_slo" "api_availability" {
  name           = "API availability"
  sli_kind       = "probe_availability"
  probe_id       = infrawrench_probe.api.id
  target_percent = 99.9
  window_days    = 30
}

# 99% of checks answer within 300 ms over 28 days.
resource "infrawrench_slo" "api_latency" {
  name                 = "API latency"
  sli_kind             = "probe_latency"
  probe_id             = infrawrench_probe.api.id
  latency_threshold_ms = 300
  target_percent       = 99
  window_days          = 28
}
