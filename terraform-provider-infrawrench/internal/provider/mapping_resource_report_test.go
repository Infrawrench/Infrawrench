package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

// A minimal configuration: columns only. Everything else is omitted and must
// come back null (or as the schema default) after the server fills defaults,
// or every plan would show drift.
func minimalResourceReportModel(t *testing.T) resourceReportResourceModel {
	t.Helper()
	ctx := context.Background()
	columns, d := stringList(ctx, []string{"core:name", "cost:range"})
	if d.HasError() {
		t.Fatal(d)
	}
	return resourceReportResourceModel{
		Name:            types.StringValue("Inventory"),
		Description:     types.StringNull(),
		FolderID:        types.StringNull(),
		Columns:         columns,
		SortColumn:      types.StringNull(),
		SortDirection:   types.StringNull(),
		CostRangePreset: types.StringNull(),
		CostRangeFrom:   types.StringNull(),
		CostRangeTo:     types.StringNull(),
		CostBasis:       types.StringValue("cash"),
		PageSize:        types.Int64Value(50),
		PluginIDs:       types.SetNull(types.StringType),
		AccountIDs:      types.SetNull(types.StringType),
		Regions:         types.SetNull(types.StringType),
		Statuses:        types.SetNull(types.StringType),
		NameContains:    types.StringNull(),
		CreatedFrom:     types.StringNull(),
		CreatedTo:       types.StringNull(),
		ResourceType:    []resourceReportTypeModel{},
		TagFilter:       []resourceReportTagFilterModel{},
	}
}

func TestResourceReportMinimalRoundTrip(t *testing.T) {
	ctx := context.Background()
	plan := minimalResourceReportModel(t)

	input, diags := resourceReportInputFrom(ctx, plan)
	if diags.HasError() {
		t.Fatal(diags)
	}
	// Every list goes on the wire as [] (the server's schema has no absent list),
	// the omitted cost range as the 30-day preset, and no sort as null.
	f := input.Config.Filters
	if f.PluginIDs == nil || f.AccountIDs == nil || f.Regions == nil || f.Statuses == nil ||
		f.ResourceTypes == nil || f.Tags == nil {
		t.Fatalf("filter lists must be [] not null: %+v", f)
	}
	if input.Config.CostRange.Kind != "relative" || *input.Config.CostRange.Preset != "30d" {
		t.Errorf("cost range = %+v, want the 30d preset", input.Config.CostRange)
	}
	if input.Config.Sort != nil {
		t.Errorf("sort = %+v, want nil", input.Config.Sort)
	}
	if input.Config.Version != 1 || input.Config.PageSize != 50 || input.Config.CostBasis != "cash" {
		t.Errorf("config = %+v", input.Config)
	}

	remote := &iw.ResourceReport{ID: "r1", Name: "Inventory", Config: input.Config}
	state, diags := resourceReportStateFrom(ctx, remote, plan)
	if diags.HasError() {
		t.Fatal(diags)
	}
	if !state.CostRangePreset.IsNull() {
		t.Error("an omitted preset must stay null when the server answers with the default")
	}
	if !state.SortColumn.IsNull() || !state.SortDirection.IsNull() {
		t.Error("no sort must read back as null")
	}
	if !state.PluginIDs.IsNull() || !state.Regions.IsNull() {
		t.Error("omitted filter sets must stay null, not become empty sets")
	}
	if len(state.ResourceType) != 0 || len(state.TagFilter) != 0 {
		t.Error("no blocks must read back as no blocks")
	}
}

func TestResourceReportFullRoundTrip(t *testing.T) {
	ctx := context.Background()
	plan := minimalResourceReportModel(t)
	plan.SortColumn = types.StringValue("cost:range")
	plan.SortDirection = types.StringValue("desc")
	plan.CostRangeFrom = types.StringValue("2026-01-01")
	plan.CostRangeTo = types.StringValue("2026-03-31")
	plan.PluginIDs, _ = types.SetValueFrom(ctx, types.StringType, []string{"aws"})
	plan.ResourceType = []resourceReportTypeModel{
		{PluginID: types.StringValue("aws"), ResourceTypeID: types.StringValue("ec2-instance")},
	}
	values, _ := stringList(ctx, []string{"prod"})
	plan.TagFilter = []resourceReportTagFilterModel{
		{Source: types.StringValue("tag"), Key: types.StringValue("env"), Op: types.StringValue("in"), Values: values},
		{Source: types.StringValue("tag"), Key: types.StringValue("team"), Op: types.StringValue("missing"), Values: types.ListNull(types.StringType)},
	}

	input, diags := resourceReportInputFrom(ctx, plan)
	if diags.HasError() {
		t.Fatal(diags)
	}
	if input.Config.CostRange.Kind != "absolute" || input.Config.CostRange.Preset != nil {
		t.Errorf("cost range = %+v, want an absolute window only", input.Config.CostRange)
	}
	if input.Config.Sort == nil || input.Config.Sort.Direction != "desc" {
		t.Errorf("sort = %+v", input.Config.Sort)
	}
	if input.Config.Filters.Tags[1].Values == nil {
		t.Error("a valueless condition still sends values: []")
	}

	state, diags := resourceReportStateFrom(ctx, &iw.ResourceReport{ID: "r1", Name: "x", Config: input.Config}, plan)
	if diags.HasError() {
		t.Fatal(diags)
	}
	if state.CostRangeFrom.ValueString() != "2026-01-01" || !state.CostRangePreset.IsNull() {
		t.Errorf("cost range state = %v %v", state.CostRangeFrom, state.CostRangePreset)
	}
	if state.SortDirection.ValueString() != "desc" {
		t.Errorf("sort direction = %v", state.SortDirection)
	}
	if !state.TagFilter[1].Values.IsNull() {
		t.Error("an omitted values attribute on exists/missing must stay null")
	}
	if state.TagFilter[0].Values.IsNull() {
		t.Error("configured values must read back")
	}
}

func TestResourceReportRejectsConflictingRange(t *testing.T) {
	ctx := context.Background()
	plan := minimalResourceReportModel(t)
	plan.CostRangePreset = types.StringValue("90d")
	plan.CostRangeFrom = types.StringValue("2026-01-01")
	if _, diags := resourceReportInputFrom(ctx, plan); !diags.HasError() {
		t.Error("a preset with a fixed window, and a window missing its end, must be refused")
	}
}
