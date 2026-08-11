package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

// Mapping tests for the surfaces outside cost allocation. Same reasoning as
// mapping_test.go: these conversions are where a provider quietly goes wrong,
// and each test below pins a decision that is easy to undo by accident.

func TestInt64ListRoundTrip(t *testing.T) {
	ctx := context.Background()

	list, diags := int64List(ctx, []int64{1, 2, 3, 4, 5})
	if diags.HasError() {
		t.Fatalf("int64List: %v", diags)
	}
	back, diags := int64Slice(ctx, list)
	if diags.HasError() {
		t.Fatalf("int64Slice: %v", diags)
	}
	if len(back) != 5 || back[0] != 1 || back[4] != 5 {
		t.Errorf("weekday list did not survive the round trip: %v", back)
	}

	empty, diags := int64Slice(ctx, types.ListNull(types.Int64Type))
	if diags.HasError() {
		t.Fatalf("int64Slice(null): %v", diags)
	}
	if empty == nil {
		t.Error("a null list must become an empty slice, never nil — the body always carries the key")
	}
}

func TestStringMapNullBecomesEmpty(t *testing.T) {
	ctx := context.Background()

	out, diags := stringMap(ctx, types.MapNull(types.StringType))
	if diags.HasError() {
		t.Fatalf("stringMap: %v", diags)
	}
	if out == nil {
		t.Fatal("a null map must become an empty map, not nil")
	}
	if len(out) != 0 {
		t.Errorf("expected no entries, got %v", out)
	}
}

func TestSplitImportID(t *testing.T) {
	parts, err := splitImportID("report-1/notification-2", 2, "<report>/<notification>")
	if err != nil {
		t.Fatalf("splitImportID: %v", err)
	}
	if parts[0] != "report-1" || parts[1] != "notification-2" {
		t.Errorf("split wrong: %v", parts)
	}

	if _, err := splitImportID("only-one", 2, "<report>/<notification>"); err == nil {
		t.Error("a bare id must be refused rather than half-imported")
	}
	if _, err := splitImportID("report-1/", 2, "<report>/<notification>"); err == nil {
		t.Error("an empty segment must be refused — it would build a URL ending in a slash")
	}
}

// The cadence-irrelevant day field must stay null in state. The server always
// returns both — they are non-null columns with defaults — so writing the unused
// one back would show a permanent diff against a configuration that correctly
// leaves it out.
func TestReportNotificationStateDropsTheUnusedDayField(t *testing.T) {
	ctx := context.Background()

	weekly, diags := reportNotificationStateFrom(ctx, &iw.ReportNotification{
		ID: "n1", CostReportID: "r1", Cadence: "weekly",
		SendDay: 3, SendDayOfMonth: 1, Hour: 9, Timezone: "Europe/Berlin",
		EmailRecipients: []string{"a@example.com"}, Enabled: true,
	})
	if diags.HasError() {
		t.Fatalf("reportNotificationStateFrom: %v", diags)
	}
	if weekly.SendDay.ValueInt64() != 3 {
		t.Errorf("weekly cadence should keep send_day, got %v", weekly.SendDay)
	}
	if !weekly.SendDayOfMonth.IsNull() {
		t.Error("weekly cadence must not write send_day_of_month into state")
	}

	monthly, diags := reportNotificationStateFrom(ctx, &iw.ReportNotification{
		ID: "n2", CostReportID: "r1", Cadence: "monthly",
		SendDay: 1, SendDayOfMonth: 28, Hour: 9, Timezone: "UTC",
		EmailRecipients: []string{"a@example.com"}, Enabled: true,
	})
	if diags.HasError() {
		t.Fatalf("reportNotificationStateFrom: %v", diags)
	}
	if monthly.SendDayOfMonth.ValueInt64() != 28 {
		t.Errorf("monthly cadence should keep send_day_of_month, got %v", monthly.SendDayOfMonth)
	}
	if !monthly.SendDay.IsNull() {
		t.Error("monthly cadence must not write send_day into state")
	}
}

