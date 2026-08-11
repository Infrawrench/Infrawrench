# The resource where a plan is worth the most: the diff shows exactly which
# grant was added to whose access, in a pull request, with a reviewer.
resource "infrawrench_role" "finance" {
  name        = "Finance"
  description = "Read spend, own budgets, touch nothing else."

  # A set, so reordering plans no change. Wildcards are accepted and are not
  # expanded, so a wildcard role picks up permissions added by later releases.
  permissions = [
    "costs:read",
    "budgets:read",
    "budgets:write",
    "invoices:read",
  ]
}
