# A canvas is usually drafted by describing it to the in-app assistant, then
# imported and kept here once it has been reviewed. The spec holds queries,
# not figures: every view and every delivery re-runs them against current
# spend.
resource "infrawrench_cost_canvas" "monthly_review" {
  name        = "Monthly cost review"
  description = "Month-to-date spend against last month, and anything unusual."

  spec_json = jsonencode({
    version = 1
    blocks = [
      {
        id    = "mtd"
        kind  = "kpi"
        title = "Spend this month"
        metric = {
          type      = "spend"
          dateRange = { kind = "relative", preset = "mtd" }
        }
        comparePreviousPeriod = true
      },
      {
        id   = "summary"
        kind = "text"
        text = "Spend so far this month is {{mtd}} ({{mtd.change}} on the same point last month)."
      },
      {
        id    = "unusual"
        kind  = "anomalies"
        title = "Anomalies in the last 30 days"
        days  = 30
        limit = 10
      },
    ]
  })
}
