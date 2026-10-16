package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*savingsViewResource)(nil)
	_ resource.ResourceWithConfigure   = (*savingsViewResource)(nil)
	_ resource.ResourceWithImportState = (*savingsViewResource)(nil)
)

// NewSavingsViewResource constructs the infrawrench_savings_view resource.
func NewSavingsViewResource() resource.Resource { return &savingsViewResource{} }

type savingsViewResource struct{ client *iw.Client }

type savingsViewResourceModel struct {
	ID                types.String  `tfsdk:"id"`
	Name              types.String  `tfsdk:"name"`
	Description       types.String  `tfsdk:"description"`
	Status            types.String  `tfsdk:"status"`
	Kinds             types.Set     `tfsdk:"kinds"`
	PluginIDs         types.Set     `tfsdk:"plugin_ids"`
	AccountIDs        types.Set     `tfsdk:"account_ids"`
	Regions           types.Set     `tfsdk:"regions"`
	MinMonthlySavings types.Float64 `tfsdk:"min_monthly_savings"`
	DetectedFrom      types.String  `tfsdk:"detected_from"`
	DetectedTo        types.String  `tfsdk:"detected_to"`
	Search            types.String  `tfsdk:"search"`
	SortField         types.String  `tfsdk:"sort_field"`
	SortDirection     types.String  `tfsdk:"sort_direction"`
	Tag               types.List    `tfsdk:"tag"`
}

type savingsViewTagModel struct {
	Key    types.String `tfsdk:"key"`
	Values types.Set    `tfsdk:"values"`
}

var savingsViewTagAttrTypes = map[string]attr.Type{
	"key":    types.StringType,
	"values": types.SetType{ElemType: types.StringType},
}

var isoDay = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (r *savingsViewResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_savings_view"
}

func stringSetAttribute(description string, extra ...validator.Set) schema.SetAttribute {
	return schema.SetAttribute{
		Optional:            true,
		ElementType:         types.StringType,
		MarkdownDescription: description,
		Validators:          append([]validator.Set{setvalidator.SizeBetween(1, 200)}, extra...),
	}
}

func (r *savingsViewResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved view over the savings findings list (Costs → Savings → Findings): " +
			"a status tab, a filter and a sort, opened from the view picker in the app, " +
			"`infrawrench savings findings --view <name>` in the CLI, or `?view=` on " +
			"`GET /savings/findings`.\n\n" +
			"Every filter attribute is optional and an unset one does not filter. The view's creator " +
			"owns it; share it with `infrawrench_object_sharing` (`object_type = \"savings_view\"`). " +
			"Names are unique per organization, case-insensitively.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned view id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters, unique in the organization.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Shown under the picker when the view is open. 1–2000 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 2000)},
			},
			"status": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("open"),
				MarkdownDescription: "Which status tab the view opens on: `open` (Ready for review and In " +
					"progress, the default), `ready`, `in_progress`, `completed`, `archived` or `all`.",
				Validators: []validator.String{
					oneOfValidator("open", "ready", "in_progress", "completed", "archived", "all"),
				},
			},
			"kinds": stringSetAttribute(
				"Only findings from these finders: `orphan` (orphaned or idle resources), `oversized` "+
					"(right-sizing), `extended_support`, `seat` (unused SaaS seats). 1–200 values.",
				setvalidator.ValueStringsAre(stringvalidator.OneOf("orphan", "oversized", "extended_support", "seat")),
			),
			"plugin_ids": stringSetAttribute(
				"Only findings from these providers, by plugin id (for example `aws`). 1–200 values.",
			),
			"account_ids": stringSetAttribute(
				"Only findings on these connected accounts, by id (`infrawrench_account` ids, or the " +
					"`infrawrench_accounts` data source). 1–200 values.",
			),
			"regions": stringSetAttribute("Only findings in these regions, as the provider names them. 1–200 values."),
			"min_monthly_savings": schema.Float64Attribute{
				Optional: true,
				MarkdownDescription: "Only findings saving at least this much per month, in each finding's own " +
					"currency. Must be greater than zero; findings with no price never pass.",
				Validators: []validator.Float64{positiveFloatAtMost(1e12)},
			},
			"detected_from": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Only findings first detected on or after this day, `YYYY-MM-DD` (UTC).",
				Validators: []validator.String{
					stringvalidator.RegexMatches(isoDay, "must be a YYYY-MM-DD date"),
				},
			},
			"detected_to": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Only findings first detected on or before this day, `YYYY-MM-DD` (UTC).",
				Validators: []validator.String{
					stringvalidator.RegexMatches(isoDay, "must be a YYYY-MM-DD date"),
				},
			},
			"search": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Case-insensitive text matched against the finding, resource and account names. 1–200 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 200)},
			},
			"sort_field": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("savings"),
				MarkdownDescription: "`savings` (the default), `detected`, `name` or `status_changed`. Findings " +
					"with no price always sort after priced ones.",
				Validators: []validator.String{oneOfValidator("savings", "detected", "name", "status_changed")},
			},
			"sort_direction": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("desc"),
				MarkdownDescription: "`desc` (the default) or `asc`.",
				Validators:          []validator.String{oneOfValidator("asc", "desc")},
			},
		},
		Blocks: map[string]schema.Block{
			"tag": schema.ListNestedBlock{
				MarkdownDescription: "Only findings whose resource carries this tag. Every block must match. " +
					"0–20 blocks.",
				Validators: []validator.List{sizeAtMost(20)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"key": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Tag key, matched case-insensitively. 1–200 characters.",
							Validators:          []validator.String{stringvalidator.LengthBetween(1, 200)},
						},
						"values": stringSetAttribute("Any of these values. Leave unset to match any value of the key. 1–200 values."),
					},
				},
			},
		},
	}
}

