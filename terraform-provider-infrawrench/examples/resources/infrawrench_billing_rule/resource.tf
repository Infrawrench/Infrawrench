# A markup that applies to the organization's own figures.
resource "infrawrench_billing_rule" "platform_overhead" {
  name     = "Platform overhead"
  priority = 10

  match {
    tag_key   = "team"
    tag_value = "platform"
  }

  adjustment {
    kind    = "percentage"
    percent = 15
  }
}

# Rate tiers on one customer's monthly spend. Invoices only.
resource "infrawrench_billing_rule" "volume_tiers" {
  name                = "Volume tiers"
  priority            = 20
  managed_account_ids = [infrawrench_managed_account.northwind.id]

  adjustment {
    kind      = "tiered"
    currency  = "USD"
    tier_mode = "marginal"
    tiers = [
      { up_to = 10000, percent = 8 },
      { up_to = 50000, percent = 5 },
      { percent = 3 },
    ]
  }
}

# A custom expression, parsed and checked by the API on apply. Invoices only.
resource "infrawrench_billing_rule" "prod_ec2" {
  name     = "Production EC2 surcharge"
  priority = 30

  adjustment {
    kind       = "expression"
    expression = "if service == \"AmazonEC2\" and tag.env == \"prod\" then cost * 1.1"
  }
}
