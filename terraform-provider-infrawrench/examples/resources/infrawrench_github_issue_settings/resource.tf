# Installation ids and repository names come from the organization's
# `/github/repos` listing (the same list the repository pickers in
# Settings > GitHub Issues show).
resource "infrawrench_github_issue_settings" "this" {
  enabled                 = true
  default_installation_id = 51234567
  default_repository      = "acme/infra"

  labels         = ["infrawrench", "cost"]
  assignees      = ["octocat"]
  resolve_action = "close"

  # First match wins; anything unmatched goes to the default repository.
  route {
    match_kind      = "cost_centre"
    cost_centre_id  = "9a8b7c6d-0000-4000-8000-000000000001" # an infrawrench_cost_centre id
    installation_id = 51234567
    repository      = "acme/payments"
    labels          = ["payments"]
  }

  route {
    match_kind      = "tag"
    tag_key         = "team"
    tag_value       = "search"
    installation_id = 51234567
    repository      = "acme/search"
  }

  # Pull requests need the installation's Contents and Pull requests permissions.
  pull_requests_enabled = true

  iac_source {
    installation_id = 51234567
    repository      = "acme/infra"
    base_branch     = "main"
    directory       = "infra/prod"
  }
}

# Filing automatically is an alert routing rule with a github-issues destination.
resource "infrawrench_alert_routing" "org" {
  rule {
    name = "File new savings findings over $200 a month"

    condition {
      field  = "trigger"
      op     = "in"
      values = ["savingsFindings"]
    }

    condition {
      field = "amountCents"
      op    = "gte"
      cents = 20000
    }

    destination {
      kind = "github-issues"
    }
  }
}
