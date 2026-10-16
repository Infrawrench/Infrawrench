resource "infrawrench_idle_finding_settings" "this" {
  enabled       = true
  lookback_days = 21

  rules = {
    # Flag NAT gateways that sent under 10 MB in three weeks.
    "aws:nat-gateway" = {
      thresholds = { maxBytesOut = 10000000 }
    }
    # Provisioned tables are tuned by another team.
    "aws:dynamodb-provisioned" = {
      enabled = false
    }
    "datadog:unused-custom-metric" = {
      thresholds = { notQueriedDays = 60, minIndexedSeries = 50 }
    }
  }
}
