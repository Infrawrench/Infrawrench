# A one-off window: the EC2 spend of a planned load test should not alert.
resource "infrawrench_anomaly_suppression" "load_test" {
  scope      = "service"
  scope_key  = "Amazon EC2"
  recurrence = "one_off"
  anchor_day = "2026-11-02"
  expires_on = "2026-11-06"
  reason     = "planned_launch"
  note       = "Black Friday load test, see INFRA-412"
}

# A recurring pattern: the month-end close runs on the data cost centre every
# month, give or take a day.
resource "infrawrench_cost_centre" "data" {
  name = "Data platform"
}

resource "infrawrench_anomaly_suppression" "month_end_close" {
  scope      = "cost_centre"
  scope_key  = infrawrench_cost_centre.data.id
  recurrence = "monthly"
  anchor_day = "2026-10-31"
  expires_on = "2027-04-30"
  reason     = "seasonal"
}

# A tag-scoped suppression: the key goes in tag_key, the value in scope_key.
resource "infrawrench_anomaly_suppression" "nightly_batch" {
  scope      = "tag"
  tag_key    = "workload"
  scope_key  = "nightly-batch"
  recurrence = "weekly"
  anchor_day = "2026-10-05" # a Monday
  starts_on  = "2026-10-12"
  expires_on = "2027-01-04"
}
