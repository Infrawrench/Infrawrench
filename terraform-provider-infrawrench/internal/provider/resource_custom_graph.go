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
	_ resource.Resource                = (*customGraphResource)(nil)
	_ resource.ResourceWithConfigure   = (*customGraphResource)(nil)
	_ resource.ResourceWithImportState = (*customGraphResource)(nil)
)

// NewCustomGraphResource constructs the infrawrench_custom_graph resource.
func NewCustomGraphResource() resource.Resource { return &customGraphResource{} }

type customGraphResource struct{ client *iw.Client }

type customGraphResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Source      types.String `tfsdk:"source"`
}

func (r *customGraphResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_custom_graph"
}

func (r *customGraphResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A code-defined graph: TypeScript that queries the organization's data and returns " +
			"a series to chart.\n\n" +
			"This is the resource where Terraform earns its keep most obviously. The graph is source code, " +
			"so it belongs beside the rest of your source code — `source = file(\"${path.module}/graphs/" +
			"burn.ts\")` keeps it in the repository, under review, with a diff you can read, instead of in " +
			"a web editor where the last edit has no author and no history.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned graph id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "What the graph shows, up to 500 characters.",
			},
			"source": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The graph's TypeScript, up to 128 KiB. Use `file()` rather than a heredoc.\n\n" +
					"It is **not** type-checked at plan time: the API's checker is a separate route this " +
					"provider does not call, because a plan that hit it would need the code to compile before " +
					"Terraform had told you what it was about to change. A graph whose source does not compile " +
					"is stored and fails when rendered.",
			},
		},
	}
}

func (r *customGraphResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *customGraphResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan customGraphResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCustomGraph(ctx, customGraphInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to create custom graph", err.Error())
		return
	}

	state := customGraphStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes one graph.
//
// Custom graphs are soft-deleted: a deleted row keeps its id and gains a
// `deletedAt`. The single-GET route filters those out and 404s, so nothing
// special is needed here — but it is the reason the wire struct decodes
// `deletedAt` at all rather than ignoring it.
func (r *customGraphResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state customGraphResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCustomGraph(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read custom graph", err.Error())
		return
	}
	if remote.DeletedAt != nil {
		resp.State.RemoveResource(ctx)
		return
	}

	refreshed := customGraphStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *customGraphResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan customGraphResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state customGraphResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCustomGraph(ctx, state.ID.ValueString(), customGraphInputFrom(plan))
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Custom graph no longer exists",
				"The graph was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update custom graph", err.Error())
		return
	}

	next := customGraphStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *customGraphResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state customGraphResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteCustomGraph(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete custom graph", err.Error())
	}
}

func (r *customGraphResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func customGraphInputFrom(model customGraphResourceModel) iw.CustomGraphInput {
	return iw.CustomGraphInput{
		Name:        model.Name.ValueString(),
		Description: stringPtr(model.Description),
		Source:      stringPtr(model.Source),
	}
}

// customGraphStateFrom maps a graph into state.
//
// An empty source reads back as null rather than as "", so a configuration that
// omits `source` — a graph registered as a placeholder before its code is
// written — does not show a diff against the empty string the server stores.
func customGraphStateFrom(remote *iw.CustomGraph) customGraphResourceModel {
	source := types.StringNull()
	if remote.Source != "" {
		source = types.StringValue(remote.Source)
	}

	return customGraphResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Description: stringValue(remote.Description),
		Source:      source,
	}
}
