package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

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
	_ resource.Resource                = (*costCentreResource)(nil)
	_ resource.ResourceWithConfigure   = (*costCentreResource)(nil)
	_ resource.ResourceWithImportState = (*costCentreResource)(nil)
)

// NewCostCentreResource constructs the infrawrench_cost_centre resource.
func NewCostCentreResource() resource.Resource { return &costCentreResource{} }

type costCentreResource struct{ client *iw.Client }

type costCentreResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	ParentID    types.String `tfsdk:"parent_id"`
}

func (r *costCentreResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_centre"
}

func (r *costCentreResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A node in the cost centre tree that `infrawrench_allocation_rule` allocates spend to.\n\n" +
			"Deleting a cost centre is not blocked by having children or rules. The server " +
			"re-parents the children onto the deleted centre's parent and deletes the centre's " +
			"allocation rules; historical spend is left untouched, since allocation is computed " +
			"at query time rather than stored on the cost rows.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned cost centre id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free-text description, up to 2000 characters.",
			},
			"parent_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of the parent cost centre. Omit it to keep the centre at the root. " +
					"Maximum nesting depth is 4, and a parent that would close a cycle is rejected.",
			},
		},
	}
}

func (r *costCentreResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costCentreResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costCentreResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costCentreInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCostCentre(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create cost centre", err.Error())
		return
	}

	state, diags := costCentreStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes one centre out of the org's flat listing.
//
// There is no `GET /cost-centres/{id}` route, so iw.GetCostCentre fetches the
// list and filters client-side, synthesising the 404 when the id is absent. That
// is invisible here on purpose: the error still satisfies iw.IsNotFound, so a
// centre deleted outside Terraform lands as "needs recreating" exactly as it
// would for an object that has a real single-GET route.
func (r *costCentreResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costCentreResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCostCentre(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost centre", err.Error())
		return
	}

	refreshed, diags := costCentreStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costCentreResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costCentreResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costCentreResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costCentreInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCostCentre(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Cost centre no longer exists",
				"The cost centre was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update cost centre", err.Error())
		return
	}

	next, diags := costCentreStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costCentreResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costCentreResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteCostCentre(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete cost centre", err.Error())
	}
}

func (r *costCentreResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// costCentreInputFrom maps Terraform configuration onto the PUT/POST body.
//
// ParentID is passed straight through as a pointer rather than being elided
// when null, because iw.CostCentreInput deliberately marshals a nil parentId as
// an explicit JSON null. An absent key would tell the server to leave the centre
// where it is, and a null Terraform attribute means the opposite of that — it
// means the practitioner wants the centre at the root.
func costCentreInputFrom(_ context.Context, model costCentreResourceModel) (iw.CostCentreInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	return iw.CostCentreInput{
		Name:        model.Name.ValueString(),
		Description: stringPtr(model.Description),
		ParentID:    stringPtr(model.ParentID),
	}, diags
}

// costCentreStateFrom maps a server cost centre into Terraform state.
//
// Unlike the budget, every attribute of a centre round-trips verbatim, so there
// is nothing the prior model has to backfill; it stays in the signature only so
// that all eleven resources map the same way.
func costCentreStateFrom(_ context.Context, remote *iw.CostCentre, _ costCentreResourceModel) (costCentreResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	return costCentreResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Description: stringValue(remote.Description),
		ParentID:    stringValue(remote.ParentID),
	}, diags
}
