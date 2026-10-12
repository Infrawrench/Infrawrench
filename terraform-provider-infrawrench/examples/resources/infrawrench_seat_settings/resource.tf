# Flag paid SaaS seats (Copilot, Cursor, GitLab, Okta...) nobody has used for
# 45 days, rather than the shipped 30.
resource "infrawrench_seat_settings" "this" {
  inactive_days = 45
}
