package iw

import (
	"encoding/json"
	"fmt"
)

// This file is the provider's single source of truth for wire shapes. Two
// conventions run through all of it, and both exist because the API has no
// PATCH: every write is a full replace, so what a struct omits is as load
// bearing as what it sends.
//
//  1. A field the server treats as "omitted means clear it" is a pointer with
//     `omitempty`. Terraform always sends the whole configuration, so a null in
//     config becomes an omitted key becomes a cleared value — which is what the
//     practitioner asked for.
//
//  2. A field the server treats as "omitted means leave it alone" is a pointer
//     *without* `omitempty`, so a nil marshals as an explicit JSON null. Cost
//     centre parentId is the case that forced this: absent moves nothing, null
//     moves the centre to the root, and only one of those is what an empty
//     Terraform attribute means.
//
// Departing from either convention silently changes what `terraform apply`
// does to fields the practitioner did not mention.

/* ------------------------------- primitives ------------------------------- */

// CostFilter is one clause of a cost query. Shared by budgets, reports,
// alerts, saved filters, scenario adjustment scopes and exports.
type CostFilter struct {
	Dimension string   `json:"dimension"`
	Op        string   `json:"op"`
	Values    []string `json:"values"`
	TagKey    *string  `json:"tagKey,omitempty"`
}

// Placement is where a budget or report is pinned on a dashboard. Read-only.
type Placement struct {
	WidgetID      string `json:"widgetId"`
	DashboardID   string `json:"dashboardId"`
	DashboardName string `json:"dashboardName"`
}

/* --------------------------------- budgets -------------------------------- */

// BudgetThreshold fires an alert at a percentage of the budget.
type BudgetThreshold struct {
	Type    string `json:"type"`
	Percent int64  `json:"percent"`
}

// BudgetInput is the POST/PUT body.
//
// SavedFilterID, ScenarioModelID and UseAdjustedSpend are all "omitted means
// clear" on PUT, hence omitempty pointers.
type BudgetInput struct {
	Name             string            `json:"name"`
	AmountCents      int64             `json:"amountCents"`
	Currency         string            `json:"currency"`
	Filters          []CostFilter      `json:"filters"`
	SavedFilterID    *string           `json:"savedFilterId,omitempty"`
	ScenarioModelID  *string           `json:"scenarioModelId,omitempty"`
	Thresholds       []BudgetThreshold `json:"thresholds"`
	CostBasis        *string           `json:"costBasis,omitempty"`
	UseAdjustedSpend *bool             `json:"useAdjustedSpend,omitempty"`
}

// Budget is the union of the two shapes this endpoint returns.
//
// GET returns BudgetWithStatus (live spend, no timestamps); POST and PUT return
// the raw row (timestamps, no spend). Decoding both into one struct with
// pointers everywhere that differs is the only way a Create followed by a Read
// does not look like drift — the fields the write response omits stay nil and
// the Read fills them in.
type Budget struct {
	ID                string            `json:"id"`
	OrganizationID    string            `json:"organizationId,omitempty"`
	Name              string            `json:"name"`
	AmountCents       int64             `json:"amountCents"`
	Currency          string            `json:"currency"`
	Filters           []CostFilter      `json:"filters"`
	SavedFilterID     *string           `json:"savedFilterId"`
	ScenarioModelID   *string           `json:"scenarioModelId"`
	ScenarioModelName *string           `json:"scenarioModelName,omitempty"`
	Thresholds        []BudgetThreshold `json:"thresholds"`
	CostBasis         *string           `json:"costBasis"`
	UseAdjustedSpend  *bool             `json:"useAdjustedSpend"`

	// Status fields — present on GET only.
	Month                 *string     `json:"month,omitempty"`
	ActualCents           *int64      `json:"actualCents,omitempty"`
	RawActualCents        *int64      `json:"rawActualCents,omitempty"`
	ForecastCents         *int64      `json:"forecastCents,omitempty"`
	ScenarioForecastCents *int64      `json:"scenarioForecastCents,omitempty"`
	Placements            []Placement `json:"placements,omitempty"`

	// Row fields — present on POST/PUT only.
	CreatedByUserID *string `json:"createdByUserId,omitempty"`
	CreatedAt       *string `json:"createdAt,omitempty"`
	UpdatedAt       *string `json:"updatedAt,omitempty"`
}

