package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
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
	LabelMapping  types.List   `tfsdk:"label_mapping"`
	Threshold     types.List   `tfsdk:"threshold"`
}

type businessMetricLabelMappingModel struct {
	Label     types.String `tfsdk:"label"`
	Target    types.String `tfsdk:"target"`
	Dimension types.String `tfsdk:"dimension"`
	TagKey    types.String `tfsdk:"tag_key"`
}

var businessMetricLabelMappingObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"label":     types.StringType,
	"target":    types.StringType,
	"dimension": types.StringType,
	"tag_key":   types.StringType,
}}

type unitCostThresholdModel struct {
	Mode         types.String  `tfsdk:"mode"`
	Direction    types.String  `tfsdk:"direction"`
	Value        types.Float64 `tfsdk:"value"`
	Scale        types.Int64   `tfsdk:"scale"`
	GroupByLabel types.String  `tfsdk:"group_by_label"`
	WindowDays   types.Int64   `tfsdk:"window_days"`
}

var unitCostThresholdObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"mode":           types.StringType,
	"direction":      types.StringType,
	"value":          types.Float64Type,
	"scale":          types.Int64Type,
	"group_by_label": types.StringType,
	"window_days":    types.Int64Type,
}}

// unitCostScales is the closed set of "per N units" the API accepts.
var unitCostScales = []int64{1, 100, 1000, 1000000, 1000000000}

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
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"unit": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Singular unit label used for display — the noun in \"USD per customer\". " +
					"1–32 characters.",
				Validators: []validatorString{stringvalidator.LengthBetween(1, 32)},
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
			"label_mapping": schema.ListNestedBlock{
				MarkdownDescription: "Joins a label the metric's values carry (for example `customer`) to where " +
					"its values live on the cost side, so unit cost and margin can be computed per label value " +
					"(cost per customer, margin per customer). Unit-cost queries refuse to split or filter a " +
					"ratio by an unmapped label, because without a per-value numerator the only spend available " +
					"is the whole scope's. At most 8, one per label.",
				Validators: []validator.List{sizeAtMost(8)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"label": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "The label key, a lowercase slug of 1–64 characters (letters, " +
								"digits, `_ . -`).",
							Validators: []validatorString{stringvalidator.LengthBetween(1, 64)},
						},
						"target": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "`dimension` to match label values to a cost dimension's values " +
								"exactly, or `cost_centre` to match them to cost centres by id or, " +
								"case-insensitively, by name.",
							Validators: []validatorString{oneOfValidator("dimension", "cost_centre")},
						},
						"dimension": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "With `target = \"dimension\"` only: the cost dimension, one of `" +
								joinBackticked(costDimensions) + "`.",
							Validators: []validatorString{oneOfValidator(costDimensions...)},
						},
						"tag_key": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "The tag key, required when `dimension` is `tag` and omitted otherwise.",
						},
					},
				},
			},
			"threshold": schema.ListNestedBlock{
				MarkdownDescription: "A standing limit on this metric's unit cost or margin, evaluated daily on the " +
					"summed ratio over the trailing window and routed through alert routing under the " +
					"`unitCostRegressionAlerts` trigger. A window with fewer than half its days reported is not " +
					"judged. At most 10.",
				Validators: []validator.List{sizeAtMost(10)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"mode": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "`unit_cost` (spend ÷ metric) or `margin` (`(revenue − spend) ÷ " +
								"revenue`, which needs `kind = \"currency\"`).",
							Validators: []validatorString{oneOfValidator("unit_cost", "margin")},
						},
						"direction": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "`above` or `below`: which side of `value` fires.",
							Validators:          []validatorString{oneOfValidator("above", "below")},
						},
						"value": schema.Float64Attribute{
							Required: true,
							MarkdownDescription: "The limit: currency units per `scale` metric units for " +
								"`unit_cost`, and a percentage (`30` for 30%) for `margin`.",
						},
						"scale": schema.Int64Attribute{
							Optional: true,
							Computed: true,
							Default:  int64default.StaticInt64(1),
							MarkdownDescription: "\"Per N units\" for a `unit_cost` limit: `1`, `100`, `1000`, " +
								"`1000000` or `1000000000`. Ignored for `margin`. Defaults to `1`.",
							Validators: []validator.Int64{int64validator.OneOf(unitCostScales...)},
						},
						"group_by_label": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Evaluate the limit separately for each value of this label " +
								"(each customer). The label must have a `label_mapping`.",
						},
						"window_days": schema.Int64Attribute{
							Optional: true,
							Computed: true,
							Default:  int64default.StaticInt64(7),
							MarkdownDescription: "Trailing complete days the ratio is summed over, 1–90. " +
								"Defaults to `7`.",
							Validators: []validator.Int64{between(1, 90)},
						},
					},
				},
			},
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

	mappings := []iw.BusinessMetricLabelMapping{}
	if !model.LabelMapping.IsNull() && !model.LabelMapping.IsUnknown() {
		var models []businessMetricLabelMappingModel
		diags.Append(model.LabelMapping.ElementsAs(ctx, &models, false)...)
		for _, m := range models {
			target := iw.BusinessMetricLabelTarget{Kind: m.Target.ValueString()}
			if target.Kind == "dimension" {
				target.Dimension = stringPtr(m.Dimension)
				target.TagKey = stringPtr(m.TagKey)
			}
			mappings = append(mappings, iw.BusinessMetricLabelMapping{Label: m.Label.ValueString(), Target: target})
		}
	}

	thresholds := []iw.UnitCostThreshold{}
	if !model.Threshold.IsNull() && !model.Threshold.IsUnknown() {
		var models []unitCostThresholdModel
		diags.Append(model.Threshold.ElementsAs(ctx, &models, false)...)
		for _, m := range models {
			thresholds = append(thresholds, iw.UnitCostThreshold{
				Mode:         m.Mode.ValueString(),
				Direction:    m.Direction.ValueString(),
				Value:        m.Value.ValueFloat64(),
				Scale:        int64Ptr(m.Scale),
				GroupByLabel: stringPtr(m.GroupByLabel),
				WindowDays:   int64Ptr(m.WindowDays),
			})
		}
	}
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
		LabelMappings: mappings,
		Thresholds:    thresholds,
	}, diags
}

