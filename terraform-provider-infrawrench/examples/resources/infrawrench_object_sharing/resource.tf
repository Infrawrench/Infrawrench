# Only Finance can edit the board report; everyone else can read it.
resource "infrawrench_object_sharing" "board" {
  object_type = "cost_report"
  object_id   = infrawrench_cost_report.board.id
  org_access  = "viewer"

  grant {
    principal_kind = "role"
    principal_id   = infrawrench_role.finance.id
    level          = "editor"
  }
}
