resource "infrawrench_cost_report_folder" "finops" {
  name = "FinOps"
}

# Savings plan and reservation performance per week, split by commitment type.
resource "infrawrench_commitment_report" "weekly_by_type" {
  name        = "Commitment performance by type"
  folder_id   = infrawrench_cost_report_folder.finops.id
  date_preset = "90d"
  granularity = "weekly"
  group_by    = "commitment_type"
  metric      = "utilization"
}

# AWS coverage of EC2 per month over a fixed year, one line per account.
resource "infrawrench_commitment_report" "ec2_coverage" {
  name        = "EC2 coverage by account"
  folder_id   = infrawrench_cost_report_folder.finops.id
  date_from   = "2025-10-01"
  date_to     = "2026-09-30"
  granularity = "monthly"
  group_by    = "account"
  metric      = "coverage"
  providers   = ["aws"]
  services    = ["Amazon Elastic Compute Cloud - Compute"]
}
