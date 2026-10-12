# What the Delivery page's DORA metrics count as production, and how soon after
# a change an incident or rollback counts it as failed.
resource "infrawrench_dora_settings" "this" {
  failure_window_hours    = 24
  production_environments = ["production", "prod*"]
  pipeline_patterns       = ["*deploy*", "release"]

  count_failed_deploys     = false
  include_resource_changes = false
  digest_enabled           = true
}
