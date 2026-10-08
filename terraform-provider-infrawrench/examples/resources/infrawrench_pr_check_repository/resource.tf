# Installation ids and repository names come from the organization's
# `/github/repos` listing (the same list the repository picker in
# Settings > Pull Request Checks shows).
resource "infrawrench_pr_check_repository" "infra" {
  installation_id = 51234567
  repository      = "acme/infra"

  # Keep one summary comment on each infrastructure pull request.
  comment_enabled = true

  # Fail the check (blocking merge where it is required) when a pull request
  # adds more than 500 a month.
  cost_threshold       = 500
  threshold_conclusion = "failure"

  # Only look at the production root modules.
  directories = ["terraform/prod", "terraform/shared"]
}
