package provider

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

func TestCommitmentReportRoundTrip(t *testing.T) {
	ctx := context.Background()
	remote := &iw.CommitmentReport{
		ID:   "r1",
		Name: "EC2 coverage",
		Config: iw.CommitmentReportConfig{
			Version:     1,
			DateRange:   iw.CostDateRange{Kind: "absolute", From: ptr("2026-01-01"), To: ptr("2026-06-30")},
			Granularity: "monthly",
			GroupBy:     "account",
			Metric:      "coverage",
			Filters: iw.CommitmentReportFilters{
				Providers:       []string{"aws"},
				CommitmentTypes: []string{"savings_plan", "reservation"},
			},
		},
		CreatedAt: "2026-07-01T00:00:00Z",
		UpdatedAt: "2026-07-01T00:00:00Z",
	}
	state, diags := commitmentReportStateFrom(ctx, remote)
	if diags.HasError() {
		t.Fatalf("state mapping: %v", diags)
	}
	if !state.DatePreset.IsNull() || state.DateFrom.ValueString() != "2026-01-01" {
		t.Errorf("an absolute range must leave date_preset null: %+v", state)
	}
	// Filters the server did not echo are null, the shape an omitted attribute plans as.
	if !state.Services.IsNull() || !state.CommitmentIDs.IsNull() || state.Providers.IsNull() {
		t.Errorf("filter sets mapped wrong: %+v", state)
	}
	if !state.Description.IsNull() || !state.FolderID.IsNull() {
		t.Error("absent nullable fields must map to null")
	}

	in, diags := commitmentReportInputFrom(ctx, state)
	if diags.HasError() {
		t.Fatalf("input mapping: %v", diags)
	}
	if in.Config.DateRange.Kind != "absolute" || in.Config.DateRange.Preset != nil {
		t.Errorf("date range lost its branch: %+v", in.Config.DateRange)
	}
	if len(in.Config.Filters.CommitmentTypes) != 2 || in.Config.Filters.Services != nil {
		t.Errorf("filters mapped wrong: %+v", in.Config.Filters)
	}
	if in.FolderID != nil || in.Description != nil {
		t.Error("a null folder and description must be sent as null / omitted")
	}

	// The server refuses an empty filter list and stores the body as sent, so
	// an unset filter must be an absent key, never `[]`, and an unset
	// description must not reach the body either.
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, absent := range []string{"services", "accountIds", "regions", "commitmentIds", "description", "[]"} {
		if strings.Contains(text, absent) {
			t.Errorf("%q reached the body: %s", absent, text)
		}
	}
	if !strings.Contains(text, `"folderId":null`) {
		t.Errorf("a null folder must be sent as an explicit null: %s", text)
	}

	state.DatePreset = types.StringValue("90d")
	state.DateFrom = types.StringNull()
	state.DateTo = types.StringNull()
	state.Description = types.StringValue("")
	in, _ = commitmentReportInputFrom(ctx, state)
	if in.Config.DateRange.Kind != "relative" || *in.Config.DateRange.Preset != "90d" {
		t.Errorf("a preset must send a relative range: %+v", in.Config.DateRange)
	}
	if in.Description == nil || *in.Description != "" {
		t.Error("an empty description is stored as sent, so it must be sent")
	}
}

func TestCommitmentReportRangeProblem(t *testing.T) {
	cases := []struct {
		from, to, granularity string
		wantAttr              string
	}{
		{"2026-01-01", "2026-12-31", "weekly", ""},
		{"2025-01-01", "2026-01-02", "daily", ""},           // 367 days: the daily limit
		{"2025-01-01", "2026-01-03", "daily", "date_to"},    // 368 days
		{"2025-01-01", "2026-01-03", "", ""},                // granularity unknown: daily limit skipped
		{"2024-01-01", "2026-12-31", "monthly", ""},         // 1096 days
		{"2024-01-01", "2027-01-01", "monthly", "date_to"},  // 1097 days
		{"2026-03-01", "2026-02-28", "weekly", "date_to"},   // ends before it starts
		{"2026-02-30", "2026-03-31", "weekly", "date_from"}, // not a day
		{"2026-02-01", "2026-04-31", "weekly", "date_to"},   // not a day
		{"2026-2-1", "2026-03-01", "weekly", ""},            // malformed: the regex validator reports it
	}
	for _, c := range cases {
		attr, summary, _ := commitmentReportRangeProblem(c.from, c.to, c.granularity)
		if attr != c.wantAttr || (summary == "") != (c.wantAttr == "") {
			t.Errorf("%s..%s %s: got %q %q, want attribute %q", c.from, c.to, c.granularity, attr, summary, c.wantAttr)
		}
	}
}

// The server refuses rather than rewrites a padded name, an empty filter set
// and a blank or padded filter value. Each must fail the plan instead.
func TestCommitmentReportRefusesNonCanonicalValues(t *testing.T) {
	ctx := context.Background()
	schemaResp := &resource.SchemaResponse{}
	NewCommitmentReportResource().Schema(ctx, resource.SchemaRequest{}, schemaResp)
	attrs := schemaResp.Schema.Attributes

	name := attrs["name"].(schema.StringAttribute)
	for _, value := range []string{"", " padded", "padded ", "   "} {
		if !stringRefused(ctx, name.Validators, value) {
			t.Errorf("name %q must be refused", value)
		}
	}
	if stringRefused(ctx, name.Validators, "EC2 coverage") {
		t.Error("a plain name must be accepted")
	}

	services := attrs["services"].(schema.SetAttribute)
	for label, values := range map[string][]string{
		"empty":  {},
		"blank":  {""},
		"padded": {" Amazon EC2"},
		"long":   {strings.Repeat("x", 501)},
	} {
		if !setRefused(ctx, services.Validators, values) {
			t.Errorf("services %s must be refused", label)
		}
	}
	if setRefused(ctx, services.Validators, []string{"Amazon Elastic Compute Cloud - Compute"}) {
		t.Error("a plain service must be accepted")
	}

	kinds := attrs["commitment_types"].(schema.SetAttribute)
	if !setRefused(ctx, kinds.Validators, []string{"spot"}) {
		t.Error("an unknown commitment type must be refused")
	}
}

func stringRefused(ctx context.Context, validators []validator.String, value string) bool {
	for _, v := range validators {
		resp := &validator.StringResponse{}
		v.ValidateString(ctx, validator.StringRequest{ConfigValue: types.StringValue(value)}, resp)
		if resp.Diagnostics.HasError() {
			return true
		}
	}
	return false
}

func setRefused(ctx context.Context, validators []validator.Set, values []string) bool {
	set, diags := types.SetValueFrom(ctx, types.StringType, values)
	if diags.HasError() {
		panic(diags)
	}
	for _, v := range validators {
		resp := &validator.SetResponse{}
		v.ValidateSet(ctx, validator.SetRequest{ConfigValue: set}, resp)
		if resp.Diagnostics.HasError() {
			return true
		}
	}
	return false
}
