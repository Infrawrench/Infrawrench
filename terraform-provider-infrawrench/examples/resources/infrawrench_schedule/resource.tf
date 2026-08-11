# Resolve the resource rather than hard-coding its id.
data "infrawrench_accounts" "aws" {
  plugin_id = "aws"
}

data "infrawrench_resources" "api" {
  account_id       = data.infrawrench_accounts.aws.accounts[0].id
  resource_type_id = "ec2_instance"
  name_contains    = "api"
}

resource "infrawrench_schedule" "api_nights" {
  resource_id = data.infrawrench_resources.api.resources[0].id
  account_id  = data.infrawrench_resources.api.resources[0].account_id

  # The days the resource is *worked on*: stopped at stop_time on those days,
  # started again at start_time.
  days_of_week = [1, 2, 3, 4, 5]
  stop_time    = "19:00"
  start_time   = "08:00"

  # Computed per transition, so the schedule keeps local office hours across a
  # daylight-saving change instead of drifting by an hour.
  timezone = "Europe/Berlin"
}
