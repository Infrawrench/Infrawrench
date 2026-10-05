data "infrawrench_sso_directory_groups" "all" {}

locals {
  groups = { for g in data.infrawrench_sso_directory_groups.all.groups : g.name => g.id }
}

resource "infrawrench_role" "platform" {
  name        = "Platform"
  permissions = ["accounts:*", "resources:*", "deployments:*"]
}

# Evaluated lowest position first; the first group a member is in wins.
resource "infrawrench_sso_group_role_mapping" "platform" {
  directory_group_id = local.groups["Platform engineers"]
  role_id            = infrawrench_role.platform.id
  position           = 0
}
