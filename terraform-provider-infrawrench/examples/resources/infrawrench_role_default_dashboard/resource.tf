# Finance lands on the spend overview; everyone holding the built-in Member
# role lands on the on-call board. Members can still pick their own default,
# which wins over both.
resource "infrawrench_role_default_dashboard" "finance" {
  role_id      = infrawrench_role.finance.id
  dashboard_id = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
}

resource "infrawrench_role_default_dashboard" "members" {
  system_role  = "member"
  dashboard_id = "2b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e"
}
