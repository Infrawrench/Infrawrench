package provider

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

func TestNetworkFlowReportRoundTrip(t *testing.T) {
	ctx := context.Background()
	remote := &iw.NetworkFlowReport{
		ID:   "r1",
		Name: "Cross-zone by pair",
		Config: iw.NetworkFlowReportConfig{
			Version:     1,
			DateRange:   iw.CostDateRange{Kind: "absolute", From: ptr("2026-08-01"), To: ptr("2026-09-30")},
			Granularity: "weekly",
			GroupBy:     "pair",
			Metric:      "both",
			Filters: iw.NetworkFlowReportFilters{
				Networks:       []string{"vpc-1"},
				TrafficClasses: []string{"cross_zone", "cross_region"},
			},
		},
		CreatedAt: "2026-10-01T00:00:00Z",
		UpdatedAt: "2026-10-01T00:00:00Z",
	}
	state, diags := networkFlowReportStateFrom(ctx, remote)
	if diags.HasError() {
		t.Fatalf("state mapping: %v", diags)
	}
	if !state.DatePreset.IsNull() || state.DateFrom.ValueString() != "2026-08-01" {
		t.Errorf("an absolute range must leave date_preset null: %+v", state)
	}
	// Filters and top_n the server did not echo are null, the shape an omitted attribute plans as.
	if !state.Zones.IsNull() || !state.SourceRefs.IsNull() || state.Networks.IsNull() || !state.TopN.IsNull() {
		t.Errorf("filters mapped wrong: %+v", state)
	}
	if !state.Description.IsNull() || !state.FolderID.IsNull() {
		t.Error("absent nullable fields must map to null")
	}

	in, diags := networkFlowReportInputFrom(ctx, state)
	if diags.HasError() {
		t.Fatalf("input mapping: %v", diags)
	}
	if in.Config.DateRange.Kind != "absolute" || in.Config.DateRange.Preset != nil {
		t.Errorf("date range lost its branch: %+v", in.Config.DateRange)
	}
	if len(in.Config.Filters.TrafficClasses) != 2 || in.Config.Filters.Zones != nil {
		t.Errorf("filters mapped wrong: %+v", in.Config.Filters)
	}
	if in.FolderID != nil || in.Config.TopN != nil {
		t.Error("a null folder and a null top_n must be sent as null / omitted")
	}
	// Unset filters and top_n stay out of the body, so the server echoes the same config.
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "zones") || strings.Contains(string(body), "topN") {
		t.Errorf("unset fields reached the body: %s", body)
	}

	state.DatePreset = types.StringValue("30d")
	state.DateFrom = types.StringNull()
	state.DateTo = types.StringNull()
	state.TopN = types.Int64Value(50)
	in, _ = networkFlowReportInputFrom(ctx, state)
	if in.Config.DateRange.Kind != "relative" || *in.Config.DateRange.Preset != "30d" {
		t.Errorf("a preset must send a relative range: %+v", in.Config.DateRange)
	}
	if in.Config.TopN == nil || *in.Config.TopN != 50 {
		t.Errorf("top_n must be sent when set: %+v", in.Config.TopN)
	}

	remote.Config.TopN = ptrInt(50)
	state, _ = networkFlowReportStateFrom(ctx, remote)
	if state.TopN.ValueInt64() != 50 {
		t.Errorf("top_n must read back: %+v", state.TopN)
	}
}
