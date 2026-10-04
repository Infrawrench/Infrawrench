# Everyone holding the Platform role sees only the spend allocated to the
# Platform cost centre (and its sub-centres) or billed to the shared account.
resource "infrawrench_cost_visibility_scope" "platform" {
  principal_kind  = "role"
  principal_id    = infrawrench_role.platform.id
  cost_centre_ids = [infrawrench_cost_centre.platform.id]
  account_ids     = [infrawrench_account.shared.id]
}
