package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*networkFlowSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*networkFlowSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*networkFlowSettingsResource)(nil)
)

// NewNetworkFlowSettingsResource constructs the
// infrawrench_network_flow_settings resource.
func NewNetworkFlowSettingsResource() resource.Resource { return &networkFlowSettingsResource{} }

type networkFlowSettingsResource struct{ client *iw.Client }

type networkFlowSettingsResourceModel struct {
	ID                  types.String `tfsdk:"id"`
	Enabled             types.Bool   `tfsdk:"enabled"`
	InitialLookbackDays types.Int64  `tfsdk:"initial_lookback_days"`
}

func (r *networkFlowSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_network_flow_settings"
}

func (r *networkFlowSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Whether Infrawrench collects priced network flow attribution — which two things " +
			"are talking, across which billing boundary, and what that costs.\n\n" +
			"**Turning this on spends money in your cloud account.** Collection runs flow-log queries that " +
			"the provider bills to you, every day, until somebody turns it off. That is why the switch " +
			"ships off, why the API gates it on `org:settings:write` rather than `costs:write`, and why " +
			"every change to it is audit-logged: when the line appears on a bill review, somebody has to " +
			"be able to find out who agreed to it. It is also exactly the kind of decision worth making " +
			"in a pull request.\n\n" +
			"An organization **singleton**. Unlike the other settings resources, `terraform destroy` here " +
			"turns collection **off** rather than leaving it as configured — a no-op would keep billing " +
			"your cloud account for a resource you deleted, and of the two ways to be wrong, the one that " +
			"stops spending is the safer.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Network flow collection"),
			"enabled": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Whether flows are collected at all. Ships as `false`, and the absence of " +
					"a stored setting is a \"no\" rather than an \"unset, assume yes\".",
			},
			"initial_lookback_days": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "How far back the first collection reaches, 1–30 days. Defaults to 7.\n\n" +
					"This is the expensive number: the first pass queries this many days at once, and the " +
					"provider bills for the log data it scans. It is bounded server-side so a typo cannot bill " +
					"somebody for a year of scans, and it only governs the *initial* backfill — steady-state " +
					"collection moves forward a day at a time.\n\n" +
					"Optional and Computed because the route reads an omitted value as \"keep the stored one\", " +
					"so leaving it out keeps whatever is set rather than resetting it to 7.",
				Validators: []validatorInt64{between(1, 30)},
			},
		},
	}
}

func (r *networkFlowSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *networkFlowSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan networkFlowSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *networkFlowSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state networkFlowSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetNetworkFlowSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read network flow settings", err.Error())
		return
	}

	refreshed := networkFlowSettingsStateFrom(r.client.OrgID(), remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *networkFlowSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan networkFlowSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete turns collection off.
//
// The other settings singletons are no-ops or restore-to-defaults, and this one
// is deliberately neither: leaving collection running would keep charging the
// practitioner's own cloud account for a resource they deleted, in perpetuity,
// with nothing in Terraform left to show why. The lookback is left as stored —
// it costs nothing while disabled, and it is the setting somebody would want
// back if they re-enable.
func (r *networkFlowSettingsResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state networkFlowSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	lookback := state.InitialLookbackDays.ValueInt64()
	if lookback == 0 {
		lookback = defaultNetworkFlowLookbackDays
	}

	if _, err := r.client.PutNetworkFlowSettings(ctx, iw.NetworkFlowSettings{
		Enabled:             false,
		InitialLookbackDays: lookback,
	}); err != nil {
		resp.Diagnostics.AddError(
			"Unable to turn network flow collection off",
			err.Error()+"\n\nCollection is still running and still billing your cloud account. "+
				"Turn it off on the network costs page.")
	}
}

func (r *networkFlowSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

// defaultNetworkFlowLookbackDays mirrors the server's own default. Used only to
// keep the destroy body valid when state somehow carries no lookback — the PUT
// requires the field, and inventing a bigger number there would be inventing a
// bill.
const defaultNetworkFlowLookbackDays = 7

func (r *networkFlowSettingsResource) write(ctx context.Context, plan networkFlowSettingsResourceModel, diags *diagnostics, state *tfState) {
	// An unknown lookback — the practitioner omitted the attribute — has to
	// resolve to something before the body is built, because the field is
	// required on the wire. Reading the stored value first is what makes
	// "omitted" mean "leave it alone" rather than "reset it to 7".
	lookback := plan.InitialLookbackDays.ValueInt64()
	if plan.InitialLookbackDays.IsNull() || plan.InitialLookbackDays.IsUnknown() {
		current, err := r.client.GetNetworkFlowSettings(ctx)
		if err != nil {
			diags.AddError("Unable to read the current network flow settings", err.Error())
			return
		}
		lookback = current.InitialLookbackDays
	}

	saved, err := r.client.PutNetworkFlowSettings(ctx, iw.NetworkFlowSettings{
		Enabled:             plan.Enabled.ValueBool(),
		InitialLookbackDays: lookback,
	})
	if err != nil {
		diags.AddError("Unable to write network flow settings", err.Error())
		return
	}

	next := networkFlowSettingsStateFrom(r.client.OrgID(), saved)
	diags.Append(state.Set(ctx, &next)...)
}

func networkFlowSettingsStateFrom(orgID string, remote *iw.NetworkFlowSettings) networkFlowSettingsResourceModel {
	return networkFlowSettingsResourceModel{
		ID:                  types.StringValue(orgID),
		Enabled:             types.BoolValue(remote.Enabled),
		InitialLookbackDays: types.Int64Value(remote.InitialLookbackDays),
	}
}
