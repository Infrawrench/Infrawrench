# Hide provider bookkeeping keys from every tag picker and pin the keys the
# organization reports on. Hidden keys' cost data is untouched and still
# queryable; this only changes what the pickers offer.
resource "infrawrench_tag_key_settings" "this" {
  hidden_keys = [
    "aws:cloudformation:*",
    "aws:autoscaling:*",
    "goog-k8s-*",
    "Name",
  ]

  preferred_keys = ["team", "env", "cost-centre"]
}
