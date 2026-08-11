package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*sessionRecordingSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*sessionRecordingSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*sessionRecordingSettingsResource)(nil)
)

// NewSessionRecordingSettingsResource constructs the
// infrawrench_session_recording_settings resource.
func NewSessionRecordingSettingsResource() resource.Resource {
	return &sessionRecordingSettingsResource{}
}

type sessionRecordingSettingsResource struct{ client *iw.Client }

type sessionRecordingSettingsResourceModel struct {
	ID            types.String `tfsdk:"id"`
	Enabled       types.Bool   `tfsdk:"enabled"`
	CaptureInput  types.Bool   `tfsdk:"capture_input"`
	RetentionDays types.Int64  `tfsdk:"retention_days"`
}

func (r *sessionRecordingSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_session_recording_settings"
}

func (r *sessionRecordingSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Whether SSH sessions run through Infrawrench are recorded, and for how long the " +
			"recordings are kept.\n\n" +
			"Worth keeping in Terraform precisely because it is an audit control: turning recording off, " +
			"or shortening retention, is then a reviewed change with a name attached rather than a " +
			"setting somebody flipped.\n\n" +
			"An organization **singleton**, with no DELETE on the route: `terraform destroy` leaves " +
			"recording exactly as configured. Removing this resource from your configuration does not " +
			"stop recording, which is the safer default for a control of this kind.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Session recording"),
			"enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether sessions are recorded at all.",
			},
			"capture_input": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Also record keystrokes.\n\n" +
					"Separate from `enabled` because it is a materially different promise to the people being " +
					"recorded: it captures input at prompts the remote host chose not to echo — a sudo " +
					"password, a pasted token — which output-only recording never sees.",
			},
			"retention_days": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "How long recordings are kept, 1–3650 days. Older ones are deleted.",
			},
		},
	}
}

func (r *sessionRecordingSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *sessionRecordingSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan sessionRecordingSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *sessionRecordingSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state sessionRecordingSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetSessionRecordingSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read session recording settings", err.Error())
		return
	}

	refreshed := sessionRecordingSettingsStateFrom(r.client.OrgID(), remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *sessionRecordingSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan sessionRecordingSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op. See the schema description: silently disabling an audit
// control because a resource block was removed is not a safe default.
func (r *sessionRecordingSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *sessionRecordingSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *sessionRecordingSettingsResource) write(ctx context.Context, plan sessionRecordingSettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutSessionRecordingSettings(ctx, iw.SessionRecordingSettingsUpdate{
		Enabled:       boolPtr(plan.Enabled),
		CaptureInput:  boolPtr(plan.CaptureInput),
		RetentionDays: int64Ptr(plan.RetentionDays),
	})
	if err != nil {
		diags.AddError("Unable to write session recording settings", err.Error())
		return
	}
	next := sessionRecordingSettingsStateFrom(r.client.OrgID(), saved)
	diags.Append(state.Set(ctx, &next)...)
}

func sessionRecordingSettingsStateFrom(orgID string, remote *iw.SessionRecordingSettings) sessionRecordingSettingsResourceModel {
	return sessionRecordingSettingsResourceModel{
		ID:            types.StringValue(orgID),
		Enabled:       types.BoolValue(remote.Enabled),
		CaptureInput:  types.BoolValue(remote.CaptureInput),
		RetentionDays: types.Int64Value(remote.RetentionDays),
	}
}
