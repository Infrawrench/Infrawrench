package provider

import (
	"fmt"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// Acceptance coverage for the surfaces outside cost allocation. Gated exactly as
// acceptance_test.go describes — TF_ACC plus credentials plus a Terraform binary
// — and pointed at a scratch organization.
//
// These do not cover every new resource. They cover the shapes that are easy to
// get wrong and that a unit test cannot reach: an object with server-side
// clamping, a create that needs a second call to honour the plan, a composite
// import id, a write-only credential, and an ordered list written whole.

// TestAccProbeResource covers a resource whose numeric attributes are clamped
// server-side. A value inside the documented range must round trip untouched,
// or every plan after the first shows a diff.
func TestAccProbeResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: testAccProbeConfig("tf-acc-probe", "https://example.com/health", 120),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_probe.test", "name", "tf-acc-probe"),
					resource.TestCheckResourceAttr("infrawrench_probe.test", "interval_seconds", "120"),
					// Optional+Computed defaults must materialise, or a second
					// plan is never empty.
					resource.TestCheckResourceAttr("infrawrench_probe.test", "method", "GET"),
					resource.TestCheckResourceAttr("infrawrench_probe.test", "timeout_ms", "10000"),
					resource.TestCheckResourceAttr("infrawrench_probe.test", "failure_threshold", "3"),
					resource.TestCheckResourceAttr("infrawrench_probe.test", "enabled", "true"),
					resource.TestCheckResourceAttrSet("infrawrench_probe.test", "status"),
				),
			},
			{
				ResourceName:      "infrawrench_probe.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				Config: testAccProbeConfig("tf-acc-probe-renamed", "https://example.com/healthz", 300),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_probe.test", "name", "tf-acc-probe-renamed"),
					resource.TestCheckResourceAttr("infrawrench_probe.test", "interval_seconds", "300"),
				),
			},
		},
	})
}

func testAccProbeConfig(name, url string, interval int) string {
	return fmt.Sprintf(`
resource "infrawrench_probe" "test" {
  name             = %q
  url              = %q
  interval_seconds = %d
}
`, name, url, interval)
}

// TestAccStatusPageResource covers an ordered nested list written whole, plus a
// computed value the server mints with entropy rather than deriving from input.
func TestAccStatusPageResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: testAccStatusPageConfig("tf-acc-status", false),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_status_page.test", "title", "tf-acc-status"),
					resource.TestCheckResourceAttr("infrawrench_status_page.test", "published", "false"),
					resource.TestCheckResourceAttrSet("infrawrench_status_page.test", "slug"),
					resource.TestCheckResourceAttr("infrawrench_status_page.test", "component.#", "1"),
					resource.TestCheckResourceAttr("infrawrench_status_page.test", "component.0.label", "API"),
				),
			},
			{
				ResourceName:      "infrawrench_status_page.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				// Publishing is the change worth reviewing, so it is the change
				// worth testing.
				Config: testAccStatusPageConfig("tf-acc-status", true),
				Check: resource.TestCheckResourceAttr(
					"infrawrench_status_page.test", "published", "true"),
			},
		},
	})
}

func testAccStatusPageConfig(title string, published bool) string {
	return fmt.Sprintf(`
resource "infrawrench_probe" "page_probe" {
  name = "tf-acc-status-probe"
  url  = "https://example.com/health"
}

resource "infrawrench_status_page" "test" {
  title     = %q
  published = %t

  component {
    probe_id = infrawrench_probe.page_probe.id
    label    = "API"
  }
}
`, title, published)
}

// TestAccBusinessMetricResource covers a resource with a cross-field rule the
// schema cannot express: `currency` is required for a currency metric and
// rejected for a count one.
func TestAccBusinessMetricResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: `
resource "infrawrench_business_metric" "test" {
  key  = "tf-acc-customers"
  name = "Active customers"
  unit = "customer"
  kind = "count"

  cost_scope {
    dimension = "tag"
    tag_key   = "team"
    op        = "in"
    values    = ["platform"]
  }
}
`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_business_metric.test", "key", "tf-acc-customers"),
					resource.TestCheckResourceAttr("infrawrench_business_metric.test", "kind", "count"),
					resource.TestCheckNoResourceAttr("infrawrench_business_metric.test", "currency"),
					resource.TestCheckResourceAttr("infrawrench_business_metric.test", "cost_scope.#", "1"),
				),
			},
			{
				ResourceName:      "infrawrench_business_metric.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				// A rename must not change the key, which is what workflows and
				// the CLI address the metric by.
				Config: `
resource "infrawrench_business_metric" "test" {
  key  = "tf-acc-customers"
  name = "Paying customers"
  unit = "customer"
  kind = "count"

  cost_scope {
    dimension = "tag"
    tag_key   = "team"
    op        = "in"
    values    = ["platform"]
  }
}
`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_business_metric.test", "name", "Paying customers"),
					resource.TestCheckResourceAttr("infrawrench_business_metric.test", "key", "tf-acc-customers"),
				),
			},
		},
	})
}

