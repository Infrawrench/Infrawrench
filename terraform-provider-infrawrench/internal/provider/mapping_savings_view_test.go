package provider

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

// A saved view's filter is stored with empty lists and blank fields dropped.
// The mapping must send an unset attribute as an absent key (never `[]` or
// `null` the server would have to normalize) and read an absent key back as
// null, or every plan after the first would show a diff.
func TestSavingsViewRoundTrip(t *testing.T) {
	ctx := context.Background()
	min := 100.0
	remote := &iw.SavingsView{
		ID:     "v1",
		Name:   "Production waste",
		Status: "open",
		Filter: iw.SavingsFindingFilter{
			Kinds:             []string{"orphan", "oversized"},
			Tags:              []iw.SavingsFindingTagFilter{{Key: "env", Values: []string{"prod"}}, {Key: "team"}},
			MinMonthlySavings: &min,
		},
		Sort: iw.SavingsFindingSort{Field: "savings", Direction: "desc"},
	}

	state, diags := savingsViewStateFrom(ctx, remote)
	if diags.HasError() {
		t.Fatalf("state: %v", diags)
	}
	if !state.Regions.IsNull() || !state.AccountIDs.IsNull() || !state.Search.IsNull() {
		t.Error("absent filter fields must read back as null")
	}

	input, diags := savingsViewInputFrom(ctx, state)
	if diags.HasError() {
		t.Fatalf("input: %v", diags)
	}
	body, err := json.Marshal(input.Filter)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"kinds":["orphan","oversized"],"tags":[{"key":"env","values":["prod"]},{"key":"team"}],"minMonthlySavings":100}`
	if string(body) != want {
		t.Errorf("filter body = %s\nwant %s", body, want)
	}
	if input.Sort.Field != "savings" || input.Sort.Direction != "desc" || input.Status != "open" {
		t.Errorf("status/sort = %q %+v", input.Status, input.Sort)
	}
}