func businessMetricLabelMappingsTo(ctx context.Context, remote []iw.BusinessMetricLabelMapping) (types.List, diag.Diagnostics) {
	models := make([]businessMetricLabelMappingModel, 0, len(remote))
	for _, m := range remote {
		models = append(models, businessMetricLabelMappingModel{
			Label:     types.StringValue(m.Label),
			Target:    types.StringValue(m.Target.Kind),
			Dimension: stringValue(m.Target.Dimension),
			TagKey:    stringValue(m.Target.TagKey),
		})
	}
	return types.ListValueFrom(ctx, businessMetricLabelMappingObjectType, models)
}

func unitCostThresholdsTo(ctx context.Context, remote []iw.UnitCostThreshold) (types.List, diag.Diagnostics) {
	models := make([]unitCostThresholdModel, 0, len(remote))
	for _, t := range remote {
		// The server omits a scale of 1 and always states the window, so both
		// read back as concrete values matching their schema defaults.
		scale := int64(1)
		if t.Scale != nil {
			scale = *t.Scale
		}
		window := int64(7)
		if t.WindowDays != nil {
			window = *t.WindowDays
		}
		models = append(models, unitCostThresholdModel{
			Mode:         types.StringValue(t.Mode),
			Direction:    types.StringValue(t.Direction),
			Value:        types.Float64Value(t.Value),
			Scale:        types.Int64Value(scale),
			GroupByLabel: stringValue(t.GroupByLabel),
			WindowDays:   types.Int64Value(window),
		})
	}
	return types.ListValueFrom(ctx, unitCostThresholdObjectType, models)
}

func businessMetricStateFrom(ctx context.Context, remote *iw.BusinessMetric) (businessMetricResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	scope, d := costFiltersTo(ctx, remote.CostScope)
	diags.Append(d...)
	mappings, d := businessMetricLabelMappingsTo(ctx, remote.LabelMappings)
	diags.Append(d...)
	thresholds, d := unitCostThresholdsTo(ctx, remote.Thresholds)
	diags.Append(d...)

	return businessMetricResourceModel{
		LabelMapping:  mappings,
		Threshold:     thresholds,
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
