package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*bastionResource)(nil)
	_ resource.ResourceWithConfigure   = (*bastionResource)(nil)
	_ resource.ResourceWithImportState = (*bastionResource)(nil)
)

// NewBastionResource constructs the infrawrench_bastion resource.
func NewBastionResource() resource.Resource { return &bastionResource{} }

type bastionResource struct{ client *iw.Client }

type bastionResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	TokenPrefix types.String `tfsdk:"token_prefix"`
	Token       types.String `tfsdk:"token"`
	Status      types.String `tfsdk:"status"`
	Connected   types.Bool   `tfsdk:"connected"`
}

func (r *bastionResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_bastion"
}

func (r *bastionResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An enrollment for a bastion agent — the container you run inside a private " +
			"network so Infrawrench can reach cloud APIs and hosts that are not exposed to the internet.\n\n" +
			"Creating one mints an enrollment token; running the agent with it is a separate step this " +
			"resource does not perform. Bind an account to the bastion with `bastion_id` on " +
			"`infrawrench_account`.\n\n" +
			"There is no update route, so renaming replaces — which re-enrolls, meaning a **new token and " +
			"an agent that must be restarted with it**. Bear that in mind before editing `name`.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned bastion id. `terraform import` works, but see `token`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name — usually where the agent runs, e.g. `prod-vpc-eu-west-1`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},

			"token_prefix": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Non-secret leading segment of the enrollment token, shown in the UI.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"token": schema.StringAttribute{
				Computed:  true,
				Sensitive: true,
				MarkdownDescription: "Enrollment token in the form `iwb_…`, passed to the agent container as " +
					"`BASTION_TOKEN`. Returned **once**, at creation.\n\n" +
					"Null on an imported or refreshed resource — nothing can recover it. Same state-file " +
					"warning as `infrawrench_api_key`.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"status": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Enrollment status as the server reports it.",
			},
			"connected": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether an agent is talking to the server right now. Live state — it " +
					"changes without the configuration changing.",
			},
		},
	}
}

func (r *bastionResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *bastionResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan bastionResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateBastion(ctx, iw.CreateBastionRequest{Name: plan.Name.ValueString()})
	if err != nil {
		resp.Diagnostics.AddError("Unable to create bastion", err.Error())
		return
	}

	// The create response carries the token but not the status fields, and an
	// agent that has never checked in is by definition not connected. Reading the
	// row back for two booleans would risk losing the token to a transient error,
	// so they are seeded from what is known and corrected on the next refresh.
	state := bastionResourceModel{
		ID:          types.StringValue(created.ID),
		Name:        types.StringValue(created.Name),
		TokenPrefix: types.StringValue(created.TokenPrefix),
		Token:       types.StringValue(created.Token),
		Status:      types.StringValue("pending"),
		Connected:   types.BoolValue(false),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes the row. A revoked bastion is treated as gone — DELETE revokes
// rather than removing, and iw.Client.GetBastion synthesises the 404.
func (r *bastionResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state bastionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetBastion(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read bastion", err.Error())
		return
	}

	refreshed := bastionResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		TokenPrefix: types.StringValue(remote.TokenPrefix),
		Token:       state.Token,
		Status:      types.StringValue(remote.Status),
		Connected:   types.BoolValue(remote.Connected),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update is unreachable — the only configurable attribute forces replacement.
func (r *bastionResource) Update(_ context.Context, _ resource.UpdateRequest, resp *resource.UpdateResponse) {
	resp.Diagnostics.AddError(
		"Bastions cannot be updated",
		"The only configurable attribute of infrawrench_bastion forces replacement, so this should be "+
			"unreachable. Please report it to the provider developers.")
}

// Delete revokes the enrollment. Accounts bound to it lose their route to the
// private network, so destroy the bastion after — or together with — the
// accounts that use it; Terraform's graph does that automatically when the
// binding is expressed as `bastion_id = infrawrench_bastion.x.id`.
func (r *bastionResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state bastionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteBastion(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete bastion", err.Error())
	}
}

func (r *bastionResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
