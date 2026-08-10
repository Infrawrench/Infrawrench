package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

/* ---------------------------- scalar conversions --------------------------- */
//
// The framework distinguishes null, unknown and set; the wire distinguishes
// absent, null and set. These helpers pin the mapping once so eleven resources
// cannot each pick a slightly different one.
//
// Unknown collapses to nil the same way null does. During a plan an unknown is
// a value Terraform has not computed yet; sending it would be sending a lie.

func stringPtr(v types.String) *string {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	s := v.ValueString()
	return &s
}

func int64Ptr(v types.Int64) *int64 {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	i := v.ValueInt64()
	return &i
}

func float64Ptr(v types.Float64) *float64 {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	f := v.ValueFloat64()
	return &f
}

func boolPtr(v types.Bool) *bool {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	b := v.ValueBool()
	return &b
}

func stringValue(p *string) types.String {
	if p == nil {
		return types.StringNull()
	}
	return types.StringValue(*p)
}

func int64Value(p *int64) types.Int64 {
	if p == nil {
		return types.Int64Null()
	}
	return types.Int64Value(*p)
}

func float64Value(p *float64) types.Float64 {
	if p == nil {
		return types.Float64Null()
	}
	return types.Float64Value(*p)
}

func boolValue(p *bool) types.Bool {
	if p == nil {
		return types.BoolNull()
	}
	return types.BoolValue(*p)
}

// boolValueOrDefault reads a tri-state remote boolean into a non-null attribute.
// Several fields are optional on the wire but have a documented server-side
// default; returning null for them would show as perpetual drift against a
// config that spells the default out.
func boolValueOrDefault(p *bool, fallback bool) types.Bool {
	if p == nil {
		return types.BoolValue(fallback)
	}
	return types.BoolValue(*p)
}

// stringSlice reads a types.List of strings. A null or unknown list becomes an
// empty slice, never nil, because every list on this API is `[]`-not-null.
func stringSlice(ctx context.Context, list types.List) ([]string, diag.Diagnostics) {
	var diags diag.Diagnostics
	out := []string{}
	if list.IsNull() || list.IsUnknown() {
		return out, diags
	}
	diags.Append(list.ElementsAs(ctx, &out, false)...)
	if out == nil {
		out = []string{}
	}
	return out, diags
}

// stringList renders a slice back to a types.List, mapping an empty slice to an
// empty list rather than to null so a round trip is stable.
func stringList(ctx context.Context, values []string) (types.List, diag.Diagnostics) {
	if values == nil {
		values = []string{}
	}
	return types.ListValueFrom(ctx, types.StringType, values)
}

// optionalStringList maps an absent slice to a null list. Used where the API
// genuinely omits the key rather than sending `[]`.
func optionalStringList(ctx context.Context, values []string) (types.List, diag.Diagnostics) {
	if len(values) == 0 {
		return types.ListNull(types.StringType), nil
	}
	return types.ListValueFrom(ctx, types.StringType, values)
}

/* ------------------------------- cost filters ------------------------------ */

// costFilterModel is one filter clause as Terraform sees it.
type costFilterModel struct {
	Dimension types.String `tfsdk:"dimension"`
	Op        types.String `tfsdk:"op"`
	Values    types.List   `tfsdk:"values"`
	TagKey    types.String `tfsdk:"tag_key"`
}

var costFilterAttrTypes = map[string]attr.Type{
	"dimension": types.StringType,
	"op":        types.StringType,
	"values":    types.ListType{ElemType: types.StringType},
	"tag_key":   types.StringType,
}

var costFilterObjectType = types.ObjectType{AttrTypes: costFilterAttrTypes}

// costDimensions is the closed set the API accepts on a filter clause.
var costDimensions = []string{
	"provider", "account", "service", "region", "resource", "tag", "charge_type", "commitment",
}

// costFilterBlockSchema is the shared `filter` nested block. Every object that
// filters spend uses this exact shape, so a practitioner learns it once.
func costFilterBlockSchema(description string) schema.ListNestedBlock {
	return schema.ListNestedBlock{
		MarkdownDescription: description,
		NestedObject: schema.NestedBlockObject{
			Attributes: map[string]schema.Attribute{
				"dimension": schema.StringAttribute{
					Required:            true,
					MarkdownDescription: "Cost dimension to filter on. One of `" + joinBackticked(costDimensions) + "`.",
					Validators:          []validator.String{oneOfValidator(costDimensions...)},
				},
				"op": schema.StringAttribute{
					Required:            true,
					MarkdownDescription: "`in` to keep matching rows, `not_in` to exclude them.",
					Validators:          []validator.String{oneOfValidator("in", "not_in")},
				},
				"values": schema.ListAttribute{
					Required:            true,
					ElementType:         types.StringType,
					MarkdownDescription: "Values to match. Must not be empty.",
				},
				"tag_key": schema.StringAttribute{
					Optional:            true,
					MarkdownDescription: "Tag key, required when `dimension` is `tag` and rejected otherwise.",
				},
			},
		},
	}
}

// costFiltersFrom reads a filter block list into wire clauses.
func costFiltersFrom(ctx context.Context, list types.List) ([]iw.CostFilter, diag.Diagnostics) {
	var diags diag.Diagnostics
	out := []iw.CostFilter{}
	if list.IsNull() || list.IsUnknown() {
		return out, diags
	}

	var models []costFilterModel
	diags.Append(list.ElementsAs(ctx, &models, false)...)
	if diags.HasError() {
		return out, diags
	}

	for _, m := range models {
		values, d := stringSlice(ctx, m.Values)
		diags.Append(d...)
		if diags.HasError() {
			return out, diags
		}
		out = append(out, iw.CostFilter{
			Dimension: m.Dimension.ValueString(),
			Op:        m.Op.ValueString(),
			Values:    values,
			TagKey:    stringPtr(m.TagKey),
		})
	}
	return out, diags
}

// costFiltersTo renders wire clauses back into a filter block list.
func costFiltersTo(ctx context.Context, filters []iw.CostFilter) (types.List, diag.Diagnostics) {
	var diags diag.Diagnostics
	models := make([]costFilterModel, 0, len(filters))
	for _, f := range filters {
		values, d := stringList(ctx, f.Values)
		diags.Append(d...)
		if diags.HasError() {
			return types.ListNull(costFilterObjectType), diags
		}
		models = append(models, costFilterModel{
			Dimension: types.StringValue(f.Dimension),
			Op:        types.StringValue(f.Op),
			Values:    values,
			TagKey:    stringValue(f.TagKey),
		})
	}
	list, d := types.ListValueFrom(ctx, costFilterObjectType, models)
	diags.Append(d...)
	return list, diags
}