func (r *savingsViewResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *savingsViewResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan savingsViewResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := savingsViewInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateSavingsView(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create savings view", err.Error())
		return
	}
	state, diags := savingsViewStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *savingsViewResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state savingsViewResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetSavingsView(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform (or no longer shared with the key's owner):
		// drop it so the next plan recreates it.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read savings view", err.Error())
		return
	}
	refreshed, diags := savingsViewStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *savingsViewResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state savingsViewResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := savingsViewInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateSavingsView(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Savings view no longer exists",
				"The view was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update savings view", err.Error())
		return
	}
	next, diags := savingsViewStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *savingsViewResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state savingsViewResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteSavingsView(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete savings view", err.Error())
	}
}

func (r *savingsViewResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// savingsViewInputFrom maps configuration onto the write body. Unset filter
// attributes become absent keys (an empty slice is omitempty), which is how the
// server stores "no filter".
func savingsViewInputFrom(ctx context.Context, m savingsViewResourceModel) (iw.SavingsViewInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	var d diag.Diagnostics
	in := iw.SavingsViewInput{
		Name:        m.Name.ValueString(),
		Description: stringPtr(m.Description),
		Status:      m.Status.ValueString(),
		Sort:        iw.SavingsFindingSort{Field: m.SortField.ValueString(), Direction: m.SortDirection.ValueString()},
		Filter: iw.SavingsFindingFilter{
			MinMonthlySavings: float64Ptr(m.MinMonthlySavings),
			DetectedFrom:      stringPtr(m.DetectedFrom),
			DetectedTo:        stringPtr(m.DetectedTo),
			Search:            stringPtr(m.Search),
		},
	}
	in.Filter.Kinds, d = setStrings(ctx, m.Kinds)
	diags.Append(d...)
	in.Filter.PluginIDs, d = setStrings(ctx, m.PluginIDs)
	diags.Append(d...)
	in.Filter.AccountIDs, d = setStrings(ctx, m.AccountIDs)
	diags.Append(d...)
	in.Filter.Regions, d = setStrings(ctx, m.Regions)
	diags.Append(d...)

	if !m.Tag.IsNull() && !m.Tag.IsUnknown() {
		var tags []savingsViewTagModel
		diags.Append(m.Tag.ElementsAs(ctx, &tags, false)...)
		for _, t := range tags {
			values, d := setStrings(ctx, t.Values)
			diags.Append(d...)
			in.Filter.Tags = append(in.Filter.Tags, iw.SavingsFindingTagFilter{Key: t.Key.ValueString(), Values: values})
		}
	}
	return in, diags
}

// savingsViewStateFrom renders the server's view as state. The server never
// returns an empty list (it drops them on write) and the schema refuses an
// empty set in configuration, so an absent list maps to null without a diff.
func savingsViewStateFrom(ctx context.Context, v *iw.SavingsView) (savingsViewResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	var d diag.Diagnostics
	m := savingsViewResourceModel{
		ID:                types.StringValue(v.ID),
		Name:              types.StringValue(v.Name),
		Description:       stringValue(v.Description),
		Status:            types.StringValue(v.Status),
		MinMonthlySavings: float64Value(v.Filter.MinMonthlySavings),
		DetectedFrom:      stringValue(v.Filter.DetectedFrom),
		DetectedTo:        stringValue(v.Filter.DetectedTo),
		Search:            stringValue(v.Filter.Search),
		SortField:         types.StringValue(v.Sort.Field),
		SortDirection:     types.StringValue(v.Sort.Direction),
	}
	m.Kinds, d = nilStringSet(ctx, nilIfEmpty(v.Filter.Kinds))
	diags.Append(d...)
	m.PluginIDs, d = nilStringSet(ctx, nilIfEmpty(v.Filter.PluginIDs))
	diags.Append(d...)
	m.AccountIDs, d = nilStringSet(ctx, nilIfEmpty(v.Filter.AccountIDs))
	diags.Append(d...)
	m.Regions, d = nilStringSet(ctx, nilIfEmpty(v.Filter.Regions))
	diags.Append(d...)

	objType := types.ObjectType{AttrTypes: savingsViewTagAttrTypes}
	if len(v.Filter.Tags) == 0 {
		m.Tag = types.ListNull(objType)
	} else {
		tags := make([]savingsViewTagModel, 0, len(v.Filter.Tags))
		for _, t := range v.Filter.Tags {
			values, d := nilStringSet(ctx, nilIfEmpty(t.Values))
			diags.Append(d...)
			tags = append(tags, savingsViewTagModel{Key: types.StringValue(t.Key), Values: values})
		}
		m.Tag, d = types.ListValueFrom(ctx, objType, tags)
		diags.Append(d...)
	}
	return m, diags
}

func nilIfEmpty(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	return values
}
