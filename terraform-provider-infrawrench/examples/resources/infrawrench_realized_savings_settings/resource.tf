# How realized savings are measured. These are the shipped defaults except for
# the shortfall threshold, raised so an action has to deliver at least 80% of
# what it was projected to save before it stops being flagged.
resource "infrawrench_realized_savings_settings" "this" {
  # A one-off action, such as deleting an orphaned volume, keeps accruing
  # savings for this many months after it was taken.
  horizon_months = 12

  # Below this share of its projected rate, an action is flagged as falling
  # short.
  shortfall_threshold_percent = 80

  # Days of spend before each action averaged into the baseline it is measured
  # against.
  baseline_window_days = 14
}
