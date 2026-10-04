# Attributed AI spend appears in cost reports under the tag key `caller:team`.
# The first metadata key a request carries wins.
resource "infrawrench_ai_attribution_dimension" "team" {
  key           = "team"
  label         = "Team"
  metadata_keys = ["team", "team_id", "user_api_key_team_alias"]
}
