# Name a member by id rather than by address: the address is read when the
# alert is sent, so a change of address follows them.
data "infrawrench_members" "finance_lead" {
  email = "dana@example.com"
}

resource "infrawrench_cost_alert" "weekly_jump" {
  name              = "Weekly spend jump"
  cadence           = "weekly"
  direction         = "increase"
  threshold_percent = 25

  email_member_ids = [data.infrawrench_members.finance_lead.members[0].id]
}
