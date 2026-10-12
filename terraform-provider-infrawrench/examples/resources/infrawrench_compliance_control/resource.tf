data "infrawrench_members" "lead" {
  email = "platform-lead@example.com"
}

# Change management is owned by one engineer.
resource "infrawrench_compliance_control" "change_management" {
  framework_id  = "soc2"
  control_id    = "CC8.1"
  applicable    = true
  owner_user_id = data.infrawrench_members.lead.members[0].id
  notes         = "Deploys go through pull request checks and change freezes."
}

# Backups are the managed database provider's, out of this organization's
# scope, so the control does not apply. Not applicable needs a justification.
resource "infrawrench_compliance_control" "backups" {
  framework_id  = "iso27001"
  control_id    = "8.13"
  applicable    = false
  justification = "No self-hosted data stores; backups are covered by the database provider's attestation."
  owner_label   = "Security team"
}
