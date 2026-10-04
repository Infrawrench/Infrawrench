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
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
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

// nilStringSet is nilStringList for a set-typed attribute: used where order
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

// int64ListOrNull is nilStringList for numbers: nil becomes null, `[]` stays
// `[]`. Used for quiet hours' weekday list, where the empty list means "every
// day" and a configuration that writes it out must read back unchanged.
func int64ListOrNull(ctx context.Context, values []int64) (types.List, diag.Diagnostics) {
	if values == nil {
		return types.ListNull(types.Int64Type), nil
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
// the two things Create and Update differ in, which response's diagnostics to
// append to, and which response's state to set. These aliases keep that
// signature readable without every file importing tfsdk.

type diagnostics = diag.Diagnostics

type tfState = tfsdk.State

/* ------------------------------ import helpers ----------------------------- */

// importOrgSingleton is ImportState for the resources that are one row per
// organization: tag policy, the alert settings, currency, the issue-tracker
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

/* ---------------------------- email recipients ----------------------------- */
//
// Budgets, cost change alerts, anomaly settings and efficiency settings each
// carry an optional `emailRecipients` object, with one rule that shapes the
// mapping: on a write, an absent object leaves the stored list as it is, and
// empty arrays clear it. Both attributes are Optional+Computed sets with
// UseStateForUnknown, so:
//
//   - On create, an attribute left out of configuration is unknown. If both are
//     unknown the object is omitted and the server keeps its default (nobody).
//     If either is configured, both are sent and the unconfigured one goes as
//     `[]`, because the wire requires both keys and a new object has no list
//     to preserve.
//   - On update, an attribute left out of configuration plans as its prior
//     state, so the write echoes back what the server already holds. Removing
//     the attribute from configuration therefore leaves the list alone; write
//     `[]` to clear it. That matches the API's own reading of an omission.
//
// Either way the plan never shows a diff Terraform cannot resolve, and a list
// edited in the UI is reported as drift rather than silently overwritten.

// emailRecipientMaxMembers and emailRecipientMaxAddresses are the API's caps.
const (
	emailRecipientMaxMembers   = 50
	emailRecipientMaxAddresses = 20
)

// emailRecipientAttributes returns the `email_member_ids` and
// `email_addresses` attributes. `what` names the object for the descriptions,
// e.g. "the budget crosses a threshold".
func emailRecipientAttributes(what string) map[string]schema.Attribute {
	common := " Emailed **in addition to** whatever the organization's `infrawrench_alert_routing` rules " +
		"decide, whether or not a rule matched, and never held by quiet hours.\n\n" +
		"Optional and computed: leave it out and the list is managed elsewhere (removing it from " +
		"configuration leaves the stored list unchanged); set `[]` to clear it."
	return map[string]schema.Attribute{
		"email_member_ids": schema.SetAttribute{
			Optional:    true,
			Computed:    true,
			ElementType: types.StringType,
			MarkdownDescription: "Organization members to email when " + what + ", by user id from the " +
				"`infrawrench_members` data source. At most 50. The member's current login address is read " +
				"when the alert is sent, so an address change follows them and a member who leaves stops " +
				"receiving." + common,
			Validators:    []validatorSet{setSizeAtMost(emailRecipientMaxMembers)},
			PlanModifiers: []planmodifier.Set{setplanmodifier.UseStateForUnknown()},
		},
		"email_addresses": schema.SetAttribute{
			Optional:    true,
			Computed:    true,
			ElementType: types.StringType,
			MarkdownDescription: "Extra addresses to email when " + what + ": a `finance@` alias, or " +
				"someone without a login. At most 20. Each must pass the organization's external-address " +
				"policy (`infrawrench_alert_email_settings`), checked when saved and again when sent." + common,
			Validators:    []validatorSet{setSizeAtMost(emailRecipientMaxAddresses)},
			PlanModifiers: []planmodifier.Set{setplanmodifier.UseStateForUnknown()},
		},
	}
}

// withEmailRecipientAttributes merges the two recipient attributes into a
// resource's attribute map.
func withEmailRecipientAttributes(attrs map[string]schema.Attribute, what string) map[string]schema.Attribute {
	for name, attribute := range emailRecipientAttributes(what) {
		attrs[name] = attribute
	}
	return attrs
}

// emailRecipientsFrom builds the wire object from the two planned sets, or nil
// to leave the stored list unchanged. See the section comment for the rules.
func emailRecipientsFrom(ctx context.Context, memberIDs, addresses types.Set) (*iw.AlertEmailRecipients, diag.Diagnostics) {
	var diags diag.Diagnostics
	if memberIDs.IsUnknown() && addresses.IsUnknown() {
		return nil, diags
	}
	out := &iw.AlertEmailRecipients{UserIDs: []string{}, Addresses: []string{}}
	if !memberIDs.IsNull() && !memberIDs.IsUnknown() {
		diags.Append(memberIDs.ElementsAs(ctx, &out.UserIDs, false)...)
	}
	if !addresses.IsNull() && !addresses.IsUnknown() {
		diags.Append(addresses.ElementsAs(ctx, &out.Addresses, false)...)
	}
	if out.UserIDs == nil {
		out.UserIDs = []string{}
	}
	if out.Addresses == nil {
		out.Addresses = []string{}
	}
	return out, diags
}

// clearedEmailRecipients is what a singleton's destroy writes: the shipped
// default is nobody.
func clearedEmailRecipients() *iw.AlertEmailRecipients {
	return &iw.AlertEmailRecipients{UserIDs: []string{}, Addresses: []string{}}
}

// emailRecipientsTo renders the stored lists into the two sets.
//
// The API always returns the object, so the fallback only matters against a
// server older than email alerting: there it keeps the prior known value (or
// an empty set in place of an unknown) so an apply is never inconsistent.
func emailRecipientsTo(ctx context.Context, remote *iw.AlertEmailRecipients, priorMemberIDs, priorAddresses types.Set) (types.Set, types.Set, diag.Diagnostics) {
	var diags diag.Diagnostics
	if remote == nil {
		empty := types.SetValueMust(types.StringType, []attr.Value{})
		if priorMemberIDs.IsUnknown() || priorMemberIDs.IsNull() {
			priorMemberIDs = empty
		}
		if priorAddresses.IsUnknown() || priorAddresses.IsNull() {
			priorAddresses = empty
		}
		return priorMemberIDs, priorAddresses, diags
	}
	userIDs := remote.UserIDs
	if userIDs == nil {
		userIDs = []string{}
	}
	addresses := remote.Addresses
	if addresses == nil {
		addresses = []string{}
	}
	members, d := types.SetValueFrom(ctx, types.StringType, userIDs)
	diags.Append(d...)
	extra, d := types.SetValueFrom(ctx, types.StringType, addresses)
	diags.Append(d...)
	return members, extra, diags
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
	"virtual_tag",
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
					Optional: true,
					MarkdownDescription: "Tag key, required when `dimension` is `tag` (a provider tag key) or " +
						"`virtual_tag` (a virtual tag key, see `infrawrench_virtual_tag`) and rejected otherwise.",
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
