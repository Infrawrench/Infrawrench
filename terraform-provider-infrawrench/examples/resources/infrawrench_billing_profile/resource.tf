resource "infrawrench_billing_profile" "eu" {
  name       = "EU customers"
  legal_name = "Northwind Trading GmbH"
  address    = "Hauptstrasse 1\n10115 Berlin"
  tax_id     = "DE123456789"
  po_number  = "PO-778"

  # The customer's own contact email still receives every invoice.
  to_emails = ["ap@northwind.example"]
  cc_emails = ["receivables@fabrikam.example"]

  currency           = "EUR"
  payment_terms_days = 30
  tax_rates = [
    { name = "VAT", rate = 19 },
  ]

  invoice_number_prefix = "EU"
  invoice_number_start  = 100

  bank_account_name = "Fabrikam Cloud Ltd"
  iban              = "GB82 WEST 1234 5698 7654 32"
  bic               = "WESTGB2L"

  footer = "Fabrikam Cloud Ltd, registered in England and Wales."
  logo   = "data:image/png;base64,${filebase64("${path.module}/logo.png")}"
}

resource "infrawrench_managed_account" "northwind" {
  name               = "Northwind Trading"
  contact_email      = "ap@northwind.example"
  billing_currency   = "EUR"
  billing_profile_id = infrawrench_billing_profile.eu.id
}
