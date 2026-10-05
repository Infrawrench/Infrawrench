resource "infrawrench_cost_canvas" "monthly_review" {
  name = "Monthly cost review"
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
      },
    ]
  })
}

# The canvas goes to finance as a PDF on the first of every month, with the
# figures as of the morning it is sent.
resource "infrawrench_cost_canvas_notification" "monthly" {
  cost_canvas_id    = infrawrench_cost_canvas.monthly_review.id
  cadence           = "monthly"
  send_day_of_month = 1
  hour              = 8
  timezone          = "Europe/London"
  email_recipients  = ["finance@example.com"]
}
