package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*realizedSavingsSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*realizedSavingsSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*realizedSavingsSettingsResource)(nil)
)

// NewRealizedSavingsSettingsResource constructs the
// infrawrench_realized_savings_settings resource.
func NewRealizedSavingsSettingsResource() resource.Resource {
	return &realizedSavingsSettingsResource{}
}

type realizedSavingsSettingsResource struct{ client *iw.Client }

type realizedSavingsSettingsResourceModel struct {
	ID                        types.String `tfsdk:"id"`
	HorizonMonths             types.Int64  `tfsdk:"horizon_months"`
	ShortfallThresholdPercent types.Int64  `tfsdk:"shortfall_threshold_percent"`
	BaselineWindowDays        types.Int64  `tfsdk:"baseline_window_days"`
}

// realizedSavingsDefaults are the server's documented defaults, restored on
// destroy.
var realizedSavingsDefaults = iw.RealizedSavingsSettings{
	HorizonMonths:             12,
	ShortfallThresholdPercent: 70,
	BaselineWindowDays:        14,
}

func (r *realizedSavingsSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_realized_savings_settings"
}

func (r *realizedSavingsSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Organization-wide tuning for how realized savings are measured. Realized savings " +
			"are what optimization actions (resizes, orphaned resource deletions, sleep schedules, " +
			"commitments and manually entered savings) actually saved, judged against the spend in the " +
			"days before each action rather than against the figure projected when it was taken.\n\n" +
			"An organization **singleton**: the row always exists, so `terraform destroy` restores the " +
			"shipped defaults rather than deleting anything. Reading needs the `costs:read` permission " +
			"and writing needs `costs:write`.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Realized savings measurement"),

			"horizon_months": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "How many months a one-off action, such as deleting an orphaned volume, " +
					"keeps accruing savings after it was taken, 1–36. Ships as 12. Past the horizon the " +
					"action stops adding to the running total.",
				Validators: []validatorInt64{between(1, 36)},
			},
			"shortfall_threshold_percent": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "The share of its projected savings rate, as a percent, below which an " +
					"action is flagged as falling short, 10–100. Ships as 70: an action projected to save " +
					"$100 a month that is measured saving less than $70 a month is flagged. Setting 100 " +
					"flags anything that misses its projection at all.",
				Validators: []validatorInt64{between(10, 100)},
			},
			"baseline_window_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "How many days of spend before an action are averaged into the baseline " +
					"it is measured against, 3–30. Ships as 14, two whole weekly cycles, so a weekday-shaped " +
					"workload is compared like with like. A shorter window follows recent change more " +
					"closely; a longer one is steadier against a single unusual day.",
				Validators: []validatorInt64{between(3, 30)},
			},
		},
	}
}

func (r *realizedSavingsSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *realizedSavingsSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan realizedSavingsSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *realizedSavingsSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state realizedSavingsSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetRealizedSavingsSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read realized savings settings", err.Error())
		return
	}

	refreshed := realizedSavingsSettingsStateFrom(r.client.OrgID(), remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *realizedSavingsSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan realizedSavingsSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *realizedSavingsSettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutRealizedSavingsSettings(ctx, realizedSavingsDefaults); err != nil {
		resp.Diagnostics.AddError("Unable to reset realized savings settings", err.Error())
	}
}

func (r *realizedSavingsSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *realizedSavingsSettingsResource) write(ctx context.Context, plan realizedSavingsSettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutRealizedSavingsSettings(ctx, iw.RealizedSavingsSettings{
		HorizonMonths:             plan.HorizonMonths.ValueInt64(),
		ShortfallThresholdPercent: plan.ShortfallThresholdPercent.ValueInt64(),
		BaselineWindowDays:        plan.BaselineWindowDays.ValueInt64(),
	})
	if err != nil {
		diags.AddError("Unable to write realized savings settings", err.Error())
		return
	}

	next := realizedSavingsSettingsStateFrom(r.client.OrgID(), saved)
	diags.Append(state.Set(ctx, &next)...)
}

func realizedSavingsSettingsStateFrom(orgID string, remote *iw.RealizedSavingsSettings) realizedSavingsSettingsResourceModel {
	return realizedSavingsSettingsResourceModel{
		ID:                        types.StringValue(orgID),
		HorizonMonths:             types.Int64Value(remote.HorizonMonths),
		ShortfallThresholdPercent: types.Int64Value(remote.ShortfallThresholdPercent),
		BaselineWindowDays:        types.Int64Value(remote.BaselineWindowDays),
	}
}
