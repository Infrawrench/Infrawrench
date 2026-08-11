package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*postureAlertSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*postureAlertSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*postureAlertSettingsResource)(nil)
)

// NewPostureAlertSettingsResource constructs the
// infrawrench_posture_alert_settings resource.
func NewPostureAlertSettingsResource() resource.Resource { return &postureAlertSettingsResource{} }

type postureAlertSettingsResource struct{ client *iw.Client }

type postureAlertSettingsResourceModel struct {
	ID      types.String `tfsdk:"id"`
	Enabled types.Bool   `tfsdk:"enabled"`
}

func (r *postureAlertSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_posture_alert_settings"
}

func (r *postureAlertSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Whether posture-check findings — public buckets, wide-open security groups, " +
			"unencrypted volumes — raise notifications for this organization.\n\n" +
			"Which findings are *produced* is not configured here: the checks always run and the results " +
			"are always on the posture page. This only decides whether anyone is told without looking.\n\n" +
			"An organization **singleton**, with no DELETE on the route: `terraform destroy` leaves the " +
			"stored setting alone.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Posture alerting"),
			"enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether the poller sends posture alerts for this organization at all.",
			},
		},
	}
}

func (r *postureAlertSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *postureAlertSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan postureAlertSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *postureAlertSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state postureAlertSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetPostureAlertSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read posture alert settings", err.Error())
		return
	}

	refreshed := postureAlertSettingsResourceModel{
		ID:      types.StringValue(r.client.OrgID()),
		Enabled: types.BoolValue(remote.Enabled),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *postureAlertSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan postureAlertSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op — the settings row has no DELETE and no documented reset.
func (r *postureAlertSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *postureAlertSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *postureAlertSettingsResource) write(ctx context.Context, plan postureAlertSettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutPostureAlertSettings(ctx, iw.PostureAlertSettingsUpdate{
		Enabled: boolPtr(plan.Enabled),
	})
	if err != nil {
		diags.AddError("Unable to write posture alert settings", err.Error())
		return
	}
	next := postureAlertSettingsResourceModel{
		ID:      types.StringValue(r.client.OrgID()),
		Enabled: types.BoolValue(saved.Enabled),
	}
	diags.Append(state.Set(ctx, &next)...)
}
