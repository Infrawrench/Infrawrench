package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costReportFolderResource)(nil)
	_ resource.ResourceWithConfigure   = (*costReportFolderResource)(nil)
	_ resource.ResourceWithImportState = (*costReportFolderResource)(nil)
)

// NewCostReportFolderResource constructs the infrawrench_cost_report_folder resource.
func NewCostReportFolderResource() resource.Resource { return &costReportFolderResource{} }

type costReportFolderResource struct{ client *iw.Client }

type costReportFolderResourceModel struct {
	ID             types.String `tfsdk:"id"`
	Name           types.String `tfsdk:"name"`
	ParentFolderID types.String `tfsdk:"parent_folder_id"`
}

func (r *costReportFolderResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_report_folder"
}

func (r *costReportFolderResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A folder in the cost report tree.\n\n" +
			"Folders are organisational only, so deleting one is never blocked by its contents: " +
			"the reports and sub-folders inside it fall back to the top level rather than being " +
			"deleted with it. That makes destroying a folder safe, but it does mean a `terraform " +
			"destroy` of a folder alone quietly rearranges where its reports appear.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned folder id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
			},
			"parent_folder_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of the containing folder. Omit it to keep the folder at the top level. " +
					"Maximum nesting depth is 3, and a parent that would close a cycle — including a " +
					"folder pointing at itself — is rejected with a 400 rather than silently ignored.",
			},
		},
	}
}

func (r *costReportFolderResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costReportFolderResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costReportFolderResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costReportFolderInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCostReportFolder(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create cost report folder", err.Error())
		return
	}

	state, diags := costReportFolderStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes one folder out of the org's flat listing.
//
// There is no single-GET route for a folder, so iw.GetCostReportFolder fetches
// the list and filters client-side, synthesising the 404 when the id is absent.
// The synthesised error satisfies iw.IsNotFound like a real one, so a folder
// deleted outside Terraform lands as "needs recreating" rather than as an opaque
// refresh failure.
func (r *costReportFolderResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costReportFolderResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCostReportFolder(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost report folder", err.Error())
		return
	}

	refreshed, diags := costReportFolderStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costReportFolderResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costReportFolderResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costReportFolderResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costReportFolderInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCostReportFolder(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Cost report folder no longer exists",
				"The folder was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update cost report folder", err.Error())
		return
	}

	next, diags := costReportFolderStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costReportFolderResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costReportFolderResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteCostReportFolder(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete cost report folder", err.Error())
	}
}

func (r *costReportFolderResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// costReportFolderInputFrom maps Terraform configuration onto the POST/PUT body.
//
// ParentFolderID is handed over as a plain pointer because iw.CostReportFolderInput
// marshals a nil as an explicit JSON null, which is what moves a folder back to
// the top level. Eliding the key instead would mean "leave it where it is", and
// that is not what clearing the attribute asks for.
func costReportFolderInputFrom(_ context.Context, model costReportFolderResourceModel) (iw.CostReportFolderInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	return iw.CostReportFolderInput{
		Name:           model.Name.ValueString(),
		ParentFolderID: stringPtr(model.ParentFolderID),
	}, diags
}

// costReportFolderStateFrom maps a server folder into Terraform state. Every
// attribute round-trips verbatim, so the prior model has nothing to backfill; it
// stays in the signature to keep the mapping shape uniform across the provider.
func costReportFolderStateFrom(_ context.Context, remote *iw.CostReportFolder, _ costReportFolderResourceModel) (costReportFolderResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	return costReportFolderResourceModel{
		ID:             types.StringValue(remote.ID),
		Name:           types.StringValue(remote.Name),
		ParentFolderID: stringValue(remote.ParentFolderID),
	}, diags
}
