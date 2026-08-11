package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*efficiencyAlertSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*efficiencyAlertSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*efficiencyAlertSettingsResource)(nil)
)

// NewEfficiencyAlertSettingsResource constructs the
// infrawrench_efficiency_alert_settings resource.
func NewEfficiencyAlertSettingsResource() resource.Resource {
	return &efficiencyAlertSettingsResource{}
}

type efficiencyAlertSettingsResource struct{ client *iw.Client }

type efficiencyAlertSettingsResourceModel struct {
	ID types.String `tfsdk:"id"`

	CommitmentExpiryEnabled        types.Bool `tfsdk:"commitment_expiry_enabled"`
	CommitmentExpiryHorizonDays    types.List `tfsdk:"commitment_expiry_horizon_days"`
	CommitmentExpiryAlertOnExpired types.Bool `tfsdk:"commitment_expiry_alert_on_expired"`

	CommitmentIdleEnabled          types.Bool  `tfsdk:"commitment_idle_enabled"`
	CommitmentIdleThresholdPercent types.Int64 `tfsdk:"commitment_idle_threshold_percent"`
	CommitmentIdleWindowDays       types.Int64 `tfsdk:"commitment_idle_window_days"`
	CommitmentIdleMinMeasuredDays  types.Int64 `tfsdk:"commitment_idle_min_measured_days"`
	CommitmentIdleMinWasteCents    types.Int64 `tfsdk:"commitment_idle_min_waste_cents"`

	UnitCostRegressionEnabled types.Bool  `tfsdk:"unit_cost_regression_enabled"`
	UnitCostThresholdPercent  types.Int64 `tfsdk:"unit_cost_threshold_percent"`
	UnitCostWindowDays        types.Int64 `tfsdk:"unit_cost_window_days"`
	UnitCostMinReportedDays   types.Int64 `tfsdk:"unit_cost_min_reported_days"`
	UnitCostMinSpendCents     types.Int64 `tfsdk:"unit_cost_min_spend_cents"`
}

// efficiencyDefaults are the server's documented defaults, restored on destroy.
var efficiencyDefaults = iw.CostEfficiencySettings{
	CommitmentExpiryEnabled:        true,
	CommitmentExpiryHorizonDays:    []int64{60, 30, 7},
	CommitmentExpiryAlertOnExpired: true,
	CommitmentIdleEnabled:          true,
	CommitmentIdleThresholdPercent: 70,
	CommitmentIdleWindowDays:       30,
	CommitmentIdleMinMeasuredDays:  14,
	CommitmentIdleMinWasteCents:    5000,
	UnitCostRegressionEnabled:      true,
	UnitCostThresholdPercent:       20,
	UnitCostWindowDays:             14,
	UnitCostMinReportedDays:        10,
	UnitCostMinSpendCents:          10000,
}

func (r *efficiencyAlertSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_efficiency_alert_settings"
}

func (r *efficiencyAlertSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Organization-wide tuning for the three efficiency alerts: a commitment approaching " +
			"its term end, a commitment sitting idle, and cost per business-metric unit regressing.\n\n" +
			"An organization **singleton**: the row always exists, so `terraform destroy` restores the " +
			"shipped defaults rather than deleting anything.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Efficiency alerting"),

			"commitment_expiry_enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether commitments approaching their term end raise alerts. Ships as `true`.",
			},
			"commitment_expiry_horizon_days": schema.ListAttribute{
				Required:    true,
				ElementType: types.Int64Type,
				MarkdownDescription: "Days of notice, 1–6 entries each 1–730, each firing at most once per " +
					"commitment per term end. Ships as `[60, 30, 7]`. A commitment fires at the *smallest* " +
					"horizon it has reached, so an account connected 30 days before a term ends gets one " +
					"alert, not two.",
				Validators: []validatorList{elementsBetween(1, 730), sizeBetween(1, 6)},
			},
			"commitment_expiry_alert_on_expired": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Whether a commitment that lapsed without any horizon warning having fired " +
					"raises one alert anyway. Ships as `true`, bounded to terms that ended within the last 90 " +
					"days — connecting an account with years of dead reservations produces one pass of recent " +
					"news, not an archive.",
			},

			"commitment_idle_enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether under-used commitments raise alerts. Ships as `true`.",
			},
			"commitment_idle_threshold_percent": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Utilization percent the whole window must stay under, 1–99. Ships as 70 — " +
					"roughly where a 1-year no-upfront commitment stops beating on-demand for the usage it covers.",
				Validators: []validatorInt64{between(1, 99)},
			},
			"commitment_idle_window_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Trailing days utilization is aggregated over, 7–90. Ships as 30. Aggregated, " +
					"never sampled per day: a weekday-only workload reads about 71% over a month and does not " +
					"fire, which is the point.",
				Validators: []validatorInt64{between(7, 90)},
			},
			"commitment_idle_min_measured_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Window days that must carry cost data before anything is judged, 3–90. Ships " +
					"as 14. A commitment whose utilization cannot be measured at all — a unit-denominated GCP " +
					"CUD, or an account whose plugin reports no commitment attribution — never alerts, whatever " +
					"this is set to.",
				Validators: []validatorInt64{between(3, 90)},
			},
			"commitment_idle_min_waste_cents": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Least wasted money (obligation − delivered) before alerting, in USD cents, " +
					"restated per currency. 100–100000000; ships as 5000 ($50).",
				Validators: []validatorInt64{between(100, 100000000)},
			},

			"unit_cost_regression_enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether rising cost per business-metric unit raises alerts. Ships as `true`.",
			},
			"unit_cost_threshold_percent": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "Percent the unit cost must rise versus the prior window, 1–1000. Ships as 20.",
				Validators:          []validatorInt64{between(1, 1000)},
			},
			"unit_cost_window_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Length of each of the two compared windows, 7–90. Ships as 14 — two whole " +
					"weekly cycles a side, so a weekday-shaped unit cost compares like with like.",
				Validators: []validatorInt64{between(7, 90)},
			},
			"unit_cost_min_reported_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Days inside **each** window that must carry a reported, positive metric " +
					"value, 5–90. Ships as 10. A day with no reported value is a gap and contributes to neither " +
					"the numerator nor the denominator; a window that fails this bar produces no comparison at " +
					"all rather than a comparison against a gap.",
				Validators: []validatorInt64{between(5, 90)},
			},
			"unit_cost_min_spend_cents": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Least spend in the current window before alerting, in USD cents, restated " +
					"per currency. 100–100000000; ships as 10000 ($100).",
				Validators: []validatorInt64{between(100, 100000000)},
			},
		},
	}
}

