package iw

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	client, err := NewClient(Config{
		BaseURL:    server.URL,
		Token:      "iwk_test",
		OrgID:      "org_01TEST",
		HTTPClient: server.Client(),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client, server
}

func TestNewClientValidation(t *testing.T) {
	cases := map[string]Config{
		"missing base url": {Token: "t", OrgID: "o"},
		"missing token":    {BaseURL: "https://example.com", OrgID: "o"},
		"missing org":      {BaseURL: "https://example.com", Token: "t"},
		"bad scheme":       {BaseURL: "ftp://example.com", Token: "t", OrgID: "o"},
		"no host":          {BaseURL: "https://", Token: "t", OrgID: "o"},
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewClient(cfg); err == nil {
				t.Fatalf("expected an error for %s", name)
			}
		})
	}
}

// The org id has to survive into the path intact, and a trailing slash on the
// configured base URL must not produce a doubled separator.
func TestURLConstruction(t *testing.T) {
	client, err := NewClient(Config{
		BaseURL: "https://example.com/",
		Token:   "t",
		OrgID:   "org_01ABC",
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	got := client.URLFor("/budgets")
	want := "https://example.com/api/org/org_01ABC/budgets"
	if got != want {
		t.Fatalf("URLFor = %q, want %q", got, want)
	}
}

func TestRequestCarriesBearerAuth(t *testing.T) {
	var gotAuth, gotAccept, gotPath string
	client, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`[]`))
	})

	if _, err := client.ListBudgets(context.Background()); err != nil {
		t.Fatalf("ListBudgets: %v", err)
	}
	if gotAuth != "Bearer iwk_test" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer iwk_test")
	}
	if gotAccept != "application/json" {
		t.Errorf("Accept = %q", gotAccept)
	}
	if gotPath != "/api/org/org_01TEST/budgets" {
		t.Errorf("path = %q", gotPath)
	}
}

func TestNotFoundIsDetectable(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"Budget not found"}`))
	})

	_, err := client.GetBudget(context.Background(), "missing")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !IsNotFound(err) {
		t.Fatalf("IsNotFound = false for %v", err)
	}
	if !strings.Contains(err.Error(), "Budget not found") {
		t.Errorf("error text lost the server message: %v", err)
	}
}

// A 409 on delete carries the objects still pointing at the doomed one. Losing
// those turns an actionable failure into a mystery, so they must survive
// decoding and reach the message.
func TestConflictCarriesReferents(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"Still referenced","referents":[{"kind":"budget","id":"b1","name":"Platform"}]}`))
	})

	err := client.DeleteSavedFilter(context.Background(), "sf1")
	if !IsConflict(err) {
		t.Fatalf("IsConflict = false for %v", err)
	}
	apiErr, ok := AsAPIError(err)
	if !ok {
		t.Fatal("expected an *APIError")
	}
	if len(apiErr.Referents) != 1 || apiErr.Referents[0].Name != "Platform" {
		t.Fatalf("referents not decoded: %+v", apiErr.Referents)
	}
	if !strings.Contains(err.Error(), `budget "Platform"`) {
		t.Errorf("referents missing from message: %v", err)
	}
}

func TestQueryErrorIsDecoded(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"Parse error","queryError":{"offset":12,"length":3,"expected":["in","not_in"]}}`))
	})

	_, err := client.CreateSavedFilter(context.Background(), SavedCostFilterInput{})
	apiErr, ok := AsAPIError(err)
	if !ok {
		t.Fatalf("expected an *APIError, got %v", err)
	}
	if apiErr.QueryError == nil || apiErr.QueryError.Offset != 12 {
		t.Fatalf("queryError not decoded: %+v", apiErr.QueryError)
	}
	if !strings.Contains(err.Error(), "offset 12") {
		t.Errorf("offset missing from message: %v", err)
	}
}

// The one failure a practitioner cannot diagnose from the wire: an API key that
// is valid everywhere else is rejected by this route tree. The hint has to be
// attached, and only for API keys.
func TestUnauthorizedHintOnlyForAPIKeys(t *testing.T) {
	handler := func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Unauthorized"}`))
	}

	t.Run("api key gets the hint", func(t *testing.T) {
		client, _ := newTestClient(t, handler)
		_, err := client.ListBudgets(context.Background())
		if err == nil || !strings.Contains(err.Error(), "WorkOS access token") {
			t.Fatalf("expected the API-key hint, got %v", err)
		}
	})

	t.Run("workos token does not", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(handler))
		defer server.Close()
		client, err := NewClient(Config{
			BaseURL:    server.URL,
			Token:      "eyJhbGciOi.workos.token",
			OrgID:      "org_01TEST",
			HTTPClient: server.Client(),
		})
		if err != nil {
			t.Fatalf("NewClient: %v", err)
		}
		_, err = client.ListBudgets(context.Background())
		if err == nil {
			t.Fatal("expected an error")
		}
		if strings.Contains(err.Error(), "WorkOS access token") {
			t.Errorf("hint should not appear for a non-key token: %v", err)
		}
	})
}

// Cost alerts and scenario models wrap their lists in an envelope while their
// neighbours return bare arrays. The wrappers absorb that; if they stop doing
// so, every Read of those resources silently returns nothing.
func TestListEnvelopesAreUnwrapped(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/cost-alerts"):
			_, _ = w.Write([]byte(`{"alerts":[{"id":"a1","name":"Spike"}]}`))
		case strings.HasSuffix(r.URL.Path, "/cost-scenarios"):
			_, _ = w.Write([]byte(`{"models":[{"id":"m1","name":"Migration"}]}`))
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
		}
	})

	alerts, err := client.ListCostAlerts(context.Background())
	if err != nil {
		t.Fatalf("ListCostAlerts: %v", err)
	}
	if len(alerts) != 1 || alerts[0].Name != "Spike" {
		t.Fatalf("alerts = %+v", alerts)
	}

	models, err := client.ListScenarioModels(context.Background())
	if err != nil {
		t.Fatalf("ListScenarioModels: %v", err)
	}
	if len(models) != 1 || models[0].Name != "Migration" {
		t.Fatalf("models = %+v", models)
	}
}

