resource "infrawrench_probe" "api" {
  name = "API health"
  url  = "https://api.example.com/health"
}

resource "infrawrench_status_page" "public" {
  title       = "Acme status"
  description = "Live status of the Acme API."

  # Publishing is the one-line change that makes the page reachable, which is
  # exactly the change worth putting through review.
  published = true

  # Order is the public render order, and a write replaces the whole set — so
  # these blocks are the page, not additions to it.
  component {
    probe_id = infrawrench_probe.api.id
    label    = "API"
  }
}
