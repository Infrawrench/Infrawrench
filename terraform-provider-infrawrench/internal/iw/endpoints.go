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

/* ----------------------------- business metrics ---------------------------- */

// ListBusinessMetrics unwraps the {"metrics": […]} envelope.
func (c *Client) ListBusinessMetrics(ctx context.Context) ([]BusinessMetric, error) {
	var envelope struct {
		Metrics []BusinessMetric `json:"metrics"`
	}
	if err := c.Get(ctx, "/business-metrics", &envelope); err != nil {
		return nil, err
	}
	return envelope.Metrics, nil
}

func (c *Client) GetBusinessMetric(ctx context.Context, id string) (*BusinessMetric, error) {
	var out BusinessMetric
	if err := c.Get(ctx, "/business-metrics/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateBusinessMetric(ctx context.Context, in BusinessMetricInput) (*BusinessMetric, error) {
	var out BusinessMetric
	if err := c.Post(ctx, "/business-metrics", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateBusinessMetric(ctx context.Context, id string, in BusinessMetricInput) (*BusinessMetric, error) {
	var out BusinessMetric
	if err := c.Put(ctx, "/business-metrics/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteBusinessMetric(ctx context.Context, id string) error {
	return c.Delete(ctx, "/business-metrics/"+seg(id))
}

/* ----------------------------- cost annotations ---------------------------- */

// ListCostAnnotations unwraps the {"annotations": […]} envelope.
func (c *Client) ListCostAnnotations(ctx context.Context) ([]CostAnnotation, error) {
	var envelope struct {
		Annotations []CostAnnotation `json:"annotations"`
	}
	if err := c.Get(ctx, "/cost-annotations", &envelope); err != nil {
		return nil, err
	}
	return envelope.Annotations, nil
}

// GetCostAnnotation lists and filters — there is no single-GET route.
func (c *Client) GetCostAnnotation(ctx context.Context, id string) (*CostAnnotation, error) {
	all, err := c.ListCostAnnotations(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/cost-annotations", id)
}

func (c *Client) CreateCostAnnotation(ctx context.Context, in CostAnnotationInput) (*CostAnnotation, error) {
	var out CostAnnotation
	if err := c.Post(ctx, "/cost-annotations", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateCostAnnotation(ctx context.Context, id string, in CostAnnotationInput) (*CostAnnotation, error) {
	var out CostAnnotation
	if err := c.Put(ctx, "/cost-annotations/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteCostAnnotation(ctx context.Context, id string) error {
	return c.Delete(ctx, "/cost-annotations/"+seg(id))
}

/* -------------------------- report notifications --------------------------- */
//
// These hang off a report rather than off the org, so every wrapper takes the
// report id as well. That is also why the Terraform resource imports under a
// composite "reportId/notificationId" address: the notification id alone cannot
// be turned back into a URL.

func (c *Client) ListReportNotifications(ctx context.Context, reportID string) ([]ReportNotification, error) {
	var out []ReportNotification
	err := c.Get(ctx, "/cost-reports/"+seg(reportID)+"/notifications", &out)
	return out, err
}

// GetReportNotification lists a report's schedules and filters — there is no
// single-GET route for one schedule.
func (c *Client) GetReportNotification(ctx context.Context, reportID, id string) (*ReportNotification, error) {
	all, err := c.ListReportNotifications(ctx, reportID)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/cost-reports/"+seg(reportID)+"/notifications", id)
}

func (c *Client) CreateReportNotification(ctx context.Context, reportID string, in ReportNotificationInput) (*ReportNotification, error) {
	var out ReportNotification
	if err := c.Post(ctx, "/cost-reports/"+seg(reportID)+"/notifications", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateReportNotification(ctx context.Context, reportID, id string, in ReportNotificationInput) (*ReportNotification, error) {
	var out ReportNotification
	if err := c.Put(ctx, "/cost-reports/"+seg(reportID)+"/notifications/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteReportNotification(ctx context.Context, reportID, id string) error {
	return c.Delete(ctx, "/cost-reports/"+seg(reportID)+"/notifications/"+seg(id))
}

/* ------------------------------ cost settings ------------------------------ */

func (c *Client) GetAnomalySettings(ctx context.Context) (*CostAnomalySettings, error) {
	var out CostAnomalySettings
	if err := c.Get(ctx, "/costs/anomaly-settings", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutAnomalySettings(ctx context.Context, in CostAnomalySettings) (*CostAnomalySettings, error) {
	var out CostAnomalySettings
	// SMSConfigured is derived and rejected by the strict PUT schema, so it is
	// cleared here rather than trusted to every caller.
	in.SMSConfigured = nil
	if err := c.Put(ctx, "/costs/anomaly-settings", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetEfficiencySettings(ctx context.Context) (*CostEfficiencySettings, error) {
	var out CostEfficiencySettings
	if err := c.Get(ctx, "/costs/efficiency-alert-settings", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutEfficiencySettings(ctx context.Context, in CostEfficiencySettings) (*CostEfficiencySettings, error) {
	var out CostEfficiencySettings
	if err := c.Put(ctx, "/costs/efficiency-alert-settings", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

/* --------------------------------- currency -------------------------------- */

func (c *Client) GetCurrencyConfig(ctx context.Context) (*CurrencyConfig, error) {
	var out CurrencyConfig
	if err := c.Get(ctx, "/currency", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutCurrencySettings(ctx context.Context, in CurrencySettings) (*CurrencySettings, error) {
	var out CurrencySettings
	if err := c.Put(ctx, "/currency", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpsertExchangeRate creates or replaces one rate. The route is keyed on
// (from, to, effectiveFrom), so restating a rate for a day it already covers
// replaces it rather than adding a second one the reader has to choose between.
func (c *Client) UpsertExchangeRate(ctx context.Context, in ExchangeRateInput) (*ExchangeRate, error) {
	var out ExchangeRate
	if err := c.Put(ctx, "/currency/rates", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetExchangeRate reads the whole rate table and filters — rates are only ever
// returned as part of the currency config.
func (c *Client) GetExchangeRate(ctx context.Context, id string) (*ExchangeRate, error) {
	config, err := c.GetCurrencyConfig(ctx)
	if err != nil {
		return nil, err
	}
	for i := range config.Rates {
		if config.Rates[i].ID == id {
			return &config.Rates[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/currency", id)
}

func (c *Client) DeleteExchangeRate(ctx context.Context, id string) error {
	return c.Delete(ctx, "/currency/rates/"+seg(id))
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
