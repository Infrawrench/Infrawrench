resource "infrawrench_probe" "api" {
  name = "API health"
  url  = "https://api.example.com/health"

  # Clamped server-side to 60–86400; stay inside the range or the stored value
  # will differ from the configured one on every plan.
  interval_seconds  = 60
  failure_threshold = 3
}
