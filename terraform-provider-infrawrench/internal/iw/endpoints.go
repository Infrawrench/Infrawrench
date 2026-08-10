package iw

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// Typed endpoint wrappers. Resources call these and never assemble a path.
//
// Two shapes of read exist behind this interface, and the difference is not
// cosmetic:
//
//   - Objects with a single-GET route (budgets, saved filters, reports, alerts,
//     scenario models, billing rules, exports) read directly and get a real 404
//     when they are gone.
//
//   - Objects without one (cost centres, allocation rules, report folders) are
//     read by listing and filtering client-side. Those wrappers synthesise the
//     404 themselves — notFound below — so that a deletion outside Terraform
//     still reaches the caller as IsNotFound and lands as "needs recreating"
//     rather than as an opaque error or, worse, silent success.
func notFound(method, path, id string) error {
	return &APIError{
		Method:     method,
		Path:       path,
		StatusCode: http.StatusNotFound,
		Message:    fmt.Sprintf("no object with id %q in the listing for this organization", id),
	}
}

func seg(id string) string { return url.PathEscape(id) }

/* --------------------------------- budgets -------------------------------- */

func (c *Client) ListBudgets(ctx context.Context) ([]Budget, error) {
	var out []Budget
	err := c.Get(ctx, "/budgets", &out)
	return out, err
}

