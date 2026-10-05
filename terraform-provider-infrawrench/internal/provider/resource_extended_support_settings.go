package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*extendedSupportSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*extendedSupportSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*extendedSupportSettingsResource)(nil)
)

// NewExtendedSupportSettingsResource constructs the
// infrawrench_extended_support_settings resource.
func NewExtendedSupportSettingsResource() resource.Resource {
	return &extendedSupportSettingsResource{}
}

type extendedSupportSettingsResource struct{ client *iw.Client }

type extendedSupportSettingsResourceModel struct {
	ID       types.String `tfsdk:"id"`
	Enabled  types.Bool   `tfsdk:"enabled"`
	LeadDays types.Int64  `tfsdk:"lead_days"`
}

func (r *extendedSupportSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_extended_support_settings"
}

func (r *extendedSupportSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Extended-support findings: the weekly alert naming every resource that is paying an " +
			"extended-support surcharge (or is past the end of support), and how far ahead a surcharge that has " +
			"not started yet is listed in Costs.\n\n" +
			"An organization **singleton**, with no DELETE on the route: `terraform destroy` leaves the " +
			"stored settings alone.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Extended support"),
			"enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether the poller sends the weekly extended-support alert for this organization.",
			},
			"lead_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Days ahead a surcharge that has not started yet is listed, 1–365. " +
					"Ships as 90.",
				Validators: []validatorInt64{between(1, 365)},
			},
		},
	}
}

func (r *extendedSupportSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *extendedSupportSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan extendedSupportSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *extendedSupportSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state extendedSupportSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetExtendedSupportSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read extended support settings", err.Error())
		return
	}

	refreshed := extendedSupportSettingsResourceModel{
		ID:       types.StringValue(r.client.OrgID()),
		Enabled:  types.BoolValue(remote.Enabled),
		LeadDays: types.Int64Value(remote.LeadDays),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *extendedSupportSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan extendedSupportSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op: the settings row has no DELETE and no documented reset.
func (r *extendedSupportSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *extendedSupportSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *extendedSupportSettingsResource) write(ctx context.Context, plan extendedSupportSettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutExtendedSupportSettings(ctx, iw.ExtendedSupportSettingsUpdate{
		Enabled:  boolPtr(plan.Enabled),
		LeadDays: int64Ptr(plan.LeadDays),
	})
	if err != nil {
		diags.AddError("Unable to write extended support settings", err.Error())
		return
	}
	next := extendedSupportSettingsResourceModel{
		ID:       types.StringValue(r.client.OrgID()),
		Enabled:  types.BoolValue(saved.Enabled),
		LeadDays: types.Int64Value(saved.LeadDays),
	}
	diags.Append(state.Set(ctx, &next)...)
}
