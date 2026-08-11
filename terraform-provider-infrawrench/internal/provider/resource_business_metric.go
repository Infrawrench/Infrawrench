package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*businessMetricResource)(nil)
	_ resource.ResourceWithConfigure   = (*businessMetricResource)(nil)
	_ resource.ResourceWithImportState = (*businessMetricResource)(nil)
)

// NewBusinessMetricResource constructs the infrawrench_business_metric resource.
func NewBusinessMetricResource() resource.Resource { return &businessMetricResource{} }

type businessMetricResource struct{ client *iw.Client }

type businessMetricResourceModel struct {
	ID            types.String `tfsdk:"id"`
	Key           types.String `tfsdk:"key"`
	Name          types.String `tfsdk:"name"`
	Unit          types.String `tfsdk:"unit"`
	Description   types.String `tfsdk:"description"`
	Kind          types.String `tfsdk:"kind"`
	Currency      types.String `tfsdk:"currency"`
	SavedFilterID types.String `tfsdk:"saved_filter_id"`
	CostScope     types.List   `tfsdk:"cost_scope"`
}

var businessMetricKinds = []string{"count", "currency"}

func (r *businessMetricResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_business_metric"
}

func (r *businessMetricResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The denominator of a unit-cost query: the customers, requests or gigabytes " +
			"that spend is divided by.\n\n" +
			"This resource manages the metric's **definition** only. Its values are a time series " +
			"pushed continuously by a job — through the API, the CLI or a workflow — and are " +
			"deliberately not Terraform's to own: a resource holding them would plan a diff every " +
			"time the business changed.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned metric id. Use it with `terraform import`."),
			"key": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Stable lowercase slug (letters, digits, `_ . -`) that workflows and the CLI " +
					"address the metric by. Unique per organization, and independent of `name` so a rename " +
					"never breaks a running job.",
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
			},
			"unit": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Singular unit label used for display — the noun in \"USD per customer\". " +
					"1–32 characters.",
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free-text description, up to 2000 characters.",
			},
			"kind": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "`count` for a unit-less quantity, which supports unit cost only. `currency` " +
					"for money the business took in, which is the only kind margin can be computed against — " +
					"`(revenue − cost) ÷ revenue` subtracts money from money and is undefined otherwise.",
				Validators: []validatorString{oneOfValidator(businessMetricKinds...)},
			},
			"currency": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "ISO-4217 code. **Required when `kind` is `currency`, and rejected " +
					"otherwise** — a revenue metric with no currency cannot have margin computed against it, " +
					"and a count metric carrying one would suggest its numbers are money when they are requests.",
			},
			"saved_filter_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "A saved cost filter AND-composed with `cost_scope`, resolved server-side at " +
					"query time. A reference that fails to resolve errors the unit-cost query rather than " +
					"silently widening the numerator to all spend.",
			},
		},
		Blocks: map[string]schema.Block{
			"cost_scope": costFilterBlockSchema(
				"The spend this metric divides, in the same vocabulary cost graphs and budgets use. " +
					"Omit it for all of the organization's spend. A unit-cost query may narrow this further " +
					"but can never widen it: the scope is part of what the metric means, and a caller who " +
					"could drop it would be answering a different question under the same name."),
		},
	}
}

func (r *businessMetricResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *businessMetricResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan businessMetricResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := businessMetricInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateBusinessMetric(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create business metric", err.Error())
		return
	}

	state, diags := businessMetricStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *businessMetricResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state businessMetricResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetBusinessMetric(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read business metric", err.Error())
		return
	}

	refreshed, diags := businessMetricStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *businessMetricResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan businessMetricResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state businessMetricResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := businessMetricInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateBusinessMetric(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Business metric no longer exists",
				"The metric was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update business metric", err.Error())
		return
	}

	next, diags := businessMetricStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the metric definition.
//
// Its reported values go with it. That is the server's behaviour rather than
// this provider's choice, and it is worth knowing before moving a metric
// between Terraform configurations: a destroy-and-recreate loses the history,
// so a rename should change `name`, never `key`.
func (r *businessMetricResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state businessMetricResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteBusinessMetric(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete business metric", err.Error())
	}
}

func (r *businessMetricResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func businessMetricInputFrom(ctx context.Context, model businessMetricResourceModel) (iw.BusinessMetricInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	scope, d := costFiltersFrom(ctx, model.CostScope)
	diags.Append(d...)
	if diags.HasError() {
		return iw.BusinessMetricInput{}, diags
	}

	return iw.BusinessMetricInput{
		Key:           model.Key.ValueString(),
		Name:          model.Name.ValueString(),
		Unit:          model.Unit.ValueString(),
		Description:   stringPtr(model.Description),
		Kind:          model.Kind.ValueString(),
		Currency:      stringPtr(model.Currency),
		CostScope:     scope,
		SavedFilterID: stringPtr(model.SavedFilterID),
	}, diags
}

func businessMetricStateFrom(ctx context.Context, remote *iw.BusinessMetric) (businessMetricResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	scope, d := costFiltersTo(ctx, remote.CostScope)
	diags.Append(d...)

	return businessMetricResourceModel{
		ID:            types.StringValue(remote.ID),
		Key:           types.StringValue(remote.Key),
		Name:          types.StringValue(remote.Name),
		Unit:          types.StringValue(remote.Unit),
		Description:   stringValue(remote.Description),
		Kind:          types.StringValue(remote.Kind),
		Currency:      stringValue(remote.Currency),
		SavedFilterID: stringValue(remote.SavedFilterID),
		CostScope:     scope,
	}, diags
}
