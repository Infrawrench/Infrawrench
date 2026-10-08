# Production admin, on request: two hours at most, approved by whoever is on
# call (or the platform leads), and self-approvable only while a declared
# incident is open.
data "infrawrench_accounts" "aws" {
  plugin_id = "aws"
}

resource "infrawrench_jit_access_policy" "prod_admin" {
  name        = "Production admin for on-call"
  description = "Break-fix access to the production AWS account."
  account_id  = data.infrawrench_accounts.aws.accounts[0].id

  # An AWS account id and an IAM Identity Center permission set ARN. The
  # settings page offers both as pickers; copy them from there.
  target {
    scope_id   = "123456789012"
    scope_name = "production"
    role_id    = "arn:aws:sso:::permissionSet/ssoins-1111111111111111/ps-2222222222222222"
    role_name  = "AdministratorAccess"
  }

  max_duration_minutes     = 120
  default_duration_minutes = 60
  request_timeout_minutes  = 30

  approver_on_call_schedule_ids = [infrawrench_on_call_schedule.platform_primary.id]
  approver_role_ids             = ["role-platform-leads"]

  allow_self_approval_during_incident = true
  require_ticket                      = true
}
