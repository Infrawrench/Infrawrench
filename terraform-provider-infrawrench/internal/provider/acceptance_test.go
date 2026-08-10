package provider

import (
	"fmt"
	"os"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

// Acceptance tests create and destroy real objects in a real organization, so
// they are gated three ways and skipped by default:
//
//   - `resource.Test` itself skips unless TF_ACC is set, which is the
//     framework's own convention.
//   - testAccPreCheck additionally requires credentials, so that setting TF_ACC
//     without them fails with an explanation rather than eleven confusing 401s.
//   - They need a Terraform binary on PATH, which terraform-plugin-testing
//     downloads or discovers at run time.
//
// Point them at a scratch organization. They destroy what they create, but a
// failed run can leave objects behind, and `replace` semantics elsewhere in the
// product make that worse in an org anybody depends on.
//
// Run them with:
//
//	TF_ACC=1 INFRAWRENCH_API_KEY=… INFRAWRENCH_ORG_ID=org_… go test ./internal/provider/ -v

var testAccProtoV6ProviderFactories = map[string]func() (tfprotov6.ProviderServer, error){
	"infrawrench": providerserver.NewProtocol6WithError(New("test")()),
}

func testAccPreCheck(t *testing.T) {
	t.Helper()
	for _, name := range []string{envAPIKey, envOrgID} {
		if os.Getenv(name) == "" {
			t.Fatalf("%s must be set for acceptance tests", name)
		}
	}
}

// TestAccBudgetResource covers the full lifecycle a practitioner actually
// performs: create, refresh, import, change something in place, destroy.
func TestAccBudgetResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: testAccBudgetConfig("tf-acc-budget", 100000, 80),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_budget.test", "name", "tf-acc-budget"),
					resource.TestCheckResourceAttr("infrawrench_budget.test", "amount_cents", "100000"),
					resource.TestCheckResourceAttr("infrawrench_budget.test", "threshold.0.percent", "80"),
					resource.TestCheckResourceAttrSet("infrawrench_budget.test", "id"),
					// Optional+Computed defaults must materialise, or a second
					// plan is never empty.
					resource.TestCheckResourceAttr("infrawrench_budget.test", "currency", "USD"),
					resource.TestCheckResourceAttr("infrawrench_budget.test", "cost_basis", "cash"),
				),
			},
			{
				// Import is the step that proves the resource is adoptable. If
				// Read does not repopulate every attribute, this fails.
				ResourceName:      "infrawrench_budget.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				Config: testAccBudgetConfig("tf-acc-budget-renamed", 250000, 90),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_budget.test", "name", "tf-acc-budget-renamed"),
					resource.TestCheckResourceAttr("infrawrench_budget.test", "amount_cents", "250000"),
					resource.TestCheckResourceAttr("infrawrench_budget.test", "threshold.0.percent", "90"),
				),
			},
		},
	})
}

func testAccBudgetConfig(name string, amountCents, percent int) string {
	return fmt.Sprintf(`
resource "infrawrench_budget" "test" {
  name         = %[1]q
  amount_cents = %[2]d

  filter {
    dimension = "provider"
    op        = "in"
    values    = ["aws"]
  }

  threshold {
    type    = "actual"
    percent = %[3]d
  }
}
`, name, amountCents, percent)
}

// TestAccCostCentreResource exercises an object with no single-GET route, so
// the list-and-filter Read path is covered too — including the synthesised 404
// that makes an outside deletion show as needing recreation.
func TestAccCostCentreResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: `
resource "infrawrench_cost_centre" "test" {
  name        = "tf-acc-centre"
  description = "Created by the provider acceptance tests."
}
`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_cost_centre.test", "name", "tf-acc-centre"),
					resource.TestCheckResourceAttrSet("infrawrench_cost_centre.test", "id"),
				),
			},
			{
				ResourceName:      "infrawrench_cost_centre.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
		},
	})
}

// TestAccSavedFilterResource covers the XOR between blocks and a query, which
// is the one place in this provider where two attributes describe the same
// thing and only one of them may be written.
func TestAccSavedFilterResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: `
resource "infrawrench_saved_filter" "test" {
  name = "tf-acc-filter"

  filter {
    dimension = "provider"
    op        = "in"
    values    = ["aws"]
  }
}
`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_saved_filter.test", "name", "tf-acc-filter"),
					// The canonical query is server-derived and must land in
					// the computed attribute.
					resource.TestCheckResourceAttrSet("infrawrench_saved_filter.test", "query"),
				),
			},
			{
				ResourceName:      "infrawrench_saved_filter.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
		},
	})
}

// TestAccCostExportResource is the credential case. ImportStateVerify has to
// ignore the write-only fields: no route returns them, so an import can never
// reproduce them, and asserting otherwise would be asserting a leak.
func TestAccCostExportResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: `
resource "infrawrench_cost_export" "test" {
  name             = "tf-acc-export"
  format           = "csv"
  cadence          = "daily"
  hour             = 3
  timezone         = "UTC"
  restatement_days = 7

  access_key_id     = "AKIAEXAMPLEEXAMPLE"
  secret_access_key = "example-secret-value"

  query {
    dimensions = ["service"]
  }

  destination {
    kind   = "s3"
    bucket = "tf-acc-exports"
    region = "eu-west-1"
  }
}
`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("infrawrench_cost_export.test", "name", "tf-acc-export"),
					resource.TestCheckResourceAttr("infrawrench_cost_export.test", "has_credentials", "true"),
					resource.TestCheckResourceAttrSet("infrawrench_cost_export.test", "credential_hint"),
				),
			},
			{
				ResourceName:      "infrawrench_cost_export.test",
				ImportState:       true,
				ImportStateVerify: true,
				ImportStateVerifyIgnore: []string{
					"access_key_id",
					"secret_access_key",
					"url",
				},
			},
		},
	})
}
