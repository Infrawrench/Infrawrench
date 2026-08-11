# The graph is source code, so it lives beside the rest of your source code
# rather than in a web editor where the last edit has no author and no history.
resource "infrawrench_custom_graph" "burn" {
  name        = "Platform burn"
  description = "Spend per day against the platform team's budget."
  source      = file("${path.module}/graphs/burn.ts")
}