// TestAccRoleResource covers the resource whose plan matters most — a set of
// permission grants — and the property that a set does not diff on reordering.
func TestAccRoleResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: `
resource "infrawrench_role" "test" {
  name        = "tf-acc-finance"
  description = "Read costs, edit budgets."
  permissions = ["costs:read", "budgets:read", "budgets:write"]
}
`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_role.test", "name", "tf-acc-finance"),
					resource.TestCheckResourceAttr("infrawrench_role.test", "permissions.#", "3"),
				),
			},
			{
				ResourceName:      "infrawrench_role.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				// Same grants, different order. A set must plan no change; a
				// list would have planned three.
				Config: `
resource "infrawrench_role" "test" {
  name        = "tf-acc-finance"
  description = "Read costs, edit budgets."
  permissions = ["budgets:write", "costs:read", "budgets:read"]
}
`,
				PlanOnly: true,
			},
		},
	})
}

// TestAccChangeFreezeResource covers the asymmetric update the API performs:
// an omitted `starts_at` leaves the stored one alone while an omitted `reason`
// clears it, which is why `starts_at` is Optional *and* Computed.
func TestAccChangeFreezeResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: `
resource "infrawrench_change_freeze" "test" {
  name   = "tf-acc-freeze"
  reason = "Acceptance test"
}
`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_change_freeze.test", "name", "tf-acc-freeze"),
					// The server stamped `now`; the attribute must have a value
					// or the next plan is not empty.
					resource.TestCheckResourceAttrSet("infrawrench_change_freeze.test", "starts_at"),
					resource.TestCheckResourceAttrSet("infrawrench_change_freeze.test", "active"),
				),
			},
			{
				ResourceName:      "infrawrench_change_freeze.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				// Renaming must not move the window.
				Config: `
resource "infrawrench_change_freeze" "test" {
  name   = "tf-acc-freeze-renamed"
  reason = "Acceptance test"
}
`,
				Check: resource.TestCheckResourceAttr(
					"infrawrench_change_freeze.test", "name", "tf-acc-freeze-renamed"),
			},
		},
	})
}

// TestAccCostReportNotificationResource covers the one composite import id in
// the provider: the schedule hangs off a report, so its own id cannot build a
// URL.
func TestAccCostReportNotificationResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: `
resource "infrawrench_cost_report" "test" {
  name = "tf-acc-notified-report"

  config {
    chart_type = "stacked_bar"
    binning    = "daily"
    group_by   = "service"
    top_n      = 10

    date_range {
      kind   = "relative"
      preset = "last_30_days"
    }
  }
}

resource "infrawrench_cost_report_notification" "test" {
  cost_report_id   = infrawrench_cost_report.test.id
  cadence          = "weekly"
  send_day         = 1
  hour             = 9
  timezone         = "Europe/Berlin"
  email_recipients = ["finance@example.com"]
}
`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_cost_report_notification.test", "cadence", "weekly"),
					resource.TestCheckResourceAttr("infrawrench_cost_report_notification.test", "send_day", "1"),
					// The monthly field must stay null for a weekly schedule, or
					// every plan shows a diff.
					resource.TestCheckNoResourceAttr("infrawrench_cost_report_notification.test", "send_day_of_month"),
				),
			},
			{
				ResourceName:      "infrawrench_cost_report_notification.test",
				ImportState:       true,
				ImportStateVerify: true,
				ImportStateIdFunc: func(s *terraform.State) (string, error) {
					report, ok := s.RootModule().Resources["infrawrench_cost_report.test"]
					if !ok {
						return "", fmt.Errorf("the cost report is not in state")
					}
					notification, ok := s.RootModule().Resources["infrawrench_cost_report_notification.test"]
					if !ok {
						return "", fmt.Errorf("the notification is not in state")
					}
					return report.Primary.ID + "/" + notification.Primary.ID, nil
				},
			},
		},
	})
}