// The input side is the mirror: only the day the cadence reads is sent, so the
// server never stores a number nothing looks at.
func TestReportNotificationInputSendsOnlyTheRelevantDay(t *testing.T) {
	ctx := context.Background()

	model := costReportNotificationResourceModel{
		CostReportID:   types.StringValue("r1"),
		Cadence:        types.StringValue("daily"),
		SendDay:        types.Int64Value(3),
		SendDayOfMonth: types.Int64Value(28),
		Hour:           types.Int64Value(9),
		Timezone:       types.StringValue("UTC"),
		Enabled:        types.BoolValue(true),
	}

	input, diags := reportNotificationInputFrom(ctx, model)
	if diags.HasError() {
		t.Fatalf("reportNotificationInputFrom: %v", diags)
	}
	if input.SendDay != nil || input.SendDayOfMonth != nil {
		t.Error("a daily cadence reads neither day field, so neither should be sent")
	}
	// The three destination lists must always be present, even when empty: the
	// server's schema requires the keys.
	if input.SlackChannelIDs == nil || input.TeamsWebhookIDs == nil || input.EmailRecipients == nil {
		t.Error("destination lists must marshal as [] rather than being omitted")
	}
}

// A rate the server padded to ten decimal places is the same rate the
// practitioner wrote. Keeping their spelling is what stops a permanent diff.
func TestExchangeRateStateKeepsTheConfiguredSpelling(t *testing.T) {
	prior := exchangeRateResourceModel{Rate: types.StringValue("1.085")}

	state := exchangeRateStateFrom(&iw.ExchangeRate{
		ID: "r1", FromCurrency: "EUR", ToCurrency: "USD",
		Rate: "1.0850000000", EffectiveFrom: "2026-07-01",
	}, prior)

	if state.Rate.ValueString() != "1.085" {
		t.Errorf("padding leaked into state: %q", state.Rate.ValueString())
	}

	// A genuinely different rate must win, or an out-of-band edit would hide.
	changed := exchangeRateStateFrom(&iw.ExchangeRate{
		ID: "r1", FromCurrency: "EUR", ToCurrency: "USD",
		Rate: "1.0900000000", EffectiveFrom: "2026-07-01",
	}, prior)
	if changed.Rate.ValueString() != "1.0900000000" {
		t.Errorf("a real change must surface as drift, got %q", changed.Rate.ValueString())
	}
}

