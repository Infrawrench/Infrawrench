package iw

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// This test is the substitute for code generation.
//
// The provider's wire structs are hand-written, because two of the objects it
// manages — scenario models and billing rules — are not in the checked-in
// OpenAPI document at all, and the repository's SDK generator degrades exactly
// the schemas this provider needs most (tagged unions become `any`, and
// `readOnly` and `default` are dropped, which are precisely the signals that
// decide whether a Terraform attribute is Computed). Generating would have
// produced types that could not express what the provider has to express.
//
// Hand-writing then has one failure mode: the structs drift from the API and
// nobody notices. This test closes that hole from the other side. For every
// schema the spec *does* carry, it asserts that every property in the spec is
// either decoded by the corresponding Go struct or named in an explicit ignore
// list with a reason. A field added to the API therefore fails the build until
// somebody has looked at it and decided.
//
// The check deliberately runs in one direction only. Extra fields on the Go
// side are expected and fine: the checked-in openapi.json lags the routes, so
// the provider knows about fields the document has not caught up with yet.

const specRelativePath = "../../../app/packages/web/openapi.json"

type specCheck struct {
	// schema is the name under components.schemas.
	schema string
	// value is a zero instance of the Go struct that decodes it.
	value any
	// ignored lists spec properties the provider deliberately does not decode.
	// Every entry needs a reason in the comment above it.
	ignored []string
}

func specChecks() []specCheck {
	return []specCheck{
		{schema: "CostFilter", value: CostFilter{}},

		{schema: "BudgetInput", value: BudgetInput{}},
		{
			schema: "BudgetFull",
			value:  Budget{},
			// Soft-delete bookkeeping. A row Terraform can see is by
			// definition not deleted, so the field carries no information.
			ignored: []string{"deletedAt"},
		},
		{
			schema: "BudgetWithStatus",
			value:  Budget{},
			// This month's firing history. Operational state, not
			// configuration — it would change under a plan that changes
			// nothing.
			ignored: []string{"currentMonthEvents"},
		},

		{schema: "CostCentre", value: CostCentre{}},
		{schema: "CostCentreInput", value: CostCentreInput{}},

		{schema: "AllocationRule", value: AllocationRule{}},
		{schema: "AllocationRuleInput", value: AllocationRuleInput{}},
		{schema: "AllocationRuleMatch", value: AllocationRuleMatch{}},

		{schema: "TagPolicy", value: TagPolicy{}},
		{schema: "RequiredTag", value: RequiredTag{}},

		{schema: "SavedCostFilter", value: SavedCostFilter{}},
		{schema: "SavedCostFilterInput", value: SavedCostFilterInput{}},

		{schema: "CostReport", value: CostReport{}},
		{schema: "CostReportInput", value: CostReportInput{}},
		{schema: "CostGraphConfig", value: CostGraphConfig{}},
		{schema: "CostReportFolder", value: CostReportFolder{}},
		{schema: "CostReportFolderInput", value: CostReportFolderInput{}},

		{schema: "CostAlert", value: CostAlert{}},
		{schema: "CostAlertInput", value: CostAlertInput{}},

		{schema: "CostExport", value: CostExport{}},
		{schema: "CostExportInput", value: CostExportInput{}},
		{schema: "CostExportQuery", value: CostExportQuery{}},

		{schema: "Account", value: Account{}},
		{
			schema: "PluginSummary",
			value:  PluginSummary{},
			// logoSvg is multi-kilobyte markup and credentialFields/preflight
			// describe a UI form. None of it belongs in Terraform state, so the
			// plugins data source drops all three rather than bloating every
			// state file that reads it.
			ignored: []string{"logoSvg", "credentialFields", "preflight"},
		},
	}
}

// schemasKnownAbsent are objects this provider manages that the checked-in spec
// does not describe at all. Their routes exist and their OpenAPI *sources*
// exist, but openapi.json has not been regenerated since they landed. They are
// listed here so the gap is visible rather than merely absent, and so that
// regenerating the spec makes this test start covering them.
var schemasKnownAbsent = []string{
	"CostScenarioModel",
	"CostScenarioModelInput",
	"CostScenarioAdjustment",
	"BillingRule",
	"BillingRuleInput",
	"BillingRuleMatch",
	"BillingRuleAdjustment",
}

func loadSpecSchemas(t *testing.T) map[string]map[string]any {
	t.Helper()

	path, err := filepath.Abs(specRelativePath)
	if err != nil {
		t.Fatalf("resolving spec path: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		// The provider is meant to be extractable into its own repository, at
		// which point the monorepo spec is simply not there. Skipping keeps it
		// buildable standalone without pretending the check ran.
		t.Skipf("OpenAPI document not available at %s (%v); skipping the wire drift check", path, err)
	}

	var doc struct {
		Components struct {
			Schemas map[string]struct {
				Properties map[string]any `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}

	out := make(map[string]map[string]any, len(doc.Components.Schemas))
	for name, schema := range doc.Components.Schemas {
		out[name] = schema.Properties
	}
	return out
}

// jsonFieldNames returns the wire names a struct decodes, following the same
// rules encoding/json does.
func jsonFieldNames(value any) map[string]bool {
	names := map[string]bool{}
	t := reflect.TypeOf(value)
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("json")
		if tag == "-" {
			continue
		}
		name, _, _ := strings.Cut(tag, ",")
		if name == "" {
			name = t.Field(i).Name
		}
		names[name] = true
	}
	return names
}

func TestWireStructsCoverSpecSchemas(t *testing.T) {
	schemas := loadSpecSchemas(t)

	for _, check := range specChecks() {
		t.Run(check.schema, func(t *testing.T) {
			properties, ok := schemas[check.schema]
			if !ok {
				t.Fatalf("schema %q is not in the OpenAPI document; if it was removed, "+
					"drop it from specChecks, and if it was renamed, update the name here",
					check.schema)
			}

			decoded := jsonFieldNames(check.value)
			ignored := map[string]bool{}
			for _, name := range check.ignored {
				ignored[name] = true
			}

			var missing []string
			for property := range properties {
				if !decoded[property] && !ignored[property] {
					missing = append(missing, property)
				}
			}
			sort.Strings(missing)
			if len(missing) > 0 {
				t.Errorf("%s: the API describes properties the provider silently drops: %s\n"+
					"Either decode them in wire.go, or add them to this check's ignored list with a reason.",
					check.schema, strings.Join(missing, ", "))
			}

			// A stale ignore entry hides a field that has come back.
			for _, name := range check.ignored {
				if _, present := properties[name]; !present {
					t.Errorf("%s: ignored property %q is no longer in the spec; remove it from the ignored list",
						check.schema, name)
				}
			}
		})
	}
}

// TestKnownAbsentSchemasAreStillAbsent makes the spec's staleness a fact the
// test suite states out loud. When openapi.json is regenerated these schemas
// appear, this test fails, and whoever regenerated it is told to move them into
// specChecks so they start being covered.
func TestKnownAbsentSchemasAreStillAbsent(t *testing.T) {
	schemas := loadSpecSchemas(t)

	var appeared []string
	for _, name := range schemasKnownAbsent {
		if _, present := schemas[name]; present {
			appeared = append(appeared, name)
		}
	}
	if len(appeared) > 0 {
		t.Fatalf("these schemas are now in the OpenAPI document: %s\n"+
			"Move them from schemasKnownAbsent into specChecks so their wire structs are checked.",
			strings.Join(appeared, ", "))
	}
	t.Logf("%d schemas this provider manages are still missing from openapi.json: %s",
		len(schemasKnownAbsent), strings.Join(schemasKnownAbsent, ", "))
}
