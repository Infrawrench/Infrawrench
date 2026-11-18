package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*priceChangeSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*priceChangeSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*priceChangeSettingsResource)(nil)
)

// NewPriceChangeSettingsResource constructs the
// infrawrench_price_change_settings resource.
func NewPriceChangeSettingsResource() resource.Resource {
	return &priceChangeSettingsResource{}
}

type priceChangeSettingsResource struct{ client *iw.Client }

type priceChangeSettingsResourceModel struct {
	ID                    types.String  `tfsdk:"id"`
	Enabled               types.Bool    `tfsdk:"enabled"`
	MinMonthlyImpactCents types.Int64   `tfsdk:"min_monthly_impact_cents"`
	MinPercent            types.Float64 `tfsdk:"min_percent"`
	RegisterExpected      types.Bool    `tfsdk:"register_expected"`
}

func (r *priceChangeSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_price_change_settings"
}

func (r *priceChangeSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The provider price-change watch: a daily scan that finds list-price changes on " +
			"instance types the organization runs, alerts once per change, and can register an increase as " +
			"expected so cost anomaly detection does not fire on the step.\n\n" +
			"A change is alerted only when it clears **both** thresholds; smaller ones are still listed in " +
			"the Price catalog's Changes view.\n\n" +
			"An organization **singleton**, with no DELETE on the route: `terraform destroy` leaves the " +
			"stored settings alone.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Price change watch"),
			"enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether the daily scan (and so its alerts) runs for this organization.",
			},
			"min_monthly_impact_cents": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Changes moving the organization's monthly cost by less than this, in cents " +
					"of USD, are not alerted, 0–100000000. Ships as 1000 ($10).",
				Validators: []validatorInt64{between(0, 100000000)},
			},
			"min_percent": schema.Float64Attribute{
				Required: true,
				MarkdownDescription: "Changes under this percentage of the old list price are not alerted, " +
					"0–100. Ships as 1.",
				Validators: []validatorFloat64{betweenFloat(0, 100)},
			},
			"register_expected": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Register an alerted increase as expected: a one-off anomaly suppression " +
					"per affected account from the day the new price takes effect. Ships as true.",
			},
		},
	}
}

func (r *priceChangeSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *priceChangeSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan priceChangeSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *priceChangeSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state priceChangeSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetPriceChangeSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read price change settings", err.Error())
		return
	}
	refreshed := r.model(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *priceChangeSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan priceChangeSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op: the settings row has no DELETE and no documented reset.
func (r *priceChangeSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *priceChangeSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *priceChangeSettingsResource) model(remote *iw.PriceChangeSettings) priceChangeSettingsResourceModel {
	return priceChangeSettingsResourceModel{
		ID:                    types.StringValue(r.client.OrgID()),
		Enabled:               types.BoolValue(remote.Enabled),
		MinMonthlyImpactCents: types.Int64Value(remote.MinMonthlyImpactCents),
		MinPercent:            types.Float64Value(remote.MinPercent),
		RegisterExpected:      types.BoolValue(remote.RegisterExpected),
	}
}

func (r *priceChangeSettingsResource) write(ctx context.Context, plan priceChangeSettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutPriceChangeSettings(ctx, iw.PriceChangeSettingsUpdate{
		Enabled:               boolPtr(plan.Enabled),
		MinMonthlyImpactCents: int64Ptr(plan.MinMonthlyImpactCents),
		MinPercent:            float64Ptr(plan.MinPercent),
		RegisterExpected:      boolPtr(plan.RegisterExpected),
	})
	if err != nil {
		diags.AddError("Unable to write price change settings", err.Error())
		return
	}
	next := r.model(saved)
	diags.Append(state.Set(ctx, &next)...)
}