// Cost centres, allocation rules and report folders have no single-GET route.
// Their wrappers list and filter, and must synthesise a 404 when the id is
// gone — otherwise a deletion outside Terraform never reaches RemoveResource.
func TestListAndFilterSynthesisesNotFound(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"id":"cc1","name":"Platform"}]`))
	})

	found, err := client.GetCostCentre(context.Background(), "cc1")
	if err != nil {
		t.Fatalf("GetCostCentre: %v", err)
	}
	if found.Name != "Platform" {
		t.Fatalf("centre = %+v", found)
	}

	_, err = client.GetCostCentre(context.Background(), "gone")
	if !IsNotFound(err) {
		t.Fatalf("expected a synthesised 404, got %v", err)
	}

	_, err = client.GetAllocationRule(context.Background(), "gone")
	if !IsNotFound(err) {
		t.Fatalf("allocation rule: expected a synthesised 404, got %v", err)
	}

	_, err = client.GetCostReportFolder(context.Background(), "gone")
	if !IsNotFound(err) {
		t.Fatalf("report folder: expected a synthesised 404, got %v", err)
	}
}

/* ------------------------- tagged union marshalling ------------------------ */

// The server's date-range schema is strict: an absolute range carrying a stray
// `preset` key is rejected outright. Marshalling has to emit one branch only.
func TestCostDateRangeMarshalsOneBranch(t *testing.T) {
	preset := "last_30_days"
	relative, err := json.Marshal(CostDateRange{Kind: "relative", Preset: &preset})
	if err != nil {
		t.Fatalf("relative: %v", err)
	}
	if got := string(relative); got != `{"kind":"relative","preset":"last_30_days"}` {
		t.Errorf("relative = %s", got)
	}

	from, to := "2026-01-01", "2026-01-31"
	absolute, err := json.Marshal(CostDateRange{Kind: "absolute", From: &from, To: &to, Preset: &preset})
	if err != nil {
		t.Fatalf("absolute: %v", err)
	}
	if strings.Contains(string(absolute), "preset") {
		t.Errorf("absolute range leaked the preset key: %s", absolute)
	}

	if _, err := json.Marshal(CostDateRange{Kind: "quarterly"}); err == nil {
		t.Error("expected an error for an unknown date range kind")
	}
}

// Same contract for export destinations — and the http branch must never carry
// s3 keys, nor echo the write-only url back onto the wire.
func TestCostExportDestinationMarshalsOneBranch(t *testing.T) {
	bucket, region := "spend-exports", "eu-west-1"
	s3, err := json.Marshal(CostExportDestination{Kind: "s3", Bucket: &bucket, Region: &region})
	if err != nil {
		t.Fatalf("s3: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(s3, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded["kind"] != "s3" || decoded["bucket"] != "spend-exports" {
		t.Errorf("s3 destination = %s", s3)
	}
	if _, present := decoded["method"]; present {
		t.Errorf("s3 destination leaked an http key: %s", s3)
	}

	method, hint := "POST", "https://example.com/…"
	httpDest, err := json.Marshal(CostExportDestination{Kind: "http", Method: &method, URLHint: &hint})
	if err != nil {
		t.Fatalf("http: %v", err)
	}
	if strings.Contains(string(httpDest), "urlHint") {
		t.Errorf("url hint is server-computed and must not be sent: %s", httpDest)
	}

	if _, err := json.Marshal(CostExportDestination{Kind: "gcs"}); err == nil {
		t.Error("expected an error for an unknown destination kind")
	}
}

/* --------------------------- omission semantics ---------------------------- */

// The API has no PATCH: every write is a full replace, so what a struct omits
// decides what the server clears. These two cases are the ones that differ, and
// getting either backwards silently changes what `terraform apply` does.
func TestOmissionSemantics(t *testing.T) {
	t.Run("budget clears by omission", func(t *testing.T) {
		encoded, err := json.Marshal(BudgetInput{Name: "n", Currency: "USD"})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if strings.Contains(string(encoded), "savedFilterId") {
			t.Errorf("savedFilterId must be omitted, not null, so the server clears it: %s", encoded)
		}
		if strings.Contains(string(encoded), "scenarioModelId") {
			t.Errorf("scenarioModelId must be omitted so the server clears it: %s", encoded)
		}
	})

	t.Run("cost centre moves to root by explicit null", func(t *testing.T) {
		encoded, err := json.Marshal(CostCentreInput{Name: "n"})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if !strings.Contains(string(encoded), `"parentId":null`) {
			t.Errorf("parentId must be an explicit null — an absent key leaves the centre where it is: %s", encoded)
		}
	})

	t.Run("export credentials are kept by omission", func(t *testing.T) {
		encoded, err := json.Marshal(CostExportInput{Name: "n", Destination: CostExportDestination{Kind: "s3"}})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		for _, key := range []string{"accessKeyId", "secretAccessKey", "url"} {
			if strings.Contains(string(encoded), key) {
				t.Errorf("%s must be omitted when unset, so the stored credential survives: %s", key, encoded)
			}
		}
	})
}
