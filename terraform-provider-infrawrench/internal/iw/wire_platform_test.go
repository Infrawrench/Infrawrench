package iw

import (
	"encoding/json"
	"testing"
)

// The alert routing schemas are strict oneOf unions server-side: a push
// destination carrying a stray channelId, or a severity clause carrying an empty
// values array, is a 400 rather than a field the server ignores. The flattened
// Go structs are what let Terraform express these as one repeatable block, and
// the custom marshallers are what keep the wire honest — so they are worth
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
// The struct decodes it for reads, so the write path has to clear it — which
// PutAnomalySettings does. This pins the tag that makes that possible.
func TestAnomalySettingsOmitsDerivedFlagWhenUnset(t *testing.T) {
	got := decode(t, CostAnomalySettings{Sigmas: 3, MinDeltaCents: 1000, NewSourceMinCents: 2500, SMSAlerts: "off"})
	if _, present := got["smsConfigured"]; present {
		t.Errorf("smsConfigured must be omitted from a write body: %v", got)
	}
}

// The three destination lists on a report notification are required keys. A nil
// slice would marshal as null and be refused, so the provider always builds
// them as empty slices — this is the shape that has to hold.
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

func strptr(s string) *string { return &s }
func intptr(i int64) *int64   { return &i }
