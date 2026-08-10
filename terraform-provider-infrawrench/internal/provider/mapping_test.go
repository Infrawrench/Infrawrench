package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

// State mapping is where a provider quietly goes wrong: a value that survives
// the trip out but not the trip back shows up as permanent drift, and a null
// that becomes an empty string shows up as a diff nobody can get rid of. These
// tests exercise the conversions directly, without a Terraform binary.

func TestScalarPointerConversions(t *testing.T) {
	t.Run("null and unknown both become nil", func(t *testing.T) {
		if stringPtr(types.StringNull()) != nil {
			t.Error("a null string must not be sent")
		}
		if stringPtr(types.StringUnknown()) != nil {
			t.Error("an unknown string is not a value yet and must not be sent")
		}
		if int64Ptr(types.Int64Unknown()) != nil {
			t.Error("an unknown int must not be sent")
		}
		if boolPtr(types.BoolUnknown()) != nil {
			t.Error("an unknown bool must not be sent")
		}
		if float64Ptr(types.Float64Null()) != nil {
			t.Error("a null float must not be sent")
		}
	})

	t.Run("set values round trip", func(t *testing.T) {
		if got := stringPtr(types.StringValue("x")); got == nil || *got != "x" {
			t.Errorf("stringPtr = %v", got)
		}
		if got := stringValue(ptr("x")); got.ValueString() != "x" {
			t.Errorf("stringValue = %v", got)
		}
		if !stringValue(nil).IsNull() {
			t.Error("a nil pointer must map back to null, not to an empty string")
		}
		if got := int64Value(ptrInt(7)); got.ValueInt64() != 7 {
			t.Errorf("int64Value = %v", got)
		}
		if !int64Value(nil).IsNull() {
			t.Error("a nil int pointer must map back to null")
		}
		if got := boolValue(ptrBool(true)); !got.ValueBool() {
			t.Errorf("boolValue = %v", got)
		}
		if got := float64Value(ptrFloat(1.5)); got.ValueFloat64() != 1.5 {
			t.Errorf("float64Value = %v", got)
		}
	})

	t.Run("boolValueOrDefault fills an absent tri-state", func(t *testing.T) {
		if got := boolValueOrDefault(nil, true); !got.ValueBool() {
			t.Error("an absent remote bool must fall back to the documented default")
		}
		if got := boolValueOrDefault(ptrBool(false), true); got.ValueBool() {
			t.Error("a present remote bool must win over the default")
		}
	})
}

