# One `team` dimension, whatever each account spelled its tags as.
resource "infrawrench_virtual_tag" "team" {
  key           = "team"
  name          = "Team"
  description   = "Owning team, for showback."
  default_value = "unallocated"

  rules = [
    # The shared database is split by fixed percentages. Narrow rules first:
    # the first rule a row matches decides its value.
    {
      query = "provider = 'aws' AND service = 'AmazonRDS' AND tag['Name'] = 'shared-db'"
      kind  = "split"
      allocations = [
        { value = "payments", percent = 60 },
        { value = "search", percent = 40 },
      ]
    },
    # Everything else reads whichever team tag the row carries.
    {
      kind            = "tag"
      value_transform = "lower"
      sources = [
        { tag_key = "team" },
        { tag_key = "Team" },
        { tag_key = "owner", query = "provider = 'azure'" },
      ]
    },
  ]
}

# Route each team's spend, split shares included, to its cost centre.
resource "infrawrench_cost_centre" "payments" {
  name = "Payments"
}

resource "infrawrench_allocation_rule" "payments" {
  cost_centre_id = infrawrench_cost_centre.payments.id
  priority       = 10

  match {
    virtual_tag_key   = infrawrench_virtual_tag.team.key
    virtual_tag_value = "payments"
  }
}
