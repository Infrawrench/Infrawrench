package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*expiryAlertSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*expiryAlertSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*expiryAlertSettingsResource)(nil)
)

// NewExpiryAlertSettingsResource constructs the
// infrawrench_expiry_alert_settings resource.
func NewExpiryAlertSettingsResource() resource.Resource { return &expiryAlertSettingsResource{} }

type expiryAlertSettingsResource struct{ client *iw.Client }

type expiryAlertSettingsResourceModel struct {
	ID       types.String `tfsdk:"id"`
	Enabled  types.Bool   `tfsdk:"enabled"`
	LeadDays types.Int64  `tfsdk:"lead_days"`
}

func (r *expiryAlertSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_expiry_alert_settings"
}

func (r *expiryAlertSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "How much notice the expiry radar gives before a certificate, domain or commitment " +
			"deadline arrives.\n\n" +
			"An organization **singleton**, with no DELETE on the route: `terraform destroy` leaves the " +
			"stored settings alone.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Expiry alerting"),
			"enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether the poller sends expiry alerts for this organization at all.",
			},
			"lead_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Days of lead time before a deadline counts as upcoming and alertable, " +
					"1–365. Ships as 60.",
				Validators: []validatorInt64{between(1, 365)},
			},
		},
	}
}

func (r *expiryAlertSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *expiryAlertSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan expiryAlertSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *expiryAlertSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state expiryAlertSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetExpiryAlertSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read expiry alert settings", err.Error())
		return
	}

	refreshed := expiryAlertSettingsResourceModel{
		ID:       types.StringValue(r.client.OrgID()),
		Enabled:  types.BoolValue(remote.Enabled),
		LeadDays: types.Int64Value(remote.LeadDays),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *expiryAlertSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan expiryAlertSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op — the settings row has no DELETE and no documented reset.
func (r *expiryAlertSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *expiryAlertSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *expiryAlertSettingsResource) write(ctx context.Context, plan expiryAlertSettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutExpiryAlertSettings(ctx, iw.ExpiryAlertSettingsUpdate{
		Enabled:  boolPtr(plan.Enabled),
		LeadDays: int64Ptr(plan.LeadDays),
	})
	if err != nil {
		diags.AddError("Unable to write expiry alert settings", err.Error())
		return
	}
	next := expiryAlertSettingsResourceModel{
		ID:       types.StringValue(r.client.OrgID()),
		Enabled:  types.BoolValue(saved.Enabled),
		LeadDays: types.Int64Value(saved.LeadDays),
	}
	diags.Append(state.Set(ctx, &next)...)
}
