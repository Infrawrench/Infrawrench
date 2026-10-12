package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*seatSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*seatSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*seatSettingsResource)(nil)
)

// NewSeatSettingsResource constructs the infrawrench_seat_settings resource.
func NewSeatSettingsResource() resource.Resource {
	return &seatSettingsResource{}
}

type seatSettingsResource struct{ client *iw.Client }

type seatSettingsResourceModel struct {
	ID           types.String `tfsdk:"id"`
	InactiveDays types.Int64  `tfsdk:"inactive_days"`
}

// seatSettingsDefaults are the server's documented defaults, restored on
// destroy.
var seatSettingsDefaults = iw.SeatSettings{InactiveDays: 30}

func (r *seatSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_seat_settings"
}

func (r *seatSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Organization-wide setting for the Seats findings: paid SaaS seats (GitHub " +
			"Copilot, Cursor, GitLab, Okta, Claude Enterprise, Docker Hub, Tailscale) that nobody has " +
			"used for a while, that duplicate another tool the same person pays for, or that sit on a " +
			"dearer tier than their usage needs.\n\n" +
			"An organization **singleton**: the row always exists, so `terraform destroy` restores the " +
			"shipped default rather than deleting anything. Reading needs the `costs:read` permission " +
			"and writing needs `costs:write`.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Seat settings"),

			"inactive_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "How many days a paid seat may go unused before it is flagged as " +
					"inactive, 7–365. Ships as 30. A seat assigned more recently than this is never " +
					"flagged, and a provider that reports no activity for a seat never has it flagged, " +
					"whatever the value.",
				Validators: []validatorInt64{between(7, 365)},
			},
		},
	}
}

func (r *seatSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *seatSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan seatSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *seatSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state seatSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetSeatSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read seat settings", err.Error())
		return
	}

	refreshed := seatSettingsStateFrom(r.client.OrgID(), remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *seatSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan seatSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *seatSettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutSeatSettings(ctx, seatSettingsDefaults); err != nil {
		resp.Diagnostics.AddError("Unable to reset seat settings", err.Error())
	}
}

func (r *seatSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *seatSettingsResource) write(ctx context.Context, plan seatSettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutSeatSettings(ctx, iw.SeatSettings{
		InactiveDays: plan.InactiveDays.ValueInt64(),
	})
	if err != nil {
		diags.AddError("Unable to write seat settings", err.Error())
		return
	}

	next := seatSettingsStateFrom(r.client.OrgID(), saved)
	diags.Append(state.Set(ctx, &next)...)
}

func seatSettingsStateFrom(orgID string, remote *iw.SeatSettings) seatSettingsResourceModel {
	return seatSettingsResourceModel{
		ID:           types.StringValue(orgID),
		InactiveDays: types.Int64Value(remote.InactiveDays),
	}
}
