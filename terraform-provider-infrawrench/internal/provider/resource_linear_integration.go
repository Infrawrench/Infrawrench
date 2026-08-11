package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*linearIntegrationResource)(nil)
	_ resource.ResourceWithConfigure   = (*linearIntegrationResource)(nil)
	_ resource.ResourceWithImportState = (*linearIntegrationResource)(nil)
)

// NewLinearIntegrationResource constructs the infrawrench_linear_integration
// resource.
func NewLinearIntegrationResource() resource.Resource { return &linearIntegrationResource{} }

type linearIntegrationResource struct{ client *iw.Client }

type linearIntegrationResourceModel struct {
	ID            types.String `tfsdk:"id"`
	APIKey        types.String `tfsdk:"api_key"`
	DefaultTeamID types.String `tfsdk:"default_team_id"`
	KeyHint       types.String `tfsdk:"key_hint"`
}

func (r *linearIntegrationResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_linear_integration"
}

func (r *linearIntegrationResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The organization's Linear connection, used to file issues from findings and " +
			"alerts.\n\n" +
			"An organization **singleton**. `terraform destroy` disconnects it, which drops the stored key; " +
			"existing issue links survive.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("The Linear connection"),
			"api_key": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "Personal API key from Linear → Settings → Security & access. **Required on " +
					"first connect**; omit it afterwards to keep the stored key.\n\n" +
					"Write-only: no route returns it, so the provider cannot detect drift on its value. " +
					"Compare `key_hint` if you need to check which key is stored.",
			},
			"default_team_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Team the file-issue window preselects. A Linear team **id**, not a team " +
					"key like `ENG`.",
			},

			"key_hint": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Redacted marker for the stored key, e.g. `…a7f2`.",
			},
		},
	}
}

func (r *linearIntegrationResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *linearIntegrationResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan linearIntegrationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *linearIntegrationResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state linearIntegrationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetLinearIntegration(ctx)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read the Linear integration", err.Error())
		return
	}

	refreshed := linearStateFrom(r.client.OrgID(), remote, state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *linearIntegrationResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan linearIntegrationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *linearIntegrationResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if err := r.client.DeleteLinearIntegration(ctx); err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to disconnect Linear", err.Error())
	}
}

func (r *linearIntegrationResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *linearIntegrationResource) write(ctx context.Context, plan linearIntegrationResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutLinearIntegration(ctx, iw.LinearIntegrationInput{
		APIKey:        stringPtr(plan.APIKey),
		DefaultTeamID: stringPtr(plan.DefaultTeamID),
	})
	if err != nil {
		diags.AddError("Unable to write the Linear integration", err.Error())
		return
	}
	next := linearStateFrom(r.client.OrgID(), saved, plan)
	diags.Append(state.Set(ctx, &next)...)
}

// linearStateFrom carries the key forward from the prior model — it is
// write-only, and refreshing must not drop it out of state.
func linearStateFrom(orgID string, remote *iw.LinearIntegration, prior linearIntegrationResourceModel) linearIntegrationResourceModel {
	return linearIntegrationResourceModel{
		ID:            types.StringValue(orgID),
		APIKey:        prior.APIKey,
		DefaultTeamID: stringValue(remote.DefaultTeamID),
		KeyHint:       types.StringValue(remote.KeyHint),
	}
}
