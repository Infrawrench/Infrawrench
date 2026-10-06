package iw

import (
	"encoding/json"
	"testing"
)

// The alert routing schemas are strict oneOf unions server-side: a push
// destination carrying a stray channelId, or a severity clause carrying an empty
// values array, is a 400 rather than a field the server ignores. The flattened
// Go structs are what let Terraform express these as one repeatable block, and
// the custom marshallers are what keep the wire honest, so they are worth
// pinning directly.

func decode(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func TestAlertDestinationMarshalsOnlyItsBranch(t *testing.T) {
	t.Run("push carries nothing else", func(t *testing.T) {
		// Deliberately populated with the other branches' fields: a push
		// destination built by editing a slack one must not leak them.
		got := decode(t, AlertDestination{Kind: "push", ChannelID: strptr("c1"), WebhookID: strptr("w1")})
		if len(got) != 1 || got["kind"] != "push" {
			t.Errorf("push destination must be exactly {kind}, got %v", got)
		}
	})

	t.Run("slack carries channelId", func(t *testing.T) {
		got := decode(t, AlertDestination{Kind: "slack", ChannelID: strptr("c1"), WebhookID: strptr("w1")})
		if got["channelId"] != "c1" {
			t.Errorf("channelId lost: %v", got)
		}
		if _, present := got["webhookId"]; present {
			t.Errorf("a slack destination must not carry webhookId: %v", got)
		}
	})

	t.Run("msteams carries webhookId", func(t *testing.T) {
		got := decode(t, AlertDestination{Kind: "msteams", WebhookID: strptr("w1")})
		if got["webhookId"] != "w1" {
			t.Errorf("webhookId lost: %v", got)
		}
		if _, present := got["channelId"]; present {
			t.Errorf("a teams destination must not carry channelId: %v", got)
		}
	})

	t.Run("on-call carries scheduleId", func(t *testing.T) {
		got := decode(t, AlertDestination{Kind: "on-call", ChannelID: strptr("c1"), ScheduleID: strptr("s1")})
		if got["scheduleId"] != "s1" {
			t.Errorf("scheduleId lost: %v", got)
		}
		if _, present := got["channelId"]; present {
			t.Errorf("an on-call destination must not carry channelId: %v", got)
		}
	})

	t.Run("paging-provider carries accountId and targetId only", func(t *testing.T) {
		got := decode(t, AlertDestination{Kind: "paging-provider", AccountID: strptr("a1"), TargetID: strptr("P1"), SourceID: strptr("S1")})
		if got["accountId"] != "a1" || got["targetId"] != "P1" {
			t.Errorf("paging-provider ids lost: %v", got)
		}
		if _, present := got["sourceId"]; present {
			t.Errorf("a paging-provider destination must not carry sourceId: %v", got)
		}
	})

	t.Run("provider-on-call carries accountId and sourceId only", func(t *testing.T) {
		got := decode(t, AlertDestination{Kind: "provider-on-call", AccountID: strptr("a1"), SourceID: strptr("S1"), TargetID: strptr("P1")})
		if got["accountId"] != "a1" || got["sourceId"] != "S1" {
			t.Errorf("provider-on-call ids lost: %v", got)
		}
		if _, present := got["targetId"]; present {
			t.Errorf("a provider-on-call destination must not carry targetId: %v", got)
		}
	})

	t.Run("github-issues carries nothing else", func(t *testing.T) {
		// The repository is decided by the GitHub issue settings, so a stray id
		// from an edited slack destination must not reach the strict schema.
		got := decode(t, AlertDestination{Kind: "github-issues", ChannelID: strptr("c1"), ScheduleID: strptr("s1")})
		if len(got) != 1 || got["kind"] != "github-issues" {
			t.Errorf("github-issues destination must be exactly {kind}, got %v", got)
		}
	})

	t.Run("email-member carries userId", func(t *testing.T) {
		got := decode(t, AlertDestination{Kind: "email-member", UserID: strptr("u1"), Address: strptr("a@example.com")})
		if len(got) != 2 || got["userId"] != "u1" {
			t.Errorf("email-member destination must be exactly {kind, userId}, got %v", got)
		}
	})

	t.Run("email-address carries address", func(t *testing.T) {
		got := decode(t, AlertDestination{Kind: "email-address", Address: strptr("finance@example.com"), UserID: strptr("u1")})
		if len(got) != 2 || got["address"] != "finance@example.com" {
			t.Errorf("email-address destination must be exactly {kind, address}, got %v", got)
		}
	})

	t.Run("an unknown kind fails loudly", func(t *testing.T) {
		if _, err := json.Marshal(AlertDestination{Kind: "email"}); err == nil {
			t.Error("an unknown destination kind must be an error, not a silently dropped destination")
		}
	})
}

func TestAlertConditionMarshalsOnlyItsBranch(t *testing.T) {
	cases := []struct {
		name      string
		condition AlertCondition
		wantKeys  []string
	}{
		{
			name:      "trigger takes values",
			condition: AlertCondition{Field: "trigger", Op: "in", Values: []string{"budgetAlerts"}, Cents: intptr(5)},
			wantKeys:  []string{"field", "op", "values"},
		},
		{
			name:      "severity takes severity",
			condition: AlertCondition{Field: "severity", Op: "gte", Severity: strptr("warning"), Values: []string{"x"}},
			wantKeys:  []string{"field", "op", "severity"},
		},
		{
			name:      "amountCents takes cents",
			condition: AlertCondition{Field: "amountCents", Op: "gte", Cents: intptr(10000)},
			wantKeys:  []string{"field", "op", "cents"},
		},
		{
			name:      "text takes value",
			condition: AlertCondition{Field: "text", Op: "contains", Value: strptr("timeout")},
			wantKeys:  []string{"field", "op", "value"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := decode(t, c.condition)
			if len(got) != len(c.wantKeys) {
				t.Fatalf("expected exactly %v, got %v", c.wantKeys, got)
			}
			for _, k := range c.wantKeys {
				if _, present := got[k]; !present {
					t.Errorf("missing key %q in %v", k, got)
				}
			}
		})
	}

	t.Run("a list clause always carries values", func(t *testing.T) {
		// A nil slice would marshal as null, which the server's schema refuses.
		got := decode(t, AlertCondition{Field: "accountId", Op: "notIn"})
		values, ok := got["values"].([]any)
		if !ok || values == nil {
			t.Errorf("values must be [] rather than null: %v", got)
		}
	})

	t.Run("an unknown field fails loudly", func(t *testing.T) {
		if _, err := json.Marshal(AlertCondition{Field: "phase-of-moon", Op: "eq"}); err == nil {
			t.Error("an unknown condition field must be an error, not a silently dropped clause")
		}
	})
}

// SMSConfigured is derived server-side and rejected by the strict PUT schema.
// The struct decodes it for reads, so the write path has to clear it, which
// PutAnomalySettings does. This pins the tag that makes that possible.
func TestAnomalySettingsOmitsDerivedFlagWhenUnset(t *testing.T) {
	got := decode(t, CostAnomalySettings{Sigmas: 3, MinDeltaCents: 1000, NewSourceMinCents: 2500, SMSAlerts: "off"})
	if _, present := got["smsConfigured"]; present {
		t.Errorf("smsConfigured must be omitted from a write body: %v", got)
	}
}

// FeedbackTuning is optional on PUT and omitting it keeps the stored value, so
// an unset pointer must not reach the wire as false.
func TestAnomalySettingsOmitsUnsetFeedbackTuning(t *testing.T) {
	got := decode(t, CostAnomalySettings{Sigmas: 3, MinDeltaCents: 1000, NewSourceMinCents: 2500, SMSAlerts: "off"})
	if _, present := got["feedbackTuning"]; present {
		t.Errorf("an unset feedbackTuning must be omitted, not sent as false: %v", got)
	}
	off := false
	got = decode(t, CostAnomalySettings{Sigmas: 3, MinDeltaCents: 1000, NewSourceMinCents: 2500, SMSAlerts: "off", FeedbackTuning: &off})
	if v, ok := got["feedbackTuning"].(bool); !ok || v {
		t.Errorf("an explicit false must be sent: %v", got)
	}
}

// PUT on a suppression is a full replace: reason and note must be explicit
// nulls so a stored value is cleared, while tagKey and startsOn are omitted so
// the server applies its own defaults.
func TestAnomalySuppressionInputNullsAndOmissions(t *testing.T) {
	got := decode(t, CostAnomalySuppressionInput{
		Scope: "provider", ScopeKey: "aws", Recurrence: "one_off", AnchorDay: "2026-11-27", ExpiresOn: "2026-11-30",
	})
	for _, key := range []string{"reason", "note"} {
		if v, present := got[key]; !present || v != nil {
			t.Errorf("%s must be an explicit null, got %#v (present=%v)", key, v, present)
		}
	}
	for _, key := range []string{"tagKey", "startsOn"} {
		if _, present := got[key]; present {
			t.Errorf("%s must be omitted when unset: %v", key, got)
		}
	}
}

// The three destination lists on a report notification are required keys. A nil
// slice would marshal as null and be refused, so the provider always builds
// them as empty slices: this is the shape that has to hold.
func TestReportNotificationEmptyListsMarshalAsArrays(t *testing.T) {
	got := decode(t, ReportNotificationInput{
		Cadence: "daily", Hour: 9, Timezone: "UTC",
		SlackChannelIDs: []string{}, TeamsWebhookIDs: []string{}, EmailRecipients: []string{"a@example.com"},
	})
	for _, key := range []string{"slackChannelIds", "teamsWebhookIds", "emailRecipients"} {
		if _, ok := got[key].([]any); !ok {
			t.Errorf("%s must marshal as an array, got %#v", key, got[key])
		}
	}
	// A daily cadence reads neither day field, so neither should appear.
	if _, present := got["sendDay"]; present {
		t.Errorf("sendDay must be omitted when the cadence does not read it: %v", got)
	}
}

// Dashboard notifications share the report notification's required destination
// lists, and add attachPdf, which must reach the wire as an explicit false when
// the practitioner turns it off: the server reads an absent key as true.
func TestDashboardNotificationMarshalsListsAndExplicitAttachPdf(t *testing.T) {
	off := false
	got := decode(t, DashboardNotificationInput{
		Cadence: "daily", Hour: 9, Timezone: "UTC",
		SlackChannelIDs: []string{}, TeamsWebhookIDs: []string{}, EmailRecipients: []string{"a@example.com"},
		AttachPDF: &off,
	})
	for _, key := range []string{"slackChannelIds", "teamsWebhookIds", "emailRecipients"} {
		if _, ok := got[key].([]any); !ok {
			t.Errorf("%s must marshal as an array, got %#v", key, got[key])
		}
	}
	if v, present := got["attachPdf"]; !present || v != false {
		t.Errorf("attachPdf = false must be sent explicitly, got %#v", got["attachPdf"])
	}
	if _, present := got["sendDay"]; present {
		t.Errorf("sendDay must be omitted when the cadence does not read it: %v", got)
	}
}

// BastionID is tri-state on the wire: absent leaves the binding alone, null
// unbinds. A Terraform attribute set to null means the second thing, so the
// field must marshal as an explicit null rather than being omitted.
func TestUpdateAccountSendsAnExplicitNullBastion(t *testing.T) {
	got := decode(t, UpdateAccountRequest{DisplayName: strptr("Production")})
	value, present := got["bastionId"]
	if !present {
		t.Fatalf("bastionId must be present as an explicit null, got %v", got)
	}
	if value != nil {
		t.Errorf("bastionId should be null, got %v", value)
	}
}

// The route match is a strict discriminated union server-side, and a tag
// match's value is nullable-but-required: null means "any value of the key".
func TestGithubIssueRouteMatchMarshalsOnlyItsBranch(t *testing.T) {
	t.Run("cost centre carries only its id", func(t *testing.T) {
		got := decode(t, GithubIssueRouteMatch{Kind: "cost_centre", CostCentreID: strptr("cc-1"), TagKey: strptr("team")})
		if len(got) != 2 || got["costCentreId"] != "cc-1" {
			t.Errorf("cost centre match must be exactly {kind, costCentreId}, got %v", got)
		}
	})

	t.Run("tag sends an explicit null value", func(t *testing.T) {
		got := decode(t, GithubIssueRouteMatch{Kind: "tag", TagKey: strptr("team"), CostCentreID: strptr("cc-1")})
		value, present := got["tagValue"]
		if !present || value != nil {
			t.Errorf("tagValue must be present as an explicit null, got %v", got)
		}
		if _, present := got["costCentreId"]; present {
			t.Errorf("a tag match must not carry costCentreId: %v", got)
		}
	})

	t.Run("an unknown kind fails loudly", func(t *testing.T) {
		if _, err := json.Marshal(GithubIssueRouteMatch{Kind: "service"}); err == nil {
			t.Error("an unknown match kind must be an error")
		}
	})
}

// Destroy writes this document back, so it must be exactly the shipped
// defaults, with every list an array and the default repository an explicit
// null rather than an omitted key.
func TestDefaultGithubIssueSettingsMarshal(t *testing.T) {
	got := decode(t, DefaultGithubIssueSettings())
	if value, present := got["defaultRepo"]; !present || value != nil {
		t.Errorf("defaultRepo must be an explicit null, got %v", got)
	}
	if got["enabled"] != false || got["pullRequestsEnabled"] != false || got["resolveAction"] != "comment" {
		t.Errorf("default scalars wrong: %v", got)
	}
	labels, _ := got["labels"].([]any)
	if len(labels) != 1 || labels[0] != "infrawrench" {
		t.Errorf("default labels must be [\"infrawrench\"], got %v", got["labels"])
	}
	for _, key := range []string{"assignees", "routes", "iacSources"} {
		list, ok := got[key].([]any)
		if !ok || len(list) != 0 {
			t.Errorf("%s must be an empty array, got %v", key, got[key])
		}
	}
}

func strptr(s string) *string { return &s }
func intptr(i int64) *int64   { return &i }
