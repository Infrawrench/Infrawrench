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
	_ resource.Resource                = (*digestRecipientResource)(nil)
	_ resource.ResourceWithConfigure   = (*digestRecipientResource)(nil)
	_ resource.ResourceWithImportState = (*digestRecipientResource)(nil)
)

// NewDigestRecipientResource constructs the infrawrench_digest_recipient
// resource.
func NewDigestRecipientResource() resource.Resource { return &digestRecipientResource{} }

type digestRecipientResource struct{ client *iw.Client }

type digestRecipientResourceModel struct {
	ID    types.String `tfsdk:"id"`
	Email types.String `tfsdk:"email"`
}

func (r *digestRecipientResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_digest_recipient"
}

func (r *digestRecipientResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An email address the weekly digest is sent to.\n\n" +
			"A recipient does not have to be a member of the organization, which is the point: the finance " +
			"mailbox that wants the weekly spend summary usually is not one. There is no update route, so " +
			"changing the address replaces the row.\n\n" +
			"Nothing is delivered unless `infrawrench_digest_settings` is enabled **and** the deployment " +
			"has a mail provider configured — see its `email_available` attribute.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned recipient id. Use it with `terraform import`."),
			"email": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The address. Normalized (lowercased) server-side, so write it lower-case " +
					"to avoid a one-time diff after the first apply.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
		},
	}
}

func (r *digestRecipientResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *digestRecipientResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan digestRecipientResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateDigestRecipient(ctx, iw.DigestRecipientInput{
		Email: plan.Email.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to add digest recipient", err.Error())
		return
	}

	state := digestRecipientResourceModel{
		ID:    types.StringValue(created.ID),
		Email: types.StringValue(created.Email),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *digestRecipientResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state digestRecipientResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetDigestRecipient(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read digest recipient", err.Error())
		return
	}

	refreshed := digestRecipientResourceModel{
		ID:    types.StringValue(remote.ID),
		Email: types.StringValue(remote.Email),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update is unreachable — the only configurable attribute forces replacement.
func (r *digestRecipientResource) Update(_ context.Context, _ resource.UpdateRequest, resp *resource.UpdateResponse) {
	resp.Diagnostics.AddError(
		"Digest recipients cannot be updated",
		"The only configurable attribute of infrawrench_digest_recipient forces replacement, so this "+
			"should be unreachable. Please report it to the provider developers.")
}

func (r *digestRecipientResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state digestRecipientResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteDigestRecipient(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to remove digest recipient", err.Error())
	}
}

func (r *digestRecipientResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