func TestSameDecimal(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"1.085", "1.0850000000", true},
		{"1", "1.000", true},
		{"0.5", "0.50", true},
		{"1.085", "1.086", false},
		{"not-a-number", "1", false},
		{"1", "", false},
	} {
		if got := sameDecimal(c.a, c.b); got != c.want {
			t.Errorf("sameDecimal(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// Credentials, tokens and webhook URLs are write-only: no route returns them, so
// a refresh that did not carry them forward would silently empty them out of
// state and the next apply would send nothing.
func TestWriteOnlyFieldsSurviveARefresh(t *testing.T) {
	t.Run("teams webhook url", func(t *testing.T) {
		prior := msTeamsWebhookResourceModel{URL: types.StringValue("https://acme.logic.azure.com/hook")}
		state := msTeamsWebhookStateFrom(&iw.MSTeamsWebhook{ID: "w1", Label: "#alerts", URLHint: "…hook"}, prior)
		if state.URL.ValueString() != "https://acme.logic.azure.com/hook" {
			t.Errorf("the webhook URL was dropped: %v", state.URL)
		}
	})

	t.Run("jira api token", func(t *testing.T) {
		prior := jiraIntegrationResourceModel{APIToken: types.StringValue("secret")}
		state := jiraStateFrom("org_1", &iw.JiraIntegration{
			SiteURL: "https://acme.atlassian.net", AccountEmail: "ops@acme.com", TokenHint: "…a7f2",
		}, prior)
		if state.APIToken.ValueString() != "secret" {
			t.Errorf("the Jira token was dropped: %v", state.APIToken)
		}
	})

	t.Run("linear api key", func(t *testing.T) {
		prior := linearIntegrationResourceModel{APIKey: types.StringValue("lin_secret")}
		state := linearStateFrom("org_1", &iw.LinearIntegration{KeyHint: "…a7f2"}, prior)
		if state.APIKey.ValueString() != "lin_secret" {
			t.Errorf("the Linear key was dropped: %v", state.APIKey)
		}
	})

	t.Run("deploy trigger answers", func(t *testing.T) {
		ctx := context.Background()
		answers, diags := types.MapValueFrom(ctx, types.StringType, map[string]string{"db": "postgres://…"})
		if diags.HasError() {
			t.Fatalf("MapValueFrom: %v", diags)
		}
		prior := deployTriggerResourceModel{Answers: answers}
		state := deployTriggerStateFrom(&iw.DeployTrigger{
			ID: "t1", Repo: "acme/api", Branch: "main", Env: "production", Enabled: true,
		}, prior)
		if state.Answers.IsNull() {
			t.Error("the stored deploy answers were dropped")
		}
	})
}

// An Optional+Computed collection must be mapped faithfully: `[]` stays `[]`
// and only a genuinely absent key becomes null.
//
// The temptation is to fold `[]` into null, because on the drift settings the
// two mean the same thing — every account. Terraform's consistency check
// forbids it: a configuration that spells `account_ids = []` produces a *known*
// empty list in the plan, and answering a known plan value with null is
// "inconsistent result after apply". Only an omitted attribute leaves an
// unknown, which null legitimately satisfies.
func TestOptionalComputedCollectionsAreMappedFaithfully(t *testing.T) {
	ctx := context.Background()

	t.Run("an empty list stays empty", func(t *testing.T) {
		state, diags := driftAlertSettingsStateFrom(ctx, "org_1", &iw.DriftAlertSettings{
			NotifyCreated: true, CooldownMinutes: 60, MinChanges: 1, AccountIDs: []string{},
		})
		if diags.HasError() {
			t.Fatalf("driftAlertSettingsStateFrom: %v", diags)
		}
		if state.AccountIDs.IsNull() {
			t.Fatal("an empty list must stay empty, or a config spelling [] fails the consistency check")
		}
		if len(state.AccountIDs.Elements()) != 0 {
			t.Errorf("expected an empty list, got %v", state.AccountIDs)
		}
	})

	t.Run("an absent key becomes null", func(t *testing.T) {
		state, diags := driftAlertSettingsStateFrom(ctx, "org_1", &iw.DriftAlertSettings{
			NotifyCreated: true, CooldownMinutes: 60, MinChanges: 1, AccountIDs: nil,
		})
		if diags.HasError() {
			t.Fatalf("driftAlertSettingsStateFrom: %v", diags)
		}
		if !state.AccountIDs.IsNull() {
			t.Error("a nil slice must become null")
		}
	})

	t.Run("the same rule holds for sets", func(t *testing.T) {
		empty, diags := nilStringSet(ctx, []string{})
		if diags.HasError() {
			t.Fatalf("nilStringSet: %v", diags)
		}
		if empty.IsNull() {
			t.Error("an empty slice must become an empty set, not null")
		}
		absent, diags := nilStringSet(ctx, nil)
		if diags.HasError() {
			t.Fatalf("nilStringSet: %v", diags)
		}
		if !absent.IsNull() {
			t.Error("a nil slice must become a null set")
		}
	})
}

// A graph registered without source stores the empty string server-side. Reading
// that back as "" would diff against a configuration that omits the attribute.
func TestCustomGraphEmptySourceIsNull(t *testing.T) {
	state := customGraphStateFrom(&iw.CustomGraph{ID: "g1", Name: "Burn", Source: ""})
	if !state.Source.IsNull() {
		t.Error("an empty source must read back as null, not as an empty string")
	}

	withSource := customGraphStateFrom(&iw.CustomGraph{ID: "g1", Name: "Burn", Source: "export default …"})
	if withSource.Source.ValueString() != "export default …" {
		t.Errorf("source lost: %v", withSource.Source)
	}
}

// The selector fields are how "match anything" is spelled, and the server
// requires all five keys — so an omitted attribute has to reach it as an
// explicit null rather than as an absent key.
func TestMetricAlertSelectorNullsAreSent(t *testing.T) {
	input := metricAlertInputFrom(metricAlertResourceModel{
		Name:      types.StringValue("CPU"),
		MetricKey: types.StringValue("CPU %"),
		// every selector left null
		PluginID:       types.StringNull(),
		ResourceTypeID: types.StringNull(),
		TagKey:         types.StringNull(),
		TagValue:       types.StringNull(),
		Comparator:     types.StringValue(">"),
		Threshold:      types.Float64Value(90),
	})
	if input.PluginID != nil || input.TagKey != nil {
		t.Error("an unset selector must be a nil pointer, which iw marshals as an explicit null")
	}
}

// Status page components round trip in order, and the probe's own live status is
// deliberately not written into state — it changes without the page changing.
func TestStatusPageComponentsRoundTripInOrder(t *testing.T) {
	ctx := context.Background()

	state, diags := statusPageStateFrom(ctx, &iw.StatusPage{
		ID: "p1", Slug: "abc", Title: "Status",
		Components: []iw.StatusPageComponent{
			{ID: "c1", ProbeID: "probe-a", Position: 0, ProbeName: "internal-a", ProbeStatus: "up"},
			{ID: "c2", ProbeID: "probe-b", Label: ptr("API"), Position: 1, ProbeName: "internal-b", ProbeStatus: "down"},
		},
	})
	if diags.HasError() {
		t.Fatalf("statusPageStateFrom: %v", diags)
	}

	input, diags := statusPageInputFrom(ctx, state)
	if diags.HasError() {
		t.Fatalf("statusPageInputFrom: %v", diags)
	}
	if len(input.Components) != 2 {
		t.Fatalf("expected 2 components, got %d", len(input.Components))
	}
	if input.Components[0].ProbeID != "probe-a" || input.Components[1].ProbeID != "probe-b" {
		t.Error("component order is the public render order and must survive the round trip")
	}
	if input.Components[0].Label != nil {
		t.Error("an unset label must stay null so the probe's own name is used")
	}
}

// The routing table is one ordered list, and each rule's id is sent back so
// in-flight held and escalating deliveries keep pointing at their rule.
func TestAlertRoutingRoundTripPreservesRuleIDs(t *testing.T) {
	ctx := context.Background()

	state, diags := alertRoutingStateFrom(ctx, "org_1", []iw.AlertRule{
		{
			ID: "rule-1", Name: "Pages", Enabled: true, Position: 0,
			Conditions: []iw.AlertCondition{
				{Field: "trigger", Op: "in", Values: []string{"budgetAlerts"}},
				{Field: "severity", Op: "gte", Severity: ptr("warning")},
			},
			Destinations: []iw.AlertDestination{
				{Kind: "slack", ChannelID: ptr("chan-1")},
				{Kind: "push"},
			},
		},
		{ID: "rule-2", Name: "Swallow drift", Enabled: true, Position: 1},
	})
	if diags.HasError() {
		t.Fatalf("alertRoutingStateFrom: %v", diags)
	}
	if state.Rules.ValueInt64() != 2 {
		t.Errorf("rule_count = %v, want 2", state.Rules)
	}

	rules, diags := alertRulesFrom(ctx, state.Rule)
	if diags.HasError() {
		t.Fatalf("alertRulesFrom: %v", diags)
	}
	if len(rules) != 2 {
		t.Fatalf("expected 2 rules, got %d", len(rules))
	}
	if rules[0].ID == nil || *rules[0].ID != "rule-1" {
		t.Error("a rule's id must be sent back so in-flight deliveries keep their rule")
	}
	if len(rules[0].Conditions) != 2 || rules[0].Conditions[1].Severity == nil {
		t.Errorf("conditions lost: %+v", rules[0].Conditions)
	}
	if len(rules[1].Destinations) != 0 {
		t.Error("an empty destination list is meaningful — it swallows matching alerts — and must survive")
	}
}