/* ------------------------------ cost centres ------------------------------ */

// CostCentreInput is the POST/PUT body.
//
// ParentID has no omitempty on purpose: the server reads an absent key as
// "leave the centre where it is" and an explicit null as "move it to the root".
// A Terraform attribute that is null means the second thing.
type CostCentreInput struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	ParentID    *string `json:"parentId"`
}

// CostCentre is a row from the flat list; the tree is implied by ParentID.
type CostCentre struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	ParentID    *string `json:"parentId"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

/* ---------------------------- allocation rules ---------------------------- */

// AllocationRuleMatch is an AND of whichever fields are set. Empty matches
// everything, which is a legitimate catch-all at the lowest priority.
type AllocationRuleMatch struct {
	TagKey    *string `json:"tagKey,omitempty"`
	TagValue  *string `json:"tagValue,omitempty"`
	AccountID *string `json:"accountId,omitempty"`
	PluginID  *string `json:"pluginId,omitempty"`
	Service   *string `json:"service,omitempty"`
}

// AllocationRuleInput is the POST/PUT body.
type AllocationRuleInput struct {
	CostCentreID string              `json:"costCentreId"`
	Priority     int64               `json:"priority"`
	Match        AllocationRuleMatch `json:"match"`
}

// AllocationRule is a stored rule. Lower Priority evaluates first and the
// first match wins.
type AllocationRule struct {
	ID           string              `json:"id"`
	CostCentreID string              `json:"costCentreId"`
	Priority     int64               `json:"priority"`
	Match        AllocationRuleMatch `json:"match"`
	CreatedAt    string              `json:"createdAt"`
	UpdatedAt    string              `json:"updatedAt"`
}

/* -------------------------------- tag policy ------------------------------- */

// RequiredTag is one tag key the policy demands, optionally restricted to a
// set of values.
type RequiredTag struct {
	Key           string   `json:"key"`
	AllowedValues []string `json:"allowedValues,omitempty"`
}

// TagPolicy is an org singleton — no id, no POST, no DELETE.
type TagPolicy struct {
	RequiredTags    []RequiredTag `json:"requiredTags"`
	EnforceOnCreate bool          `json:"enforceOnCreate"`
}

/* ------------------------------ saved filters ------------------------------ */

// SavedCostFilterInput is the POST/PUT body. Filters and Query are mutually
// exclusive: sending a query alongside a non-empty filter list is a 400, not a
// precedence rule.
type SavedCostFilterInput struct {
	Name        string       `json:"name"`
	Description *string      `json:"description,omitempty"`
	Filters     []CostFilter `json:"filters"`
	Query       *string      `json:"query,omitempty"`
}

// SavedCostFilter always carries both representations: the server renders a
// canonical Query from Filters and parses Filters out of a Query, so whichever
// one the practitioner wrote, the other comes back computed.
type SavedCostFilter struct {
	ID              string       `json:"id"`
	Name            string       `json:"name"`
	Description     *string      `json:"description"`
	Filters         []CostFilter `json:"filters"`
	Query           string       `json:"query"`
	CreatedByUserID *string      `json:"createdByUserId"`
	CreatedAt       string       `json:"createdAt"`
	UpdatedAt       string       `json:"updatedAt"`
}

/* ------------------------------- cost reports ------------------------------ */

// CostDateRange is a tagged union: a relative preset or an absolute span.
//
// It marshals to exactly the branch its Kind names, because the server's schema
// is strict — an absolute range carrying a stray `preset` key is rejected.
type CostDateRange struct {
	Kind   string  `json:"kind"`
	Preset *string `json:"preset,omitempty"`
	From   *string `json:"from,omitempty"`
	To     *string `json:"to,omitempty"`
}

// MarshalJSON emits only the keys belonging to the named branch.
func (r CostDateRange) MarshalJSON() ([]byte, error) {
	switch r.Kind {
	case "relative":
		preset := ""
		if r.Preset != nil {
			preset = *r.Preset
		}
		return json.Marshal(struct {
			Kind   string `json:"kind"`
			Preset string `json:"preset"`
		}{Kind: "relative", Preset: preset})
	case "absolute":
		from, to := "", ""
		if r.From != nil {
			from = *r.From
		}
		if r.To != nil {
			to = *r.To
		}
		return json.Marshal(struct {
			Kind string `json:"kind"`
			From string `json:"from"`
			To   string `json:"to"`
		}{Kind: "absolute", From: from, To: to})
	default:
		return nil, fmt.Errorf("unknown date range kind %q (want \"relative\" or \"absolute\")", r.Kind)
	}
}

// CostGraphConfig is the chart definition shared by reports and dashboard
// cards.
type CostGraphConfig struct {
	Version               int64         `json:"version"`
	ChartType             string        `json:"chartType"`
	Binning               string        `json:"binning"`
	DateRange             CostDateRange `json:"dateRange"`
	GroupBy               string        `json:"groupBy"`
	GroupByTagKey         *string       `json:"groupByTagKey,omitempty"`
	Filters               []CostFilter  `json:"filters"`
	SavedFilterID         *string       `json:"savedFilterId,omitempty"`
	TopN                  int64         `json:"topN"`
	ComparePreviousPeriod bool          `json:"comparePreviousPeriod"`
	ShowForecast          bool          `json:"showForecast"`
	ScenarioModelID       *string       `json:"scenarioModelId,omitempty"`
	CostBasis             *string       `json:"costBasis,omitempty"`
	UnitCostMetricID      *string       `json:"unitCostMetricId,omitempty"`
	UnitCostMode          *string       `json:"unitCostMode,omitempty"`
	Adjusted              *bool         `json:"adjusted,omitempty"`
}

// CostReportInput is the POST/PUT body. FolderID is nullable so that moving a
// report out of a folder is expressible.
type CostReportInput struct {
	Name        string          `json:"name"`
	Description *string         `json:"description,omitempty"`
	Config      CostGraphConfig `json:"config"`
	FolderID    *string         `json:"folderId"`
}

// CostReport is a saved report.
type CostReport struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Description     *string         `json:"description"`
	Config          CostGraphConfig `json:"config"`
	FolderID        *string         `json:"folderId"`
	CreatedByUserID *string         `json:"createdByUserId"`
	CreatedAt       string          `json:"createdAt"`
	UpdatedAt       string          `json:"updatedAt"`
	Placements      []Placement     `json:"placements,omitempty"`
}

/* --------------------------- cost report folders --------------------------- */

// CostReportFolderInput is the POST/PUT body.
type CostReportFolderInput struct {
	Name           string  `json:"name"`
	ParentFolderID *string `json:"parentFolderId"`
}

// CostReportFolder is a row from the flat list; max nesting depth is 3.
type CostReportFolder struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	ParentFolderID *string `json:"parentFolderId"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

