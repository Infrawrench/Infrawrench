package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*digestSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*digestSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*digestSettingsResource)(nil)
)

// NewDigestSettingsResource constructs the infrawrench_digest_settings resource.
func NewDigestSettingsResource() resource.Resource { return &digestSettingsResource{} }

type digestSettingsResource struct{ client *iw.Client }

type digestSettingsResourceModel struct {
	ID                 types.String `tfsdk:"id"`
	Enabled            types.Bool   `tfsdk:"enabled"`
	Timezone           types.String `tfsdk:"timezone"`
	SendDay            types.Int64  `tfsdk:"send_day"`
	SendHour           types.Int64  `tfsdk:"send_hour"`
	NarrativeEnabled   types.Bool   `tfsdk:"narrative_enabled"`
	NarrativeAvailable types.Bool   `tfsdk:"narrative_available"`
	EmailAvailable     types.Bool   `tfsdk:"email_available"`
}

func (r *digestSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_digest_settings"
}

func (r *digestSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "When the weekly digest is sent.\n\n" +
			"**Where** it goes is deliberately not configured here. The destinations are whichever Slack " +
			"channels and Teams webhooks have the `weeklyDigest` trigger routed to them through " +
			"`infrawrench_alert_routing`, plus the addresses in `infrawrench_digest_recipient`. One " +
			"routing table decides where every kind of alert goes; a second list living on the digest " +
			"would eventually disagree with it.\n\n" +
			"An organization **singleton**, with no DELETE on the route: `terraform destroy` leaves the " +
			"schedule as configured.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("The weekly digest"),
			"enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether the weekly digest is sent for this organization.",
			},
			"timezone": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "IANA zone, e.g. `Europe/Berlin`. Both the send time and the Monday-to-Sunday " +
					"week boundary are expressed in it. Rejected with a 400 if the server does not know the zone.",
			},
			"send_day": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "ISO day of week the digest is sent on: 1 = Monday … 7 = Sunday.",
				Validators:          []validatorInt64{between(1, 7)},
			},
			"send_hour": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "Local hour (0–23) in `timezone` the digest is sent at.",
				Validators:          []validatorInt64{between(0, 23)},
			},
			"narrative_enabled": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Whether an AI-written summary paragraph is placed above the deterministic " +
					"content. Opt-in, and failures are non-fatal — the digest still sends without the paragraph.",
			},
			"narrative_available": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether this deployment has an LLM API key configured. `false` means " +
					"`narrative_enabled` has no effect.",
			},
			"email_available": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether this deployment has a mail provider configured. `false` means " +
					"`infrawrench_digest_recipient` addresses are never delivered to.",
			},
		},
	}
}

func (r *digestSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *digestSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan digestSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *digestSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state digestSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetDigestSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read digest settings", err.Error())
		return
	}

	refreshed := digestSettingsStateFrom(r.client.OrgID(), remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *digestSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan digestSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op — the settings row has no DELETE and no documented reset.
func (r *digestSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *digestSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *digestSettingsResource) write(ctx context.Context, plan digestSettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutDigestSettings(ctx, iw.DigestSettingsUpdate{
		Enabled:          boolPtr(plan.Enabled),
		Timezone:         stringPtr(plan.Timezone),
		SendDay:          int64Ptr(plan.SendDay),
		SendHour:         int64Ptr(plan.SendHour),
		NarrativeEnabled: boolPtr(plan.NarrativeEnabled),
	})
	if err != nil {
		diags.AddError("Unable to write digest settings", err.Error())
		return
	}
	next := digestSettingsStateFrom(r.client.OrgID(), saved)
	diags.Append(state.Set(ctx, &next)...)
}

func digestSettingsStateFrom(orgID string, remote *iw.DigestSettings) digestSettingsResourceModel {
	return digestSettingsResourceModel{
		ID:                 types.StringValue(orgID),
		Enabled:            types.BoolValue(remote.Enabled),
		Timezone:           types.StringValue(remote.Timezone),
		SendDay:            types.Int64Value(remote.SendDay),
		SendHour:           types.Int64Value(remote.SendHour),
		NarrativeEnabled:   types.BoolValue(remote.NarrativeEnabled),
		NarrativeAvailable: types.BoolValue(remote.NarrativeAvailable),
		EmailAvailable:     types.BoolValue(remote.EmailAvailable),
	}
}
