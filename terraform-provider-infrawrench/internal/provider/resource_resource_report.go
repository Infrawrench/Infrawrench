package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*resourceReportResource)(nil)
	_ resource.ResourceWithConfigure   = (*resourceReportResource)(nil)
	_ resource.ResourceWithImportState = (*resourceReportResource)(nil)
)

// NewResourceReportResource constructs the infrawrench_resource_report resource.
func NewResourceReportResource() resource.Resource { return &resourceReportResource{} }

type resourceReportResource struct{ client *iw.Client }

var (
	resourceReportCostRangePresets = []string{"7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "6m", "12m"}
	resourceReportTagOps           = []string{"in", "not_in", "exists", "missing"}
	isoDayPattern                  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	// resourceReportColumnPattern is the column id grammar: a known family,
	// a colon, and a key. Core and cost keys are a closed set; the others are
	// the org's own field and tag keys.
	resourceReportColumnPattern = regexp.MustCompile(
		`^(core:(name|type|provider|account|region|status|created|external_id)|cost:(range|mtd|previous_month)|(field|tag|vtag):.+)$`)
)

const defaultResourceReportCostRange = "30d"

type resourceReportTypeModel struct {
	PluginID       types.String `tfsdk:"plugin_id"`
	ResourceTypeID types.String `tfsdk:"resource_type_id"`
}

type resourceReportTagFilterModel struct {
	Source types.String `tfsdk:"source"`
	Key    types.String `tfsdk:"key"`
	Op     types.String `tfsdk:"op"`
	Values types.List   `tfsdk:"values"`
}

type resourceReportResourceModel struct {
	ID              types.String                   `tfsdk:"id"`
	Name            types.String                   `tfsdk:"name"`
	Description     types.String                   `tfsdk:"description"`
	FolderID        types.String                   `tfsdk:"folder_id"`
	Columns         types.List                     `tfsdk:"columns"`
	SortColumn      types.String                   `tfsdk:"sort_column"`
	SortDirection   types.String                   `tfsdk:"sort_direction"`
	CostRangePreset types.String                   `tfsdk:"cost_range_preset"`
	CostRangeFrom   types.String                   `tfsdk:"cost_range_from"`
	CostRangeTo     types.String                   `tfsdk:"cost_range_to"`
	CostBasis       types.String                   `tfsdk:"cost_basis"`
	PageSize        types.Int64                    `tfsdk:"page_size"`
	PluginIDs       types.Set                      `tfsdk:"plugin_ids"`
	AccountIDs      types.Set                      `tfsdk:"account_ids"`
	Regions         types.Set                      `tfsdk:"regions"`
	Statuses        types.Set                      `tfsdk:"statuses"`
	NameContains    types.String                   `tfsdk:"name_contains"`
	CreatedFrom     types.String                   `tfsdk:"created_from"`
	CreatedTo       types.String                   `tfsdk:"created_to"`
	ResourceType    []resourceReportTypeModel      `tfsdk:"resource_type"`
	TagFilter       []resourceReportTagFilterModel `tfsdk:"tag_filter"`
}

func (r *resourceReportResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_resource_report"
}

func filterValueSet(what string) schema.SetAttribute {
	return schema.SetAttribute{
		Optional:            true,
		ElementType:         types.StringType,
		MarkdownDescription: what + " At most 200. Omitted or empty does not filter.",
		Validators:          []validator.Set{setSizeAtMost(200)},
	}
}

func (r *resourceReportResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved resource report: a table of synced resources across every connected " +
			"account, with the columns you pick and the cost of each resource.\n\n" +
			"Columns are column ids. `core:name`, `core:type`, `core:provider`, `core:account`, " +
			"`core:region`, `core:status`, `core:created` and `core:external_id` are on every " +
			"resource; `field:<key>` is a key of the resource's synced fields; `tag:<key>` is a " +
			"provider tag; `vtag:<key>` is a virtual tag, read from the resource's own cost rows " +
			"over the cost range; and `cost:range`, `cost:mtd` and `cost:previous_month` are spend " +
			"joined by the provider's resource id. The app's column picker shows the field and " +
			"tag keys your resources actually carry.\n\n" +
			"Filters are AND-ed; an omitted filter does not narrow the report. The report is filed " +
			"in the folder tree cost reports use, and shared with `infrawrench_object_sharing` " +
			"(`object_type = \"resource_report\"`).",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned report id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text shown under the report name. At most 2000 characters.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"folder_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of the `infrawrench_cost_report_folder` the report is filed in. " +
					"Clearing it moves the report back to the top level.",
			},
			"columns": schema.ListAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Shown columns, in display order: 1–40 column ids (see the " +
					"resource description). The first column links to the resource in the app.",
				Validators: []validator.List{
					sizeBetween(1, 40),
					listValueStringsMatch(resourceReportColumnPattern, "must be a column id such as core:name, field:instanceType, tag:team, vtag:team or cost:range"),
				},
			},
			"sort_column": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Column id to sort by; it need not be a shown column. Omitted " +
					"sorts by name.",
				Validators: []validator.String{
					stringvalidator.RegexMatches(resourceReportColumnPattern, "must be a column id"),
				},
			},
			"sort_direction": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "`asc` or `desc`, with `sort_column`. Omitted is `asc`.",
				Validators:          []validator.String{oneOfValidator("asc", "desc")},
			},
			"cost_range_preset": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The window `cost:range` covers and virtual tag values are read " +
					"over, as a rolling preset: one of `" + joinBackticked(resourceReportCostRangePresets) +
					"`. Omitted (with no `cost_range_from`) is `30d`. Month to date and the previous " +
					"month are always calendar months.",
				Validators: []validator.String{oneOfValidator(resourceReportCostRangePresets...)},
			},
			"cost_range_from": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "A fixed window instead of a preset: inclusive start day, " +
					"`YYYY-MM-DD`. Set together with `cost_range_to`, and not with `cost_range_preset`.",
				Validators: []validator.String{stringvalidator.RegexMatches(isoDayPattern, "must be YYYY-MM-DD")},
			},
			"cost_range_to": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Inclusive end day of a fixed window, `YYYY-MM-DD`.",
				Validators:          []validator.String{stringvalidator.RegexMatches(isoDayPattern, "must be YYYY-MM-DD")},
			},
			"cost_basis": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("cash"),
				MarkdownDescription: "`cash` for invoiced spend, `amortized` to spread commitment fees " +
					"across the term they cover, " + blendedBasisDescription + " Defaults to `cash`.",
				Validators: []validator.String{oneOfValidator("cash", "amortized", "blended")},
			},
			"page_size": schema.Int64Attribute{
				Optional:            true,
				Computed:            true,
				Default:             int64default.StaticInt64(50),
				MarkdownDescription: "Rows per page in the app, 1–500. Defaults to `50`.",
				Validators:          []validator.Int64{between(1, 500)},
			},
			"plugin_ids":  filterValueSet("Providers (plugin ids, e.g. `aws`) to include."),
			"account_ids": filterValueSet("Connected account ids to include (see the `infrawrench_accounts` data source)."),
			"regions":     filterValueSet("Regions to include, matched exactly as synced."),
			"statuses":    filterValueSet("Statuses to include, matched ignoring case."),
			"name_contains": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Keep resources whose name contains this text, ignoring case. At most 200 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 200)},
			},
			"created_from": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Keep resources created on or after this UTC day, `YYYY-MM-DD`. " +
					"Created is the provider's creation time when the resource reports one, " +
					"otherwise when Infrawrench first synced it.",
				Validators: []validator.String{stringvalidator.RegexMatches(isoDayPattern, "must be YYYY-MM-DD")},
			},
			"created_to": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Keep resources created on or before this UTC day, `YYYY-MM-DD`.",
				Validators:          []validator.String{stringvalidator.RegexMatches(isoDayPattern, "must be YYYY-MM-DD")},
			},
		},
		Blocks: map[string]schema.Block{
			"resource_type": schema.ListNestedBlock{
				MarkdownDescription: "A resource type to include, with its plugin since type ids " +
					"repeat across plugins. At most 200. None does not filter.",
				Validators: []validator.List{sizeAtMost(200)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"plugin_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "The plugin, e.g. `aws`.",
						},
						"resource_type_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "The type within it, e.g. `ec2-instance`.",
						},
					},
				},
			},
			"tag_filter": schema.ListNestedBlock{
				MarkdownDescription: "A tag condition. At most 10, AND-ed.",
				Validators:          []validator.List{sizeAtMost(10)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"source": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "`tag` for a provider tag on the resource, `virtual_tag` " +
								"for a virtual tag read from its cost rows.",
							Validators: []validator.String{oneOfValidator("tag", "virtual_tag")},
						},
						"key": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "The tag key, 1–256 characters.",
							Validators:          []validator.String{stringvalidator.LengthBetween(1, 256)},
						},
						"op": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "One of `" + joinBackticked(resourceReportTagOps) + "`. " +
								"`in` and `not_in` need `values`; `exists` and `missing` take none.",
							Validators: []validator.String{oneOfValidator(resourceReportTagOps...)},
						},
						"values": schema.ListAttribute{
							Optional:            true,
							ElementType:         types.StringType,
							MarkdownDescription: "Values to match, at most 200.",
							Validators:          []validator.List{sizeAtMost(200)},
						},
					},
				},
			},
		},
	}
}