/* -------------------------------- cost alerts ------------------------------ */

// CostAlertInput is the POST/PUT body.
//
// The two threshold fields are explicit nulls rather than omissions: at least
// one must be non-null, and when both are set both must hold before the alert
// fires. Omitting one would be indistinguishable from clearing it.
type CostAlertInput struct {
	Name                 string       `json:"name"`
	Filters              []CostFilter `json:"filters"`
	GroupBy              *string      `json:"groupBy"`
	GroupByTagKey        *string      `json:"groupByTagKey,omitempty"`
	Cadence              string       `json:"cadence"`
	ThresholdPercent     *int64       `json:"thresholdPercent"`
	ThresholdAmountCents *int64       `json:"thresholdAmountCents"`
	Direction            string       `json:"direction"`
	Enabled              bool         `json:"enabled"`
}

// CostAlert is a stored change-based alert.
type CostAlert struct {
	ID                   string       `json:"id"`
	Name                 string       `json:"name"`
	Filters              []CostFilter `json:"filters"`
	GroupBy              *string      `json:"groupBy"`
	GroupByTagKey        *string      `json:"groupByTagKey"`
	Cadence              string       `json:"cadence"`
	ThresholdPercent     *int64       `json:"thresholdPercent"`
	ThresholdAmountCents *int64       `json:"thresholdAmountCents"`
	Direction            string       `json:"direction"`
	Enabled              bool         `json:"enabled"`
	LastEvaluatedAt      *string      `json:"lastEvaluatedAt"`
	LastFiredAt          *string      `json:"lastFiredAt"`
	CreatedAt            string       `json:"createdAt"`
	UpdatedAt            string       `json:"updatedAt"`
}

/* ----------------------------- scenario models ----------------------------- */

