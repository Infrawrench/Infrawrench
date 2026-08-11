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
	_ resource.Resource                = (*driftAlertSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*driftAlertSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*driftAlertSettingsResource)(nil)
)

// NewDriftAlertSettingsResource constructs the infrawrench_drift_alert_settings
// resource.
func NewDriftAlertSettingsResource() resource.Resource { return &driftAlertSettingsResource{} }

type driftAlertSettingsResource struct{ client *iw.Client }

type driftAlertSettingsResourceModel struct {
	ID              types.String `tfsdk:"id"`
	NotifyCreated   types.Bool   `tfsdk:"notify_created"`
	NotifyUpdated   types.Bool   `tfsdk:"notify_updated"`
	NotifyDeleted   types.Bool   `tfsdk:"notify_deleted"`
	CooldownMinutes types.Int64  `tfsdk:"cooldown_minutes"`
	MinChanges      types.Int64  `tfsdk:"min_changes"`
	AccountIDs      types.List   `tfsdk:"account_ids"`
}

func (r *driftAlertSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_drift_alert_settings"
}

func (r *driftAlertSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Which resource changes discovered by a sync raise a drift notification, and how " +
			"often the organization can be told.\n\n" +
			"An organization **singleton**. There is no DELETE on this route, so `terraform destroy` " +
			"leaves the stored settings as they are rather than inventing a reset — unlike the cost " +
			"settings, these have no documented shipped values to restore to.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Drift alerting"),
			"notify_created": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Alert on resources that appeared.",
			},
			"notify_updated": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Alert on field-level updates. Usually `false`: updates are the bulk of the " +
					"volume and are most often a provider restating a value it already had.",
			},
			"notify_deleted": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Alert on resources that disappeared.",
			},
			"cooldown_minutes": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Least time between drift notifications for this organization, 5–1440. One " +
					"notification per window, no matter how many changes or accounts it covers.",
			},
			"min_changes": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "Fewest matching changes in a window worth notifying about, 1–1000.",
			},
			"account_ids": schema.ListAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Accounts to alert on, at most 200. Omit it — or give an empty list — for " +
					"every account, including ones connected later.\n\n" +
					"Computed as well as optional because the server always returns the key: an empty list and " +
					"an omitted attribute mean the same thing to it, so removing the attribute keeps whatever " +
					"was last applied rather than clearing it. Set it to `[]` to widen back to every account.",
			},
		},
	}
}

func (r *driftAlertSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *driftAlertSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan driftAlertSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *driftAlertSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state driftAlertSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetDriftAlertSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read drift alert settings", err.Error())
		return
	}

	refreshed, diags := driftAlertSettingsStateFrom(ctx, r.client.OrgID(), remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *driftAlertSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan driftAlertSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op. See the schema description.
func (r *driftAlertSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *driftAlertSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *driftAlertSettingsResource) write(ctx context.Context, plan driftAlertSettingsResourceModel, diags *diagnostics, state *tfState) {
	accounts, d := stringSlice(ctx, plan.AccountIDs)
	diags.Append(d...)
	if diags.HasError() {
		return
	}

	saved, err := r.client.PutDriftAlertSettings(ctx, iw.DriftAlertSettingsUpdate{
		NotifyCreated:   boolPtr(plan.NotifyCreated),
		NotifyUpdated:   boolPtr(plan.NotifyUpdated),
		NotifyDeleted:   boolPtr(plan.NotifyDeleted),
		CooldownMinutes: int64Ptr(plan.CooldownMinutes),
		MinChanges:      int64Ptr(plan.MinChanges),
		AccountIDs:      accounts,
	})
	if err != nil {
		diags.AddError("Unable to write drift alert settings", err.Error())
		return
	}

	next, d := driftAlertSettingsStateFrom(ctx, r.client.OrgID(), saved)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

// driftAlertSettingsStateFrom maps the stored settings into state.
//
// The account list is mapped faithfully — `[]` stays `[]` — even though `[]` and
// an omitted attribute mean the same thing to this route. Folding one into the
// other would fail Terraform's consistency check for a configuration that
// spells the empty list out.
func driftAlertSettingsStateFrom(ctx context.Context, orgID string, remote *iw.DriftAlertSettings) (driftAlertSettingsResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	accounts, d := nilStringList(ctx, remote.AccountIDs)
	diags.Append(d...)

	return driftAlertSettingsResourceModel{
		ID:              types.StringValue(orgID),
		NotifyCreated:   types.BoolValue(remote.NotifyCreated),
		NotifyUpdated:   types.BoolValue(remote.NotifyUpdated),
		NotifyDeleted:   types.BoolValue(remote.NotifyDeleted),
		CooldownMinutes: types.Int64Value(remote.CooldownMinutes),
		MinChanges:      types.Int64Value(remote.MinChanges),
		AccountIDs:      accounts,
	}, diags
}
