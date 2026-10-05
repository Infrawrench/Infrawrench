resource "infrawrench_managed_account" "northwind" {
  name             = "Northwind Trading"
  contact_email    = "ap@northwind.example"
  billing_currency = "USD"
  cost_centre_ids  = [infrawrench_cost_centre.northwind.id]

  # Bill usage at public list prices; 5% on top where no list price exists,
  # 8% for one service.
  rerate_to_list_price           = true
  rerate_fallback_uplift_percent = 5
  rerate_uplifts = [
    { plugin_id = "aws", service = "Amazon Elastic Compute Cloud - Compute", percent = 8 },
  ]

  # Keep the enterprise discount, pass half of every credit on.
  discount_treatment          = "retain"
  credit_treatment            = "partial"
  credit_pass_through_percent = 50
}