// CostScenarioAdjustment is one what-if line in a scenario model.
//
// ID is caller-assigned and must be stable across updates — the server does not
// mint it. The provider derives it from the adjustment's label so a practitioner
// never has to invent one, and reordering the list does not renumber anything.
//
// The kind-specific fields are all nullable rather than a discriminated union,
// so validity is cross-field: amount_cents for one_off and recurring, percent
// for rate_change, period for recurring only, end_date refused for one_off.
type CostScenarioAdjustment struct {
	ID          string       `json:"id"`
	Label       string       `json:"label"`
	Kind        string       `json:"kind"`
	StartDate   string       `json:"startDate"`
	EndDate     *string      `json:"endDate"`
	AmountCents *int64       `json:"amountCents"`
	Currency    *string      `json:"currency"`
	Period      *string      `json:"period"`
	Percent     *float64     `json:"percent"`
	Scope       []CostFilter `json:"scope"`
}

// CostScenarioModelInput is the POST/PUT body.
type CostScenarioModelInput struct {
	Name        string                   `json:"name"`
	Description *string                  `json:"description,omitempty"`
	Currency    string                   `json:"currency"`
	Adjustments []CostScenarioAdjustment `json:"adjustments"`
}

// CostScenarioModel is a stored what-if model.
type CostScenarioModel struct {
	ID              string                   `json:"id"`
	Name            string                   `json:"name"`
	Description     *string                  `json:"description"`
	Currency        string                   `json:"currency"`
	Adjustments     []CostScenarioAdjustment `json:"adjustments"`
	CreatedByUserID *string                  `json:"createdByUserId"`
	CreatedAt       string                   `json:"createdAt"`
	UpdatedAt       string                   `json:"updatedAt"`
}

/* ------------------------------- billing rules ----------------------------- */

// BillingRuleMatch is a superset of AllocationRuleMatch — it can also match on
// charge type.
type BillingRuleMatch struct {
	TagKey     *string `json:"tagKey,omitempty"`
	TagValue   *string `json:"tagValue,omitempty"`
	AccountID  *string `json:"accountId,omitempty"`
	PluginID   *string `json:"pluginId,omitempty"`
	Service    *string `json:"service,omitempty"`
	ChargeType *string `json:"chargeType,omitempty"`
}

// BillingRuleAdjustment restates matched spend at query time. Nothing is
// written back into stored cost rows, so removing a rule restores the raw
// numbers immediately.
type BillingRuleAdjustment struct {
	Kind       string   `json:"kind"`
	Percent    *float64 `json:"percent"`
	Amount     *float64 `json:"amount"`
	Currency   *string  `json:"currency"`
	Period     *string  `json:"period"`
	TargetKind *string  `json:"targetKind"`
	TargetID   *string  `json:"targetId"`
}

// BillingRuleInput is the POST/PUT body.
type BillingRuleInput struct {
	Name        string                `json:"name"`
	Description *string               `json:"description"`
	Enabled     bool                  `json:"enabled"`
	Priority    int64                 `json:"priority"`
	Match       BillingRuleMatch      `json:"match"`
	Adjustment  BillingRuleAdjustment `json:"adjustment"`
}

// BillingRule is a stored restatement rule.
type BillingRule struct {
	ID          string                `json:"id"`
	Name        string                `json:"name"`
	Description *string               `json:"description"`
	Enabled     bool                  `json:"enabled"`
	Priority    int64                 `json:"priority"`
	Match       BillingRuleMatch      `json:"match"`
	Adjustment  BillingRuleAdjustment `json:"adjustment"`
	CreatedAt   string                `json:"createdAt"`
	UpdatedAt   string                `json:"updatedAt"`
}

/* ------------------------------- cost exports ------------------------------ */

// CostExportDestination is a tagged union over the two delivery targets.
//
// The HTTP branch's URL is a write-only credential and lives on the input, not
// here; UrlHint is the server's redacted echo of it and is recomputed whenever
// a new URL is supplied, so a client cannot claim a destination it does not
// hold the URL for.
type CostExportDestination struct {
	Kind string `json:"kind"`

	// s3
	Bucket         *string `json:"bucket,omitempty"`
	Prefix         *string `json:"prefix,omitempty"`
	Region         *string `json:"region,omitempty"`
	Endpoint       *string `json:"endpoint,omitempty"`
	ForcePathStyle *bool   `json:"forcePathStyle,omitempty"`

	// http
	Method  *string `json:"method,omitempty"`
	URLHint *string `json:"urlHint,omitempty"`
}

