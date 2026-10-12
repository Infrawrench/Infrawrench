package provider

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

// Mapping tests for services and scorecards. Each pins a decision that keeps a
// plan from diffing forever against what the server normalises.

func TestScorecardCheckIDsAreDeterministic(t *testing.T) {
	checks := []scorecardCheckModel{
		{ID: types.StringNull(), Type: types.StringValue("has_owner")},
		{ID: types.StringUnknown(), Type: types.StringValue("required_tags")},
		{ID: types.StringNull(), Type: types.StringValue("required_tags")},
		// A configured id that collides with what the generator would pick
		// for the first unconfigured has_on_call check.
		{ID: types.StringValue("has_on_call"), Type: types.StringValue("has_runbook")},
		{ID: types.StringNull(), Type: types.StringValue("has_on_call")},
	}
	got := scorecardCheckIDs(checks)
	want := []string{"has_owner", "required_tags", "required_tags_2", "has_on_call", "has_on_call_2"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("check %d: id %q, want %q (all: %v)", i, got[i], want[i], got)
		}
	}
}

func TestScorecardParamsOmitUnsetButKeepExplicitEmpty(t *testing.T) {
	empty := []string{}
	raw, err := json.Marshal(iw.ScorecardCheckParams{Severities: &empty})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"severities":[]}` {
		t.Errorf("params = %s; an explicit empty list must be sent, and unset keys omitted so the "+
			"server fills the type's default", raw)
	}
}

func TestScorecardStateWritesParamsOnlyForTheirType(t *testing.T) {
	ctx := context.Background()
	days := 90.0
	percent := 0.0
	tags := []string{}
	severities := []string{"critical", "high"}
	critical := []string{"critical"}
	maxRate := 15.0
	window := 30.0
	remote := &iw.Scorecard{
		ID:   "sc",
		Name: "Readiness",
		Checks: []iw.ScorecardCheck{
			{ID: "a", Type: "backups_verified", Weight: 2, Params: iw.ScorecardCheckParams{DrillWithinDays: &days}},
			{ID: "b", Type: "slo_within_budget", Weight: 1, Params: iw.ScorecardCheckParams{MinBudgetRemainingPercent: &percent}},
			{ID: "c", Type: "no_critical_posture", Weight: 1, Params: iw.ScorecardCheckParams{Severities: &severities}},
			// The server returns `tags: []` as the default; stray keys from
			// another type must not leak into state either.
			{ID: "d", Type: "required_tags", Weight: 1, Params: iw.ScorecardCheckParams{Tags: &tags, DrillWithinDays: &days}},
			{ID: "e", Type: "has_owner", Weight: 1},
			// Severities is shared by two check types; the failure-rate pair
			// is read only on its own type.
			{ID: "f", Type: "no_critical_vulnerabilities", Weight: 2, Params: iw.ScorecardCheckParams{Severities: &critical}},
			{ID: "g", Type: "change_failure_rate", Weight: 1, Params: iw.ScorecardCheckParams{MaxFailureRatePercent: &maxRate, WindowDays: &window}},
		},
		Levels: []iw.ScorecardLevel{{Key: "gold", Name: "Gold", MinScore: 90}},
	}
	state, diags := scorecardStateFrom(ctx, remote)
	if diags.HasError() {
		t.Fatalf("scorecardStateFrom: %v", diags)
	}
	var checks []scorecardCheckModel
	if d := state.Check.ElementsAs(ctx, &checks, false); d.HasError() {
		t.Fatalf("checks: %v", d)
	}
	if checks[0].DrillWithinDays.ValueInt64() != 90 || !checks[0].MinBudgetRemainingPercent.IsNull() {
		t.Errorf("backups_verified params: %+v", checks[0])
	}
	if checks[1].MinBudgetRemainingPercent.IsNull() || checks[1].MinBudgetRemainingPercent.ValueFloat64() != 0 {
		t.Errorf("slo_within_budget must record the default 0, got %v", checks[1].MinBudgetRemainingPercent)
	}
	if len(checks[2].Severities.Elements()) != 2 {
		t.Errorf("no_critical_posture severities: %v", checks[2].Severities)
	}
	if checks[3].Tags.IsNull() || len(checks[3].Tags.Elements()) != 0 || !checks[3].DrillWithinDays.IsNull() {
		t.Errorf("required_tags must record an empty set and nothing else: %+v", checks[3])
	}
	if !checks[4].Tags.IsNull() || !checks[4].Severities.IsNull() || !checks[4].DrillWithinDays.IsNull() {
		t.Errorf("has_owner takes no params: %+v", checks[4])
	}
	if len(checks[5].Severities.Elements()) != 1 || !checks[5].WindowDays.IsNull() {
		t.Errorf("no_critical_vulnerabilities params: %+v", checks[5])
	}
	if checks[6].MaxFailureRatePercent.ValueFloat64() != 15 || checks[6].WindowDays.ValueInt64() != 30 ||
		!checks[6].Severities.IsNull() {
		t.Errorf("change_failure_rate params: %+v", checks[6])
	}
	if state.ApplicableTiers.IsNull() || len(state.ApplicableTiers.Elements()) != 0 {
		t.Errorf("absent tiers must read back as an empty set, got %v", state.ApplicableTiers)
	}
}

func TestServiceInputSendsEveryListAndOmitsUnknownSlug(t *testing.T) {
	ctx := context.Background()
	emptyLinks, _ := types.ListValueFrom(ctx, serviceLinkObjectType, []serviceLinkModel{})
	emptyRules, _ := types.ListValueFrom(ctx, serviceRuleObjectType, []serviceRuleModel{})
	plan := serviceResourceModel{
		Name:         types.StringValue("Checkout API"),
		Slug:         types.StringUnknown(),
		OwnerUserIDs: types.SetNull(types.StringType),
		SloIDs:       types.SetNull(types.StringType),
		RunbookIDs:   types.SetNull(types.StringType),
		Link:         emptyLinks,
		Rule:         emptyRules,
	}
	in, diags := serviceInputFrom(ctx, plan)
	if diags.HasError() {
		t.Fatalf("serviceInputFrom: %v", diags)
	}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if strings.Contains(body, `"slug"`) {
		t.Errorf("an unknown slug must be omitted so the server derives it: %s", body)
	}
	for _, key := range []string{`"ownerUserIds":[]`, `"sloIds":[]`, `"runbookIds":[]`, `"links":[]`, `"rules":[]`, `"tier":null`, `"monthlyBudget":null`} {
		if !strings.Contains(body, key) {
			t.Errorf("body is missing %s, so a PATCH would leave the stored value alone: %s", key, body)
		}
	}
}
