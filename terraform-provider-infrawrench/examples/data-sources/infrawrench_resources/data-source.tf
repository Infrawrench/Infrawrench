data "infrawrench_accounts" "aws" {
  plugin_id = "aws"
}

# The listing is what the last sync found, so a resource created five minutes
# ago may not be here yet — a poor thing to depend on inside the same apply
# that created it.
data "infrawrench_resources" "api" {
  account_id       = data.infrawrench_accounts.aws.accounts[0].id
  resource_type_id = "ec2_instance"
  name_contains    = "api"
}

output "api_resource_id" {
  value = data.infrawrench_resources.api.resources[0].id
}