func TestStringListConversions(t *testing.T) {
	ctx := context.Background()

	t.Run("a null list reads as empty, never nil", func(t *testing.T) {
		got, diags := stringSlice(ctx, types.ListNull(types.StringType))
		if diags.HasError() {
			t.Fatalf("diags: %v", diags)
		}
		if got == nil {
			t.Fatal("must be an empty slice so it marshals as [] rather than null")
		}
		if len(got) != 0 {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("optionalStringList maps empty to null", func(t *testing.T) {
		got, diags := optionalStringList(ctx, nil)
		if diags.HasError() {
			t.Fatalf("diags: %v", diags)
		}
		if !got.IsNull() {
			t.Error("an absent list must be null, not an empty list")
		}
	})

	t.Run("round trip", func(t *testing.T) {
		list, diags := stringList(ctx, []string{"a", "b"})
		if diags.HasError() {
			t.Fatalf("diags: %v", diags)
		}
		back, diags := stringSlice(ctx, list)
		if diags.HasError() {
			t.Fatalf("diags: %v", diags)
		}
		if len(back) != 2 || back[0] != "a" || back[1] != "b" {
			t.Fatalf("round trip lost values: %v", back)
		}
	})
}

// Cost filters are shared by seven resources, so a bug here is a bug
// everywhere. The tag_key case matters most: it is the one optional field, and
// collapsing its null into "" would send a tag filter the server rejects.
func TestCostFilterRoundTrip(t *testing.T) {
	ctx := context.Background()

	original := []iw.CostFilter{
		{Dimension: "service", Op: "in", Values: []string{"AmazonEC2", "AmazonS3"}},
		{Dimension: "tag", Op: "not_in", Values: []string{"sandbox"}, TagKey: ptr("env")},
	}

	list, diags := costFiltersTo(ctx, original)
	if diags.HasError() {
		t.Fatalf("costFiltersTo: %v", diags)
	}

	back, diags := costFiltersFrom(ctx, list)
	if diags.HasError() {
		t.Fatalf("costFiltersFrom: %v", diags)
	}

	if len(back) != 2 {
		t.Fatalf("expected 2 clauses, got %d", len(back))
	}
	if back[0].TagKey != nil {
		t.Error("a clause with no tag key must come back with a nil tag key, not an empty string")
	}
	if back[1].TagKey == nil || *back[1].TagKey != "env" {
		t.Errorf("tag key lost: %v", back[1].TagKey)
	}
	if len(back[0].Values) != 2 || back[0].Values[0] != "AmazonEC2" {
		t.Errorf("values lost: %v", back[0].Values)
	}
	if back[1].Op != "not_in" {
		t.Errorf("op lost: %q", back[1].Op)
	}
}

func TestCostFiltersFromNullListIsEmptyNotNil(t *testing.T) {
	got, diags := costFiltersFrom(context.Background(), types.ListNull(costFilterObjectType))
	if diags.HasError() {
		t.Fatalf("diags: %v", diags)
	}
	if got == nil {
		t.Fatal("must be an empty slice: the API wants [] and rejects null")
	}
}

/* ------------------------------ budget mapping ----------------------------- */

func TestBudgetInputFromOmitsUnsetOptionalIDs(t *testing.T) {
	ctx := context.Background()

	filters, _ := costFiltersTo(ctx, []iw.CostFilter{
		{Dimension: "provider", Op: "in", Values: []string{"aws"}},
	})
	thresholds, diags := types.ListValueFrom(ctx, budgetThresholdObjectType, []budgetThresholdModel{
		{Type: types.StringValue("actual"), Percent: types.Int64Value(80)},
	})
	if diags.HasError() {
		t.Fatalf("thresholds: %v", diags)
	}

	model := budgetResourceModel{
		Name:             types.StringValue("Platform"),
		AmountCents:      types.Int64Value(450000),
		Currency:         types.StringValue("USD"),
		SavedFilterID:    types.StringNull(),
		ScenarioModelID:  types.StringNull(),
		CostBasis:        types.StringValue("amortized"),
		UseAdjustedSpend: types.BoolValue(true),
		Filter:           filters,
		Threshold:        thresholds,
	}

	input, diags := budgetInputFrom(ctx, model)
	if diags.HasError() {
		t.Fatalf("budgetInputFrom: %v", diags)
	}

	if input.SavedFilterID != nil {
		t.Error("an unset saved filter must be omitted so the server clears it")
	}
	if input.ScenarioModelID != nil {
		t.Error("an unset scenario model must be omitted so the server clears it")
	}
	if input.CostBasis == nil || *input.CostBasis != "amortized" {
		t.Errorf("cost basis lost: %v", input.CostBasis)
	}
	if input.UseAdjustedSpend == nil || !*input.UseAdjustedSpend {
		t.Errorf("use adjusted spend lost: %v", input.UseAdjustedSpend)
	}
	if len(input.Thresholds) != 1 || input.Thresholds[0].Percent != 80 {
		t.Errorf("thresholds lost: %+v", input.Thresholds)
	}
	if len(input.Filters) != 1 || input.Filters[0].Dimension != "provider" {
		t.Errorf("filters lost: %+v", input.Filters)
	}
}

// The write and read responses for a budget are different shapes: POST and PUT
// omit the fields GET carries and vice versa. When the server leaves an
// Optional+Computed field out, the planned value has to survive, or the apply
// fails with "Provider produced inconsistent result after apply".
func TestBudgetStateFromKeepsPlannedValuesTheServerOmits(t *testing.T) {
	ctx := context.Background()

	prior := budgetResourceModel{
		CostBasis:        types.StringValue("amortized"),
		UseAdjustedSpend: types.BoolValue(true),
	}

	remote := &iw.Budget{
		ID:          "b1",
		Name:        "Platform",
		AmountCents: 450000,
		Currency:    "USD",
		Thresholds:  []iw.BudgetThreshold{{Type: "actual", Percent: 80}},
		// CostBasis and UseAdjustedSpend deliberately nil, as the write
		// response leaves them.
	}

	state, diags := budgetStateFrom(ctx, remote, prior)
	if diags.HasError() {
		t.Fatalf("budgetStateFrom: %v", diags)
	}

	if state.CostBasis.ValueString() != "amortized" {
		t.Errorf("cost basis should have fallen back to the planned value, got %v", state.CostBasis)
	}
	if !state.UseAdjustedSpend.ValueBool() {
		t.Errorf("use adjusted spend should have fallen back to the planned value, got %v", state.UseAdjustedSpend)
	}
	if state.ID.ValueString() != "b1" {
		t.Errorf("id lost: %v", state.ID)
	}
	if state.SavedFilterID.IsNull() != true {
		t.Error("an absent saved filter must stay null")
	}
}

// A value the server does send must win, or genuine drift is invisible.
func TestBudgetStateFromPrefersTheServer(t *testing.T) {
	ctx := context.Background()

	prior := budgetResourceModel{CostBasis: types.StringValue("amortized")}
	remote := &iw.Budget{
		ID:         "b1",
		Name:       "Platform",
		Currency:   "USD",
		CostBasis:  ptr("cash"),
		Thresholds: []iw.BudgetThreshold{},
	}

	state, diags := budgetStateFrom(ctx, remote, prior)
	if diags.HasError() {
		t.Fatalf("budgetStateFrom: %v", diags)
	}
	if state.CostBasis.ValueString() != "cash" {
		t.Errorf("a server value must override the prior one, got %v", state.CostBasis)
	}
}

/* ------------------------------ saved filters ------------------------------ */

// A saved filter written as a query must not have the server's parse of that
// query written back into its `filter` blocks: blocks cannot be Computed, so a
// value the configuration never wrote is an inconsistent-result error.
func TestSavedFilterStateKeepsBlocksWhenQueryOwnsTheResource(t *testing.T) {
	ctx := context.Background()

	empty, diags := costFiltersTo(ctx, nil)
	if diags.HasError() {
		t.Fatalf("costFiltersTo: %v", diags)
	}

	prior := savedFilterResourceModel{
		Query:  types.StringValue(`service in ("AmazonEC2")`),
		Filter: empty,
	}

	remote := &iw.SavedCostFilter{
		ID:    "sf1",
		Name:  "EC2",
		Query: `service in ("AmazonEC2")`,
		// The server always parses a query back into clauses.
		Filters: []iw.CostFilter{{Dimension: "service", Op: "in", Values: []string{"AmazonEC2"}}},
	}

	state, diags := savedFilterStateFrom(ctx, remote, prior)
	if diags.HasError() {
		t.Fatalf("savedFilterStateFrom: %v", diags)
	}

	clauses, diags := costFiltersFrom(ctx, state.Filter)
	if diags.HasError() {
		t.Fatalf("costFiltersFrom: %v", diags)
	}
	if len(clauses) != 0 {
		t.Errorf("a query-driven saved filter must keep its block list as configured, got %+v", clauses)
	}
	if state.Query.ValueString() != `service in ("AmazonEC2")` {
		t.Errorf("query lost: %v", state.Query)
	}
}

// The other direction: blocks were configured, so the server's echo of them is
// what belongs in state, and the canonical query fills the Computed attribute.
func TestSavedFilterStateTakesServerClausesWhenBlocksOwnTheResource(t *testing.T) {
	ctx := context.Background()

	prior := savedFilterResourceModel{Query: types.StringNull()}
	remote := &iw.SavedCostFilter{
		ID:      "sf1",
		Name:    "EC2",
		Query:   `service in ("AmazonEC2")`,
		Filters: []iw.CostFilter{{Dimension: "service", Op: "in", Values: []string{"AmazonEC2"}}},
	}

	state, diags := savedFilterStateFrom(ctx, remote, prior)
	if diags.HasError() {
		t.Fatalf("savedFilterStateFrom: %v", diags)
	}

	clauses, diags := costFiltersFrom(ctx, state.Filter)
	if diags.HasError() {
		t.Fatalf("costFiltersFrom: %v", diags)
	}
	if len(clauses) != 1 || clauses[0].Dimension != "service" {
		t.Errorf("server clauses lost: %+v", clauses)
	}
	if state.Query.ValueString() == "" {
		t.Error("the canonical query should have filled the computed attribute")
	}
}

/* --------------------------------- helpers -------------------------------- */

func ptr(s string) *string        { return &s }
func ptrInt(i int64) *int64       { return &i }
func ptrBool(b bool) *bool        { return &b }
func ptrFloat(f float64) *float64 { return &f }