func (r *resourceReportResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *resourceReportResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan resourceReportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := resourceReportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateResourceReport(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create resource report", err.Error())
		return
	}
	state, diags := resourceReportStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *resourceReportResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state resourceReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetResourceReport(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read resource report", err.Error())
		return
	}
	refreshed, diags := resourceReportStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *resourceReportResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state resourceReportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := resourceReportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateResourceReport(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Resource report no longer exists",
				"The report was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update resource report", err.Error())
		return
	}
	next, diags := resourceReportStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *resourceReportResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state resourceReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteResourceReport(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete resource report", err.Error())
	}
}

func (r *resourceReportResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// setOrNull renders a server list as a set, null when the server has none and
// the prior value was null: an omitted filter must not plan as `[]`.
func setOrNull(ctx context.Context, values []string, prior types.Set) (types.Set, diag.Diagnostics) {
	if len(values) == 0 && (prior.IsNull() || prior.IsUnknown()) {
		return types.SetNull(types.StringType), nil
	}
	if values == nil {
		values = []string{}
	}
	return types.SetValueFrom(ctx, types.StringType, values)
}

// resourceReportInputFrom maps configuration onto the write body. The cost
// range is a tagged union on the wire; the provider flattens it into three
// attributes and checks here that only one branch is set.
func resourceReportInputFrom(ctx context.Context, m resourceReportResourceModel) (iw.ResourceReportInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	columns, d := stringSlice(ctx, m.Columns)
	diags.Append(d...)

	costRange := iw.CostDateRange{Kind: "relative"}
	hasFrom := !m.CostRangeFrom.IsNull() && m.CostRangeFrom.ValueString() != ""
	hasTo := !m.CostRangeTo.IsNull() && m.CostRangeTo.ValueString() != ""
	switch {
	case hasFrom || hasTo:
		if !(hasFrom && hasTo) {
			diags.AddAttributeError(path.Root("cost_range_from"), "Incomplete cost range",
				"Set both cost_range_from and cost_range_to for a fixed window, or neither.")
		}
		if !m.CostRangePreset.IsNull() {
			diags.AddAttributeError(path.Root("cost_range_preset"), "Conflicting cost range",
				"Set either cost_range_preset or cost_range_from/cost_range_to, not both.")
		}
		costRange = iw.CostDateRange{Kind: "absolute", From: stringPtr(m.CostRangeFrom), To: stringPtr(m.CostRangeTo)}
	default:
		preset := defaultResourceReportCostRange
		if !m.CostRangePreset.IsNull() && !m.CostRangePreset.IsUnknown() {
			preset = m.CostRangePreset.ValueString()
		}
		costRange.Preset = &preset
	}

	var sort *iw.ResourceReportSort
	if !m.SortColumn.IsNull() && m.SortColumn.ValueString() != "" {
		direction := "asc"
		if !m.SortDirection.IsNull() && !m.SortDirection.IsUnknown() {
			direction = m.SortDirection.ValueString()
		}
		sort = &iw.ResourceReportSort{Column: m.SortColumn.ValueString(), Direction: direction}
	}

	pluginIDs, d := setStrings(ctx, m.PluginIDs)
	diags.Append(d...)
	accountIDs, d := setStrings(ctx, m.AccountIDs)
	diags.Append(d...)
	regions, d := setStrings(ctx, m.Regions)
	diags.Append(d...)
	statuses, d := setStrings(ctx, m.Statuses)
	diags.Append(d...)

	types_ := make([]iw.ResourceReportTypeRef, 0, len(m.ResourceType))
	for _, t := range m.ResourceType {
		types_ = append(types_, iw.ResourceReportTypeRef{
			PluginID:       t.PluginID.ValueString(),
			ResourceTypeID: t.ResourceTypeID.ValueString(),
		})
	}
	tags := make([]iw.ResourceReportTagFilter, 0, len(m.TagFilter))
	for _, t := range m.TagFilter {
		values, d := stringSlice(ctx, t.Values)
		diags.Append(d...)
		tags = append(tags, iw.ResourceReportTagFilter{
			Source: t.Source.ValueString(),
			Key:    t.Key.ValueString(),
			Op:     t.Op.ValueString(),
			Values: values,
		})
	}

	pageSize := int64(50)
	if !m.PageSize.IsNull() && !m.PageSize.IsUnknown() {
		pageSize = m.PageSize.ValueInt64()
	}
	costBasis := "cash"
	if !m.CostBasis.IsNull() && !m.CostBasis.IsUnknown() {
		costBasis = m.CostBasis.ValueString()
	}

	return iw.ResourceReportInput{
		Name:        m.Name.ValueString(),
		Description: stringPtr(m.Description),
		FolderID:    stringPtr(m.FolderID),
		Config: iw.ResourceReportConfig{
			// Pinned by the provider: the shape this code reads and writes.
			Version: 1,
			Filters: iw.ResourceReportFilters{
				PluginIDs:     pluginIDs,
				AccountIDs:    accountIDs,
				ResourceTypes: types_,
				Regions:       regions,
				Statuses:      statuses,
				Tags:          tags,
				NameContains:  stringPtr(m.NameContains),
				CreatedFrom:   stringPtr(m.CreatedFrom),
				CreatedTo:     stringPtr(m.CreatedTo),
			},
			Columns:   columns,
			Sort:      sort,
			CostRange: costRange,
			CostBasis: costBasis,
			PageSize:  pageSize,
		},
	}, diags
}

// resourceReportStateFrom maps a server report into state. `prior` is the plan
// (on write) or the previous state (on refresh); it decides between null and
// the server's default where the configuration left an attribute out.
func resourceReportStateFrom(ctx context.Context, remote *iw.ResourceReport, prior resourceReportResourceModel) (resourceReportResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	cfg := remote.Config

	columns, d := stringList(ctx, cfg.Columns)
	diags.Append(d...)

	out := resourceReportResourceModel{
		ID:           types.StringValue(remote.ID),
		Name:         types.StringValue(remote.Name),
		Description:  stringValue(remote.Description),
		FolderID:     stringValue(remote.FolderID),
		Columns:      columns,
		CostBasis:    types.StringValue(cfg.CostBasis),
		PageSize:     types.Int64Value(cfg.PageSize),
		NameContains: stringValue(cfg.Filters.NameContains),
		CreatedFrom:  stringValue(cfg.Filters.CreatedFrom),
		CreatedTo:    stringValue(cfg.Filters.CreatedTo),
	}

	out.SortColumn = types.StringNull()
	out.SortDirection = types.StringNull()
	if cfg.Sort != nil {
		out.SortColumn = types.StringValue(cfg.Sort.Column)
		out.SortDirection = types.StringValue(cfg.Sort.Direction)
		// "asc" is what an omitted direction is sent as.
		if cfg.Sort.Direction == "asc" && prior.SortDirection.IsNull() {
			out.SortDirection = types.StringNull()
		}
	}

	out.CostRangePreset = types.StringNull()
	out.CostRangeFrom = types.StringNull()
	out.CostRangeTo = types.StringNull()
	if cfg.CostRange.Kind == "absolute" {
		out.CostRangeFrom = stringValue(cfg.CostRange.From)
		out.CostRangeTo = stringValue(cfg.CostRange.To)
	} else if cfg.CostRange.Preset != nil {
		out.CostRangePreset = types.StringValue(*cfg.CostRange.Preset)
		// The default preset stays null when the configuration left it out.
		if *cfg.CostRange.Preset == defaultResourceReportCostRange && prior.CostRangePreset.IsNull() {
			out.CostRangePreset = types.StringNull()
		}
	}

	out.PluginIDs, d = setOrNull(ctx, cfg.Filters.PluginIDs, prior.PluginIDs)
	diags.Append(d...)
	out.AccountIDs, d = setOrNull(ctx, cfg.Filters.AccountIDs, prior.AccountIDs)
	diags.Append(d...)
	out.Regions, d = setOrNull(ctx, cfg.Filters.Regions, prior.Regions)
	diags.Append(d...)
	out.Statuses, d = setOrNull(ctx, cfg.Filters.Statuses, prior.Statuses)
	diags.Append(d...)

	out.ResourceType = make([]resourceReportTypeModel, 0, len(cfg.Filters.ResourceTypes))
	for _, t := range cfg.Filters.ResourceTypes {
		out.ResourceType = append(out.ResourceType, resourceReportTypeModel{
			PluginID:       types.StringValue(t.PluginID),
			ResourceTypeID: types.StringValue(t.ResourceTypeID),
		})
	}
	out.TagFilter = make([]resourceReportTagFilterModel, 0, len(cfg.Filters.Tags))
	for i, t := range cfg.Filters.Tags {
		var values types.List
		// `exists` / `missing` carry no values: keep an omitted attribute null.
		priorNull := i < len(prior.TagFilter) && prior.TagFilter[i].Values.IsNull()
		if len(t.Values) == 0 && (priorNull || i >= len(prior.TagFilter)) {
			values = types.ListNull(types.StringType)
		} else {
			values, d = stringList(ctx, t.Values)
			diags.Append(d...)
		}
		out.TagFilter = append(out.TagFilter, resourceReportTagFilterModel{
			Source: types.StringValue(t.Source),
			Key:    types.StringValue(t.Key),
			Op:     types.StringValue(t.Op),
			Values: values,
		})
	}
	return out, diags
}
