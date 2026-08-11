package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costAnnotationResource)(nil)
	_ resource.ResourceWithConfigure   = (*costAnnotationResource)(nil)
	_ resource.ResourceWithImportState = (*costAnnotationResource)(nil)
)

// NewCostAnnotationResource constructs the infrawrench_cost_annotation resource.
func NewCostAnnotationResource() resource.Resource { return &costAnnotationResource{} }

type costAnnotationResource struct{ client *iw.Client }

type costAnnotationResourceModel struct {
	ID           types.String `tfsdk:"id"`
	StartDate    types.String `tfsdk:"start_date"`
	EndDate      types.String `tfsdk:"end_date"`
	Text         types.String `tfsdk:"text"`
	CostReportID types.String `tfsdk:"cost_report_id"`
}

func (r *costAnnotationResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_annotation"
}

func (r *costAnnotationResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A note pinned to a date or a span on cost charts — the migration, the instance-type " +
			"change, the customer that onboarded — so the step in the graph has an explanation next to it " +
			"rather than in somebody's memory.\n\n" +
			"Managing these in Terraform is worth it when the event is already a Terraform change: the " +
			"same pull request that resizes the fleet can annotate the day it happened.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned annotation id. Use it with `terraform import`."),
			"start_date": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Inclusive first day (UTC) the note is about, as `YYYY-MM-DD`. It is mapped to " +
					"whichever bucket holds it at the chart's binning — daily and cumulative use the day itself, " +
					"weekly the Monday that starts its week, monthly the first of its month.",
			},
			"end_date": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Inclusive last day, or omitted for a note about a single moment. A deploy is a " +
					"moment; a migration is a week, and a week spelled as seven notes misstates how many things " +
					"happened.\n\n" +
					"An end equal to the start is stored as null, so writing the same day twice reads back as " +
					"a moment. Set `end_date` only when it genuinely differs from `start_date`.",
			},
			"text": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "The note, 1–500 characters.",
			},
			"cost_report_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The report this note is scoped to. Omit it for an **org-wide** note, which is " +
					"the useful default: an org-wide note is drawn on every cost chart, because \"we changed " +
					"instance types\" is not a fact about one report.",
			},
		},
	}
}

func (r *costAnnotationResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costAnnotationResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costAnnotationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCostAnnotation(ctx, costAnnotationInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to create cost annotation", err.Error())
		return
	}

	state := costAnnotationStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *costAnnotationResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costAnnotationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCostAnnotation(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost annotation", err.Error())
		return
	}

	refreshed := costAnnotationStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costAnnotationResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costAnnotationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costAnnotationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCostAnnotation(ctx, state.ID.ValueString(), costAnnotationInputFrom(plan))
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Cost annotation no longer exists",
				"The annotation was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update cost annotation", err.Error())
		return
	}

	next := costAnnotationStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costAnnotationResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costAnnotationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteCostAnnotation(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete cost annotation", err.Error())
	}
}

func (r *costAnnotationResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// costAnnotationInputFrom maps configuration onto the POST/PUT body. Both
// nullable fields pass straight through as pointers rather than being elided,
// because iw.CostAnnotationInput marshals a nil as an explicit null and null is
// the meaningful value for both: no end date means a moment, no report means
// org-wide.
func costAnnotationInputFrom(model costAnnotationResourceModel) iw.CostAnnotationInput {
	return iw.CostAnnotationInput{
		StartDate:    model.StartDate.ValueString(),
		EndDate:      stringPtr(model.EndDate),
		Text:         model.Text.ValueString(),
		CostReportID: stringPtr(model.CostReportID),
	}
}

func costAnnotationStateFrom(remote *iw.CostAnnotation) costAnnotationResourceModel {
	return costAnnotationResourceModel{
		ID:           types.StringValue(remote.ID),
		StartDate:    types.StringValue(remote.StartDate),
		EndDate:      stringValue(remote.EndDate),
		Text:         types.StringValue(remote.Text),
		CostReportID: stringValue(remote.CostReportID),
	}
}