func (r *efficiencyAlertSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *efficiencyAlertSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan efficiencyAlertSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *efficiencyAlertSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state efficiencyAlertSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetEfficiencySettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read efficiency alert settings", err.Error())
		return
	}

	refreshed, diags := efficiencySettingsStateFrom(ctx, r.client.OrgID(), remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *efficiencyAlertSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan efficiencyAlertSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *efficiencyAlertSettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutEfficiencySettings(ctx, efficiencyDefaults); err != nil {
		resp.Diagnostics.AddError("Unable to reset efficiency alert settings", err.Error())
	}
}

func (r *efficiencyAlertSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *efficiencyAlertSettingsResource) write(ctx context.Context, plan efficiencyAlertSettingsResourceModel, diags *diagnostics, state *tfState) {
	horizons, d := int64Slice(ctx, plan.CommitmentExpiryHorizonDays)
	diags.Append(d...)
	if diags.HasError() {
		return
	}

	saved, err := r.client.PutEfficiencySettings(ctx, iw.CostEfficiencySettings{
		CommitmentExpiryEnabled:        plan.CommitmentExpiryEnabled.ValueBool(),
		CommitmentExpiryHorizonDays:    horizons,
		CommitmentExpiryAlertOnExpired: plan.CommitmentExpiryAlertOnExpired.ValueBool(),
		CommitmentIdleEnabled:          plan.CommitmentIdleEnabled.ValueBool(),
		CommitmentIdleThresholdPercent: plan.CommitmentIdleThresholdPercent.ValueInt64(),
		CommitmentIdleWindowDays:       plan.CommitmentIdleWindowDays.ValueInt64(),
		CommitmentIdleMinMeasuredDays:  plan.CommitmentIdleMinMeasuredDays.ValueInt64(),
		CommitmentIdleMinWasteCents:    plan.CommitmentIdleMinWasteCents.ValueInt64(),
		UnitCostRegressionEnabled:      plan.UnitCostRegressionEnabled.ValueBool(),
		UnitCostThresholdPercent:       plan.UnitCostThresholdPercent.ValueInt64(),
		UnitCostWindowDays:             plan.UnitCostWindowDays.ValueInt64(),
		UnitCostMinReportedDays:        plan.UnitCostMinReportedDays.ValueInt64(),
		UnitCostMinSpendCents:          plan.UnitCostMinSpendCents.ValueInt64(),
	})
	if err != nil {
		diags.AddError("Unable to write efficiency alert settings", err.Error())
		return
	}

	next, d := efficiencySettingsStateFrom(ctx, r.client.OrgID(), saved)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

func efficiencySettingsStateFrom(ctx context.Context, orgID string, remote *iw.CostEfficiencySettings) (efficiencyAlertSettingsResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	horizons, d := int64List(ctx, remote.CommitmentExpiryHorizonDays)
	diags.Append(d...)

	return efficiencyAlertSettingsResourceModel{
		ID:                             types.StringValue(orgID),
		CommitmentExpiryEnabled:        types.BoolValue(remote.CommitmentExpiryEnabled),
		CommitmentExpiryHorizonDays:    horizons,
		CommitmentExpiryAlertOnExpired: types.BoolValue(remote.CommitmentExpiryAlertOnExpired),
		CommitmentIdleEnabled:          types.BoolValue(remote.CommitmentIdleEnabled),
		CommitmentIdleThresholdPercent: types.Int64Value(remote.CommitmentIdleThresholdPercent),
		CommitmentIdleWindowDays:       types.Int64Value(remote.CommitmentIdleWindowDays),
		CommitmentIdleMinMeasuredDays:  types.Int64Value(remote.CommitmentIdleMinMeasuredDays),
		CommitmentIdleMinWasteCents:    types.Int64Value(remote.CommitmentIdleMinWasteCents),
		UnitCostRegressionEnabled:      types.BoolValue(remote.UnitCostRegressionEnabled),
		UnitCostThresholdPercent:       types.Int64Value(remote.UnitCostThresholdPercent),
		UnitCostWindowDays:             types.Int64Value(remote.UnitCostWindowDays),
		UnitCostMinReportedDays:        types.Int64Value(remote.UnitCostMinReportedDays),
		UnitCostMinSpendCents:          types.Int64Value(remote.UnitCostMinSpendCents),
	}, diags
}
