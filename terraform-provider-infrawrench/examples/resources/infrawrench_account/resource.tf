# Credentials are write-only: no route returns them, so the provider cannot
# detect drift on their values, and whatever Terraform sends is in the state
# file. Feed them from a secret manager rather than a literal.
resource "infrawrench_account" "production" {
  plugin_id    = "aws"
  display_name = "Production (eu-west-1)"

  credentials = {
    accessKeyId     = var.aws_access_key_id
    secretAccessKey = var.aws_secret_access_key
    region          = "eu-west-1"
  }
}

# A connection made for Costs alone: the credential only needs the billing
# permissions, the bill is read, and no resources are synced. Leave `products`
# out to use a connection for every app its plugin offers.
resource "infrawrench_account" "billing" {
  plugin_id    = "aws"
  display_name = "Billing (payer account)"
  products     = ["costs"]

  credentials = {
    accessKeyId     = var.billing_access_key_id
    secretAccessKey = var.billing_secret_access_key
    region          = "us-east-1"
  }
}
