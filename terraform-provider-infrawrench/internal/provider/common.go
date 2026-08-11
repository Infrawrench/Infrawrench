package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
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

// nilStringList distinguishes an absent key from an empty array, which
// optionalStringList deliberately conflates.
//
// This is the mapping every Optional+Computed collection needs, and the reason
// is Terraform's consistency check rather than taste. A configuration that
// spells `[]` produces a *known* empty list in the plan; folding that back to
// null on the way out is "inconsistent result after apply". Only a config that
// omits the attribute entirely leaves an unknown, and null is a legal answer to
// an unknown.
//
// It is also what a tagged union needs: an alert condition on `severity` has no
// `values` key at all, while one on `trigger` always has a non-empty one.
func nilStringList(ctx context.Context, values []string) (types.List, diag.Diagnostics) {
	if values == nil {
		return types.ListNull(types.StringType), nil
	}
	return types.ListValueFrom(ctx, types.StringType, values)
}

// nilStringSet is nilStringList for a set-typed attribute — used where order
// carries no meaning and a reordered configuration must not plan a change.
func nilStringSet(ctx context.Context, values []string) (types.Set, diag.Diagnostics) {
	if values == nil {
		return types.SetNull(types.StringType), nil
	}
	return types.SetValueFrom(ctx, types.StringType, values)
}

// int64Slice reads a types.List of numbers, with the same null-becomes-empty
// rule stringSlice uses.
func int64Slice(ctx context.Context, list types.List) ([]int64, diag.Diagnostics) {
	var diags diag.Diagnostics
	out := []int64{}
	if list.IsNull() || list.IsUnknown() {
		return out, diags
	}
	diags.Append(list.ElementsAs(ctx, &out, false)...)
	if out == nil {
		out = []int64{}
	}
	return out, diags
}

// int64List renders a slice back to a types.List.
func int64List(ctx context.Context, values []int64) (types.List, diag.Diagnostics) {
	if values == nil {
		values = []int64{}
	}
	return types.ListValueFrom(ctx, types.Int64Type, values)
}

// stringMap reads a types.Map of strings. A null or unknown map becomes an
// empty map rather than nil, so a body always carries the key.
func stringMap(ctx context.Context, m types.Map) (map[string]string, diag.Diagnostics) {
	var diags diag.Diagnostics
	out := map[string]string{}
	if m.IsNull() || m.IsUnknown() {
		return out, diags
	}
	diags.Append(m.ElementsAs(ctx, &out, false)...)
	if out == nil {
		out = map[string]string{}
	}
	return out, diags
}

/* ------------------------------- singletons -------------------------------- */
//
// Create and Update are the same write for an organization singleton, and both
// have to land the result in state. Rather than duplicating the body twice per
// resource across a dozen of them, each singleton has one `write` method taking
// the two things Create and Update differ in — which response's diagnostics to
// append to, and which response's state to set. These aliases keep that
// signature readable without every file importing tfsdk.

type diagnostics = diag.Diagnostics

type tfState = tfsdk.State

/* ------------------------------ import helpers ----------------------------- */

// importOrgSingleton is ImportState for the resources that are one row per
// organization — tag policy, the alert settings, currency, the issue-tracker
// connections.
//
// They have no id of their own, so the import address is the organization id
// and any value is accepted: there is only ever one of them, and refusing a
// mistyped org id would only mean a confusing error in place of a correct
// import. The id attribute is then set from the client's configured org so
// state does not record whatever the practitioner happened to type.
func importOrgSingleton(ctx context.Context, orgID string, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), orgID)...)
}

// splitImportID parts a composite import address like
// "reportId/notificationId" into exactly n segments, or explains what was
// expected.
//
// Two resources need one: report notifications hang off a report, and workflow
// schedules off a workflow, so neither one's own id is enough to build a URL.
func splitImportID(raw string, n int, form string) ([]string, error) {
	parts := strings.Split(raw, "/")
	if len(parts) != n {
		return nil, fmt.Errorf("expected an import id of the form %q, got %q", form, raw)
	}
	for _, p := range parts {
		if strings.TrimSpace(p) == "" {
			return nil, fmt.Errorf("expected an import id of the form %q, got %q — one segment is empty", form, raw)
		}
	}
	return parts, nil
}

/* ------------------------- shared attribute schemas ------------------------ */

// computedIDAttribute is the id every resource carries: server-assigned, stable
// across updates, and what `terraform import` addresses.
func computedIDAttribute(description string) schema.StringAttribute {
	return schema.StringAttribute{
		Computed:            true,
		MarkdownDescription: description,
		PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
	}
}

// singletonIDAttribute is the id of an organization singleton. It is the
// organization id, and it never changes for the life of the configuration.
func singletonIDAttribute(what string) schema.StringAttribute {
	return schema.StringAttribute{
		Computed: true,
		MarkdownDescription: "The organization id. " + what + " is an organization singleton, so this is " +
			"the only value it ever takes and it is what `terraform import` addresses.",
		PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
	}
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
