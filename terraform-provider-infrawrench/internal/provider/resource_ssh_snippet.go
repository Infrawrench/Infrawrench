package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*sshSnippetResource)(nil)
	_ resource.ResourceWithConfigure   = (*sshSnippetResource)(nil)
	_ resource.ResourceWithImportState = (*sshSnippetResource)(nil)
)

// NewSSHSnippetResource constructs the infrawrench_ssh_snippet resource.
func NewSSHSnippetResource() resource.Resource { return &sshSnippetResource{} }

type sshSnippetResource struct{ client *iw.Client }

type sshSnippetResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Command     types.String `tfsdk:"command"`
	Description types.String `tfsdk:"description"`
}

func (r *sshSnippetResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_ssh_snippet"
}

func (r *sshSnippetResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved command the SSH fan-out runner offers when running something across many " +
			"hosts at once.\n\n" +
			"Worth version-controlling for the same reason a runbook is: the command that collects the " +
			"right diagnostics is knowledge, and a reviewed snippet is safer than one person's shell " +
			"history. Registering a snippet does not run it — it only offers it in the picker.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned snippet id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–100 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 100)},
			},
			"command": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The shell command, up to 4000 characters. Run verbatim on each selected " +
					"host, with no templating and no substitution — what is written here is what runs.",
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "What the command does, up to 500 characters.",
			},
		},
	}
}

func (r *sshSnippetResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *sshSnippetResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan sshSnippetResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateSSHSnippet(ctx, sshSnippetInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to create SSH snippet", err.Error())
		return
	}

	state := sshSnippetStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *sshSnippetResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state sshSnippetResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetSSHSnippet(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read SSH snippet", err.Error())
		return
	}

	refreshed := sshSnippetStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *sshSnippetResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan sshSnippetResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state sshSnippetResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateSSHSnippet(ctx, state.ID.ValueString(), sshSnippetInputFrom(plan))
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"SSH snippet no longer exists",
				"The snippet was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update SSH snippet", err.Error())
		return
	}

	next := sshSnippetStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *sshSnippetResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state sshSnippetResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteSSHSnippet(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete SSH snippet", err.Error())
	}
}

func (r *sshSnippetResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func sshSnippetInputFrom(model sshSnippetResourceModel) iw.SSHSnippetInput {
	return iw.SSHSnippetInput{
		Name:        model.Name.ValueString(),
		Command:     model.Command.ValueString(),
		Description: stringPtr(model.Description),
	}
}

func sshSnippetStateFrom(remote *iw.SSHSnippet) sshSnippetResourceModel {
	return sshSnippetResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Command:     types.StringValue(remote.Command),
		Description: stringValue(remote.Description),
	}
}