func (c *Client) GetBudget(ctx context.Context, id string) (*Budget, error) {
	var out Budget
	if err := c.Get(ctx, "/budgets/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateBudget(ctx context.Context, in BudgetInput) (*Budget, error) {
	var out Budget
	if err := c.Post(ctx, "/budgets", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateBudget(ctx context.Context, id string, in BudgetInput) (*Budget, error) {
	var out Budget
	if err := c.Put(ctx, "/budgets/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteBudget(ctx context.Context, id string) error {
	return c.Delete(ctx, "/budgets/"+seg(id))
}

/* ------------------------------ cost centres ------------------------------ */

func (c *Client) ListCostCentres(ctx context.Context) ([]CostCentre, error) {
	var out []CostCentre
	err := c.Get(ctx, "/cost-centres", &out)
	return out, err
}

// GetCostCentre lists and filters — there is no GET /cost-centres/{id}.
func (c *Client) GetCostCentre(ctx context.Context, id string) (*CostCentre, error) {
	all, err := c.ListCostCentres(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/cost-centres", id)
}

func (c *Client) CreateCostCentre(ctx context.Context, in CostCentreInput) (*CostCentre, error) {
	var out CostCentre
	if err := c.Post(ctx, "/cost-centres", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateCostCentre(ctx context.Context, id string, in CostCentreInput) (*CostCentre, error) {
	var out CostCentre
	if err := c.Put(ctx, "/cost-centres/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteCostCentre(ctx context.Context, id string) error {
	return c.Delete(ctx, "/cost-centres/"+seg(id))
}

/* ---------------------------- allocation rules ---------------------------- */

func (c *Client) ListAllocationRules(ctx context.Context) ([]AllocationRule, error) {
	var out []AllocationRule
	err := c.Get(ctx, "/cost-centres/rules", &out)
	return out, err
}

// GetAllocationRule lists and filters — there is no GET for a single rule.
func (c *Client) GetAllocationRule(ctx context.Context, id string) (*AllocationRule, error) {
	all, err := c.ListAllocationRules(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/cost-centres/rules", id)
}

func (c *Client) CreateAllocationRule(ctx context.Context, in AllocationRuleInput) (*AllocationRule, error) {
	var out AllocationRule
	if err := c.Post(ctx, "/cost-centres/rules", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateAllocationRule(ctx context.Context, id string, in AllocationRuleInput) (*AllocationRule, error) {
	var out AllocationRule
	if err := c.Put(ctx, "/cost-centres/rules/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteAllocationRule(ctx context.Context, id string) error {
	return c.Delete(ctx, "/cost-centres/rules/"+seg(id))
}

/* -------------------------------- tag policy ------------------------------- */

func (c *Client) GetTagPolicy(ctx context.Context) (*TagPolicy, error) {
	var out TagPolicy
	if err := c.Get(ctx, "/tag-policy", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutTagPolicy(ctx context.Context, in TagPolicy) (*TagPolicy, error) {
	var out TagPolicy
	if err := c.Put(ctx, "/tag-policy", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

/* ------------------------------ saved filters ------------------------------ */

func (c *Client) ListSavedFilters(ctx context.Context) ([]SavedCostFilter, error) {
	var out []SavedCostFilter
	err := c.Get(ctx, "/saved-cost-filters", &out)
	return out, err
}

func (c *Client) GetSavedFilter(ctx context.Context, id string) (*SavedCostFilter, error) {
	var out SavedCostFilter
	if err := c.Get(ctx, "/saved-cost-filters/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateSavedFilter(ctx context.Context, in SavedCostFilterInput) (*SavedCostFilter, error) {
	var out SavedCostFilter
	if err := c.Post(ctx, "/saved-cost-filters", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateSavedFilter(ctx context.Context, id string, in SavedCostFilterInput) (*SavedCostFilter, error) {
	var out SavedCostFilter
	if err := c.Put(ctx, "/saved-cost-filters/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteSavedFilter(ctx context.Context, id string) error {
	return c.Delete(ctx, "/saved-cost-filters/"+seg(id))
}

/* ------------------------------- cost reports ------------------------------ */

func (c *Client) ListCostReports(ctx context.Context) ([]CostReport, error) {
	var out []CostReport
	err := c.Get(ctx, "/cost-reports", &out)
	return out, err
}

func (c *Client) GetCostReport(ctx context.Context, id string) (*CostReport, error) {
	var out CostReport
	if err := c.Get(ctx, "/cost-reports/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateCostReport(ctx context.Context, in CostReportInput) (*CostReport, error) {
	var out CostReport
	if err := c.Post(ctx, "/cost-reports", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateCostReport(ctx context.Context, id string, in CostReportInput) (*CostReport, error) {
	var out CostReport
	if err := c.Put(ctx, "/cost-reports/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteCostReport(ctx context.Context, id string) error {
	return c.Delete(ctx, "/cost-reports/"+seg(id))
}

/* --------------------------- cost report folders --------------------------- */

func (c *Client) ListCostReportFolders(ctx context.Context) ([]CostReportFolder, error) {
	var out []CostReportFolder
	err := c.Get(ctx, "/cost-report-folders", &out)
	return out, err
}

// GetCostReportFolder lists and filters — there is no single-GET route.
func (c *Client) GetCostReportFolder(ctx context.Context, id string) (*CostReportFolder, error) {
	all, err := c.ListCostReportFolders(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/cost-report-folders", id)
}

func (c *Client) CreateCostReportFolder(ctx context.Context, in CostReportFolderInput) (*CostReportFolder, error) {
	var out CostReportFolder
	if err := c.Post(ctx, "/cost-report-folders", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateCostReportFolder(ctx context.Context, id string, in CostReportFolderInput) (*CostReportFolder, error) {
	var out CostReportFolder
	if err := c.Put(ctx, "/cost-report-folders/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteCostReportFolder(ctx context.Context, id string) error {
	return c.Delete(ctx, "/cost-report-folders/"+seg(id))
}

/* -------------------------------- cost alerts ------------------------------ */

// ListCostAlerts unwraps the {"alerts": […]} envelope this route uses. Several
// of its neighbours return a bare array; the inconsistency is absorbed here so
// no resource has to know about it.
func (c *Client) ListCostAlerts(ctx context.Context) ([]CostAlert, error) {
	var envelope struct {
		Alerts []CostAlert `json:"alerts"`
	}
	if err := c.Get(ctx, "/cost-alerts", &envelope); err != nil {
		return nil, err
	}
	return envelope.Alerts, nil
}

func (c *Client) GetCostAlert(ctx context.Context, id string) (*CostAlert, error) {
	var out CostAlert
	if err := c.Get(ctx, "/cost-alerts/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateCostAlert(ctx context.Context, in CostAlertInput) (*CostAlert, error) {
	var out CostAlert
	if err := c.Post(ctx, "/cost-alerts", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateCostAlert(ctx context.Context, id string, in CostAlertInput) (*CostAlert, error) {
	var out CostAlert
	if err := c.Put(ctx, "/cost-alerts/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteCostAlert(ctx context.Context, id string) error {
	return c.Delete(ctx, "/cost-alerts/"+seg(id))
}

/* ----------------------------- scenario models ----------------------------- */

// ListScenarioModels unwraps the {"models": […]} envelope.
func (c *Client) ListScenarioModels(ctx context.Context) ([]CostScenarioModel, error) {
	var envelope struct {
		Models []CostScenarioModel `json:"models"`
	}
	if err := c.Get(ctx, "/cost-scenarios", &envelope); err != nil {
		return nil, err
	}
	return envelope.Models, nil
}

func (c *Client) GetScenarioModel(ctx context.Context, id string) (*CostScenarioModel, error) {
	var out CostScenarioModel
	if err := c.Get(ctx, "/cost-scenarios/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateScenarioModel(ctx context.Context, in CostScenarioModelInput) (*CostScenarioModel, error) {
	var out CostScenarioModel
	if err := c.Post(ctx, "/cost-scenarios", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateScenarioModel(ctx context.Context, id string, in CostScenarioModelInput) (*CostScenarioModel, error) {
	var out CostScenarioModel
	if err := c.Put(ctx, "/cost-scenarios/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteScenarioModel(ctx context.Context, id string) error {
	return c.Delete(ctx, "/cost-scenarios/"+seg(id))
}

/* ------------------------------- billing rules ----------------------------- */

func (c *Client) ListBillingRules(ctx context.Context) ([]BillingRule, error) {
	var out []BillingRule
	err := c.Get(ctx, "/billing-rules", &out)
	return out, err
}

func (c *Client) GetBillingRule(ctx context.Context, id string) (*BillingRule, error) {
	var out BillingRule
	if err := c.Get(ctx, "/billing-rules/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateBillingRule(ctx context.Context, in BillingRuleInput) (*BillingRule, error) {
	var out BillingRule
	if err := c.Post(ctx, "/billing-rules", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateBillingRule(ctx context.Context, id string, in BillingRuleInput) (*BillingRule, error) {
	var out BillingRule
	if err := c.Put(ctx, "/billing-rules/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteBillingRule(ctx context.Context, id string) error {
	return c.Delete(ctx, "/billing-rules/"+seg(id))
}

/* ------------------------------- cost exports ------------------------------ */

func (c *Client) ListCostExports(ctx context.Context) ([]CostExport, error) {
	var out []CostExport
	err := c.Get(ctx, "/cost-exports", &out)
	return out, err
}

func (c *Client) GetCostExport(ctx context.Context, id string) (*CostExport, error) {
	var out CostExport
	if err := c.Get(ctx, "/cost-exports/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateCostExport(ctx context.Context, in CostExportInput) (*CostExport, error) {
	var out CostExport
	if err := c.Post(ctx, "/cost-exports", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateCostExport(ctx context.Context, id string, in CostExportInput) (*CostExport, error) {
	var out CostExport
	if err := c.Put(ctx, "/cost-exports/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteCostExport(ctx context.Context, id string) error {
	return c.Delete(ctx, "/cost-exports/"+seg(id))
}

/* --------------------------- read-only reference --------------------------- */

func (c *Client) ListAccounts(ctx context.Context) ([]Account, error) {
	var out []Account
	err := c.Get(ctx, "/accounts", &out)
	return out, err
}

func (c *Client) ListPlugins(ctx context.Context) ([]PluginSummary, error) {
	var out []PluginSummary
	err := c.Get(ctx, "/accounts/plugins", &out)
	return out, err
}