// MarshalJSON emits only the keys belonging to the named branch, since the
// server's destination schema is a strict discriminated union.
func (d CostExportDestination) MarshalJSON() ([]byte, error) {
	switch d.Kind {
	case "s3":
		out := map[string]any{"kind": "s3"}
		if d.Bucket != nil {
			out["bucket"] = *d.Bucket
		}
		if d.Prefix != nil {
			out["prefix"] = *d.Prefix
		}
		if d.Region != nil {
			out["region"] = *d.Region
		}
		if d.Endpoint != nil {
			out["endpoint"] = *d.Endpoint
		}
		if d.ForcePathStyle != nil {
			out["forcePathStyle"] = *d.ForcePathStyle
		}
		return json.Marshal(out)
	case "http":
		out := map[string]any{"kind": "http"}
		if d.Method != nil {
			out["method"] = *d.Method
		}
		return json.Marshal(out)
	default:
		return nil, fmt.Errorf("unknown export destination kind %q (want \"s3\" or \"http\")", d.Kind)
	}
}

// CostExportQuery selects the rows an export emits.
type CostExportQuery struct {
	Version     int64        `json:"version"`
	Dimensions  []string     `json:"dimensions"`
	TagKeys     []string     `json:"tagKeys"`
	Filters     []CostFilter `json:"filters"`
	ChargeTypes []string     `json:"chargeTypes,omitempty"`
	CostBasis   *string      `json:"costBasis,omitempty"`
}

// CostExportInput is the POST/PUT body.
//
// AccessKeyID, SecretAccessKey and URL are write-only credentials. The server
// never returns them, and omitting one on PUT means "keep the stored value" —
// not "clear it". They are omitempty pointers so an unknown or unset credential
// leaves the stored one intact rather than blanking it.
type CostExportInput struct {
	Name            string                `json:"name"`
	Format          string                `json:"format"`
	Query           CostExportQuery       `json:"query"`
	Cadence         string                `json:"cadence"`
	Hour            int64                 `json:"hour"`
	Timezone        string                `json:"timezone"`
	RestatementDays int64                 `json:"restatementDays"`
	Enabled         bool                  `json:"enabled"`
	Destination     CostExportDestination `json:"destination"`

	AccessKeyID     *string `json:"accessKeyId,omitempty"`
	SecretAccessKey *string `json:"secretAccessKey,omitempty"`
	URL             *string `json:"url,omitempty"`
}

// CostExport is a stored export schedule. HasCredentials and CredentialHint are
// the only readable signal about the stored secret; the secret itself is never
// returned by any route, so the provider cannot detect drift on it.
type CostExport struct {
	ID              string                `json:"id"`
	Name            string                `json:"name"`
	Format          string                `json:"format"`
	Query           CostExportQuery       `json:"query"`
	Cadence         string                `json:"cadence"`
	Hour            int64                 `json:"hour"`
	Timezone        string                `json:"timezone"`
	RestatementDays int64                 `json:"restatementDays"`
	Enabled         bool                  `json:"enabled"`
	Destination     CostExportDestination `json:"destination"`
	HasCredentials  bool                  `json:"hasCredentials"`
	CredentialHint  *string               `json:"credentialHint"`
	LastRunAt       *string               `json:"lastRunAt"`
	LastStatus      string                `json:"lastStatus"`
	LastError       *string               `json:"lastError"`
	LastObjectCount *int64                `json:"lastObjectCount"`
	LastRowCount    *int64                `json:"lastRowCount"`
	NextRunAt       *string               `json:"nextRunAt"`
	CreatedByUserID *string               `json:"createdByUserId"`
	CreatedAt       string                `json:"createdAt"`
	UpdatedAt       string                `json:"updatedAt"`
}

/* --------------------------- read-only reference --------------------------- */

// Account is a connected cloud account. No credential material is returned by
// the listing route.
type Account struct {
	ID          string  `json:"id"`
	PluginID    string  `json:"pluginId"`
	DisplayName string  `json:"displayName"`
	BastionID   *string `json:"bastionId"`
	CreatedAt   string  `json:"createdAt"`
}

// PluginSummary describes an available provider plugin. The listing also
// carries the plugin's logo SVG and credential-field metadata, neither of which
// belongs in Terraform state — the data source drops them.
type PluginSummary struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}
