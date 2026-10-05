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
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costReportResource)(nil)
	_ resource.ResourceWithConfigure   = (*costReportResource)(nil)
	_ resource.ResourceWithImportState = (*costReportResource)(nil)
)

// NewCostReportResource constructs the infrawrench_cost_report resource.
func NewCostReportResource() resource.Resource { return &costReportResource{} }

type costReportResource struct{ client *iw.Client }

// costReportChartTypes and costReportBinnings are the closed enums the graph
// config accepts.
//
// `hourly` is in the server's enum but deliberately not here: the server
// refuses to run an hourly report while no connected account stores hourly
// cost rows, and every provider's rows are daily today. Accepting it would let
// a plan succeed for a report that can only ever render an error.
var (
	costReportChartTypes = []string{"stacked_bar", "multi_bar", "line", "area", "pie", "donut", "table"}
	costReportBinnings   = []string{"daily", "weekly", "monthly", "quarterly", "cumulative"}
	costReportMeasures   = []string{"cost", "usage", "count"}

	// costReportGroupBy is the filter dimensions plus the explicit "no grouping"
	// option, which the server spells `none` rather than omitting the key.
	costReportGroupBy = append([]string{"none"}, costDimensions...)
)

type costReportResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	FolderID    types.String `tfsdk:"folder_id"`
	Config      types.Object `tfsdk:"config"`
}

type costReportConfigModel struct {
	ChartType             types.String `tfsdk:"chart_type"`
	Binning               types.String `tfsdk:"binning"`
	GroupBy               types.String `tfsdk:"group_by"`
	GroupByTagKey         types.String `tfsdk:"group_by_tag_key"`
	SavedFilterID         types.String `tfsdk:"saved_filter_id"`
	TopN                  types.Int64  `tfsdk:"top_n"`
	ComparePreviousPeriod types.Bool   `tfsdk:"compare_previous_period"`
	ShowForecast          types.Bool   `tfsdk:"show_forecast"`
	ScenarioModelID       types.String `tfsdk:"scenario_model_id"`
	CostBasis             types.String `tfsdk:"cost_basis"`
	UnitCostMetricID      types.String `tfsdk:"unit_cost_metric_id"`
	UnitCostMode          types.String `tfsdk:"unit_cost_mode"`
	UnitCostScale         types.Int64  `tfsdk:"unit_cost_scale"`
	UnitCostUsageUnit     types.String `tfsdk:"unit_cost_usage_unit"`
	UnitCostGroupByLabel  types.String `tfsdk:"unit_cost_group_by_label"`
	UnitCostLabelFilter   types.List   `tfsdk:"unit_cost_label_filter"`
	Adjusted              types.Bool   `tfsdk:"adjusted"`
	Measure               types.String `tfsdk:"measure"`
	UsageUnit             types.String `tfsdk:"usage_unit"`
	Cumulative            types.Bool   `tfsdk:"cumulative"`
	DateRange             types.Object `tfsdk:"date_range"`
	Filter                types.List   `tfsdk:"filter"`
}

type costReportDateRangeModel struct {
	Kind   types.String `tfsdk:"kind"`
	Preset types.String `tfsdk:"preset"`
	From   types.String `tfsdk:"from"`
	To     types.String `tfsdk:"to"`
}

// The nested objects are converted by hand rather than through reflection on
// the whole model, so their attribute types have to be spelled out once and
// reused by both directions of the mapping. Keeping the maps next to the models
// is what stops the two from drifting apart.
var costReportDateRangeAttrTypes = map[string]attr.Type{
	"kind":   types.StringType,
	"preset": types.StringType,
	"from":   types.StringType,
	"to":     types.StringType,
}

var costReportDateRangeObjectType = types.ObjectType{AttrTypes: costReportDateRangeAttrTypes}

var costReportConfigAttrTypes = map[string]attr.Type{
	"chart_type":               types.StringType,
	"binning":                  types.StringType,
	"group_by":                 types.StringType,
	"group_by_tag_key":         types.StringType,
	"saved_filter_id":          types.StringType,
	"top_n":                    types.Int64Type,
	"compare_previous_period":  types.BoolType,
	"show_forecast":            types.BoolType,
	"scenario_model_id":        types.StringType,
	"cost_basis":               types.StringType,
	"unit_cost_metric_id":      types.StringType,
	"unit_cost_mode":           types.StringType,
	"unit_cost_scale":          types.Int64Type,
	"unit_cost_usage_unit":     types.StringType,
	"unit_cost_group_by_label": types.StringType,
	"unit_cost_label_filter":   types.ListType{ElemType: unitCostLabelFilterObjectType},
	"adjusted":                 types.BoolType,
	"measure":                  types.StringType,
	"usage_unit":               types.StringType,
	"cumulative":               types.BoolType,
	"date_range":               costReportDateRangeObjectType,
	"filter":                   types.ListType{ElemType: costFilterObjectType},
}

// costReportObjectAsOptions is how every nested object in this resource is
// unpacked. Both permissive settings are deliberate: a block the practitioner
// did not write is null rather than absent, and during a plan a computed nested
// attribute is unknown, and neither case should fail the conversion outright.
var costReportObjectAsOptions = basetypes.ObjectAsOptions{
	UnhandledNullAsEmpty:    true,
	UnhandledUnknownAsEmpty: true,
}

func (r *costReportResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_report"
}

func (r *costReportResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved cost report: a named chart definition over your spend.\n\n" +
			"The `config` block is required in practice. Terraform's schema language has no way to " +
			"mark a single nested block as required, so leaving it out is a provider error at apply " +
			"time rather than a schema error at plan time — write it.\n\n" +
			"Where the report is pinned on dashboards is server state that this resource does not " +
			"expose; pin and unpin from the UI.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned report id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text shown under the report title. At most 2000 characters.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"folder_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of the `infrawrench_cost_report_folder` this report lives in. " +
					"Clearing the attribute moves the report back to the top level: the wire field is " +
					"sent as an explicit null rather than omitted, so an empty attribute really does " +
					"mean \"no folder\" rather than \"leave it where it is\".",
			},
		},
		Blocks: map[string]schema.Block{
			"config": schema.SingleNestedBlock{
				MarkdownDescription: "The chart definition. Required — see the resource description.",
				Attributes: map[string]schema.Attribute{
					"chart_type": schema.StringAttribute{
						Required:            true,
						MarkdownDescription: "How the series are drawn. One of `" + joinBackticked(costReportChartTypes) + "`.",
						Validators:          []validator.String{oneOfValidator(costReportChartTypes...)},
					},
					"binning": schema.StringAttribute{
						Required: true,
						MarkdownDescription: "Time bucketing of the x axis. One of `" +
							joinBackticked(costReportBinnings) + "`. Weeks start on Monday and quarters on " +
							"the first of January, April, July and October (UTC). `cumulative` is the older " +
							"spelling of `daily` with `cumulative = true`. Hourly bins are not accepted: " +
							"every provider's cost rows are stored per day, and the server refuses to run " +
							"an hourly report.",
						Validators: []validator.String{oneOfValidator(costReportBinnings...)},
					},
					"group_by": schema.StringAttribute{
						Required: true,
						MarkdownDescription: "Dimension that becomes one series per value. One of `" +
							joinBackticked(costReportGroupBy) + "`. Use `none` for a single total series.",
						Validators: []validator.String{oneOfValidator(costReportGroupBy...)},
					},
					"group_by_tag_key": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Which tag to group by: a provider tag key when `group_by` is `tag`, " +
							"or a virtual tag key when it is `virtual_tag`. Required for those two and " +
							"rejected otherwise.",
					},
					"saved_filter_id": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Id of an `infrawrench_saved_filter` applied on top of the " +
							"`filter` blocks below.",
					},
					"top_n": schema.Int64Attribute{
						Optional: true,
						Computed: true,
						Default:  int64default.StaticInt64(5),
						MarkdownDescription: "How many series to draw before the rest are folded into " +
							"an \"other\" series, 1–15. Defaults to `5`.",
						Validators: []validator.Int64{int64validator.Between(1, 15)},
					},
					"compare_previous_period": schema.BoolAttribute{
						Optional: true,
						Computed: true,
						Default:  booldefault.StaticBool(false),
						MarkdownDescription: "Overlay the equivalent preceding window so the chart shows " +
							"change rather than level. Defaults to `false`.",
					},
					"show_forecast": schema.BoolAttribute{
						Optional:            true,
						Computed:            true,
						Default:             booldefault.StaticBool(false),
						MarkdownDescription: "Extend the series with a projection to the end of the period. Defaults to `false`.",
					},
					"scenario_model_id": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Id of an `infrawrench_scenario_model` whose what-if " +
							"adjustments are layered onto the forecast.",
					},
					"cost_basis": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "`cash` to chart invoiced spend, `amortized` to spread " +
							"commitment fees across the term they cover, " + blendedBasisDescription,
						Validators: []validator.String{oneOfValidator("cash", "amortized", "blended")},
					},
					"unit_cost_metric_id": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Business metric to divide spend by, turning the chart into " +
							"cost per unit.",
					},
					"unit_cost_mode": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "The calculation: `unit_cost` (spend ÷ metric, the default when " +
							"`unit_cost_metric_id` is set), `margin` (revenue metrics only), `raw_metric` (the " +
							"metric beside spend), or `usage_unit_cost` (spend ÷ provider usage in " +
							"`unit_cost_usage_unit`, no metric needed).",
						Validators: []validator.String{
							oneOfValidator("unit_cost", "margin", "usage_unit_cost", "raw_metric"),
						},
					},
					"unit_cost_scale": schema.Int64Attribute{
						Optional: true,
						MarkdownDescription: "\"Per N units\" for a ratio, or the unit a raw metric is shown " +
							"in: `1`, `100`, `1000`, `1000000` or `1000000000`.",
						Validators: []validator.Int64{int64validator.OneOf(1, 100, 1000, 1000000, 1000000000)},
					},
					"unit_cost_usage_unit": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "With `unit_cost_mode = \"usage_unit_cost\"`: the provider usage " +
							"unit to divide by, as the cost data spells it (`GB-Mo`, `Hrs`).",
					},
					"unit_cost_group_by_label": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "One line per value of this business-metric label. In a ratio " +
							"mode the label must be mapped on the metric (`label_mapping`).",
					},
					"adjusted": schema.BoolAttribute{
						Optional: true,
						MarkdownDescription: "Apply billing rules to the figures, charting spend as " +
							"restated by your `infrawrench_billing_rule`s rather than as invoiced.",
					},
					"measure": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "What the Y axis sums. One of `" + joinBackticked(costReportMeasures) +
							"`; omitted is `cost`. `usage` sums the usage quantity providers report and " +
							"requires `usage_unit`. `count` is how many distinct values of `group_by` had " +
							"nonzero cost in each bin and requires a `group_by` other than `none`. Neither " +
							"`usage` nor `count` can be combined with `show_forecast`, `scenario_model_id`, " +
							"`adjusted` or `unit_cost_metric_id`, and `count` cannot be `cumulative`; the " +
							"server rejects those combinations.",
						Validators: []validator.String{oneOfValidator(costReportMeasures...)},
					},
					"usage_unit": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "The usage unit a `usage` measure sums, exactly as the " +
							"provider spells it (for example `Hrs` or `GB-Mo`), 1–64 characters. Required " +
							"when `measure` is `usage` and rejected otherwise.",
						Validators: []validator.String{stringvalidator.LengthBetween(1, 64)},
					},
					"cumulative": schema.BoolAttribute{
						Optional: true,
						MarkdownDescription: "Draw running totals from the start of the range instead of " +
							"per-bin values, at any bin size. Omitted is off.",
					},
				},
				Blocks: map[string]schema.Block{
					"date_range": schema.SingleNestedBlock{
						MarkdownDescription: "The window the report covers. Required, and a tagged union: " +
							"`kind` selects which of the other attributes apply, and the provider sends " +
							"only that branch because the server's schema is strict — an absolute range " +
							"carrying a stray `preset` key is rejected outright.",
						Attributes: map[string]schema.Attribute{
							"kind": schema.StringAttribute{
								Required: true,
								MarkdownDescription: "`relative` for a rolling window described by `preset`, " +
									"`absolute` for a fixed span described by `from` and `to`.",
								Validators: []validator.String{oneOfValidator("relative", "absolute")},
							},
							"preset": schema.StringAttribute{
								Optional: true,
								MarkdownDescription: "The rolling window, e.g. `last_30_days`. Required when " +
									"`kind` is `relative` and ignored otherwise.",
							},
							"from": schema.StringAttribute{
								Optional: true,
								MarkdownDescription: "Inclusive start date, `YYYY-MM-DD`. Required when " +
									"`kind` is `absolute` and ignored otherwise.",
							},
							"to": schema.StringAttribute{
								Optional: true,
								MarkdownDescription: "Inclusive end date, `YYYY-MM-DD`. Required when " +
									"`kind` is `absolute` and ignored otherwise.",
							},
						},
					},
					"filter": costFilterBlockSchema("Restricts the report to matching spend. Clauses are ANDed."),
					"unit_cost_label_filter": schema.ListNestedBlock{
						MarkdownDescription: "Keep only business-metric values carrying these labels, for a " +
							"unit-cost report. At most 10. In a ratio mode each label must be mapped on the metric.",
						Validators: []validator.List{sizeAtMost(10)},
						NestedObject: schema.NestedBlockObject{
							Attributes: map[string]schema.Attribute{
								"key": schema.StringAttribute{
									Required:            true,
									MarkdownDescription: "The label key, e.g. `customer`.",
								},
								"op": schema.StringAttribute{
									Required:            true,
									MarkdownDescription: "`in` keeps the listed values, `not_in` drops them.",
									Validators:          []validator.String{oneOfValidator("in", "not_in")},
								},
								"values": schema.ListAttribute{
									Required:            true,
									ElementType:         types.StringType,
									MarkdownDescription: "Label values to match. Must not be empty.",
								},
							},
						},
					},
				},
			},
		},
	}
}

func (r *costReportResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costReportResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costReportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costReportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCostReport(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create cost report", err.Error())
		return
	}

	state, diags := costReportStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *costReportResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCostReport(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform: drop it from state so the next plan
		// recreates it, rather than failing the refresh.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost report", err.Error())
		return
	}

	refreshed, diags := costReportStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costReportResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costReportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costReportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCostReport(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Cost report no longer exists",
				"The report was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update cost report", err.Error())
		return
	}

	next, diags := costReportStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costReportResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteCostReport(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete cost report", err.Error())
	}
}

func (r *costReportResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// costReportInputFrom maps Terraform configuration onto the write body.
//
// The two missing-block checks are the price of `config` and `date_range` being
// single nested blocks: the framework has no Required flag for those, so the
// only place the requirement can be enforced is here. Erroring with an explicit
// message beats sending a zero-valued config and letting the server answer with
// a schema violation the practitioner has to decode.
func costReportInputFrom(ctx context.Context, model costReportResourceModel) (iw.CostReportInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	if model.Config.IsNull() || model.Config.IsUnknown() {
		diags.AddAttributeError(path.Root("config"),
			"Missing config block",
			"infrawrench_cost_report requires a config block describing the chart. Terraform cannot "+
				"enforce that in the schema, so it is checked here.")
		return iw.CostReportInput{}, diags
	}

	var cfg costReportConfigModel
	diags.Append(model.Config.As(ctx, &cfg, costReportObjectAsOptions)...)
	if diags.HasError() {
		return iw.CostReportInput{}, diags
	}

	if cfg.DateRange.IsNull() || cfg.DateRange.IsUnknown() {
		diags.AddAttributeError(path.Root("config").AtName("date_range"),
			"Missing date_range block",
			"config requires a date_range block naming either a relative preset or an absolute span.")
		return iw.CostReportInput{}, diags
	}

	var dateRange costReportDateRangeModel
	diags.Append(cfg.DateRange.As(ctx, &dateRange, costReportObjectAsOptions)...)
	if diags.HasError() {
		return iw.CostReportInput{}, diags
	}

	filters, d := costFiltersFrom(ctx, cfg.Filter)
	diags.Append(d...)
	if diags.HasError() {
		return iw.CostReportInput{}, diags
	}
	labelFilters, d := unitCostLabelFiltersFrom(ctx, cfg.UnitCostLabelFilter)
	diags.Append(d...)
	if diags.HasError() {
		return iw.CostReportInput{}, diags
	}

	return iw.CostReportInput{
		Name:        model.Name.ValueString(),
		Description: stringPtr(model.Description),
		FolderID:    stringPtr(model.FolderID),
		Config: iw.CostGraphConfig{
			// The config document version is pinned by the provider, not by the
			// practitioner: it describes the shape this code knows how to write
			// and read, so exposing it as an attribute would only let a config
			// claim a shape the provider does not actually produce.
			Version:   1,
			ChartType: cfg.ChartType.ValueString(),
			Binning:   cfg.Binning.ValueString(),
			DateRange: iw.CostDateRange{
				Kind:   dateRange.Kind.ValueString(),
				Preset: stringPtr(dateRange.Preset),
				From:   stringPtr(dateRange.From),
				To:     stringPtr(dateRange.To),
			},
			GroupBy:               cfg.GroupBy.ValueString(),
			GroupByTagKey:         stringPtr(cfg.GroupByTagKey),
			Filters:               filters,
			SavedFilterID:         stringPtr(cfg.SavedFilterID),
			TopN:                  cfg.TopN.ValueInt64(),
			ComparePreviousPeriod: cfg.ComparePreviousPeriod.ValueBool(),
			ShowForecast:          cfg.ShowForecast.ValueBool(),
			ScenarioModelID:       stringPtr(cfg.ScenarioModelID),
			CostBasis:             stringPtr(cfg.CostBasis),
			UnitCostMetricID:      stringPtr(cfg.UnitCostMetricID),
			UnitCostMode:          stringPtr(cfg.UnitCostMode),
			UnitCostScale:         int64Ptr(cfg.UnitCostScale),
			UnitCostUsageUnit:     stringPtr(cfg.UnitCostUsageUnit),
			UnitCostGroupByLabel:  stringPtr(cfg.UnitCostGroupByLabel),
			UnitCostLabelFilters:  labelFilters,
			Adjusted:              boolPtr(cfg.Adjusted),
			Measure:               stringPtr(cfg.Measure),
			UsageUnit:             stringPtr(cfg.UsageUnit),
			Cumulative:            boolPtr(cfg.Cumulative),
		},
	}, diags
}

// costReportStateFrom maps a server report into Terraform state.
//
// `prior` is the plan (on write) or the previous state (on refresh). It covers
// the two graph-config fields the server omits from its response when they hold
// their implicit default (`costBasis` and `adjusted` are omitempty on the wire)
// where taking the response literally would write a null over a value the
// config spells out and fail the apply as an inconsistent result.
func costReportStateFrom(ctx context.Context, remote *iw.CostReport, prior costReportResourceModel) (costReportResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	var priorConfig costReportConfigModel
	if !prior.Config.IsNull() && !prior.Config.IsUnknown() {
		diags.Append(prior.Config.As(ctx, &priorConfig, costReportObjectAsOptions)...)
		if diags.HasError() {
			return costReportResourceModel{}, diags
		}
	}

	filters, d := costFiltersTo(ctx, remote.Config.Filters)
	diags.Append(d...)
	if diags.HasError() {
		return costReportResourceModel{}, diags
	}

	dateRange, d := types.ObjectValueFrom(ctx, costReportDateRangeAttrTypes, costReportDateRangeModel{
		Kind:   types.StringValue(remote.Config.DateRange.Kind),
		Preset: stringValue(remote.Config.DateRange.Preset),
		From:   stringValue(remote.Config.DateRange.From),
		To:     stringValue(remote.Config.DateRange.To),
	})
	diags.Append(d...)
	if diags.HasError() {
		return costReportResourceModel{}, diags
	}

	labelFilters, d := unitCostLabelFiltersTo(ctx, remote.Config.UnitCostLabelFilters)
	diags.Append(d...)
	if diags.HasError() {
		return costReportResourceModel{}, diags
	}

	costBasis := stringValue(remote.Config.CostBasis)
	if costBasis.IsNull() {
		costBasis = priorConfig.CostBasis
	}
	adjusted := boolValue(remote.Config.Adjusted)
	if adjusted.IsNull() {
		adjusted = priorConfig.Adjusted
	}
	// Same omitted-default rule for the display options: the server leaves out
	// `measure`, `usageUnit` and `cumulative` when they hold their defaults, so a
	// config spelling `measure = "cost"` or `cumulative = false` keeps its value.
	measure := stringValue(remote.Config.Measure)
	if measure.IsNull() {
		measure = priorConfig.Measure
	}
	usageUnit := stringValue(remote.Config.UsageUnit)
	if usageUnit.IsNull() {
		usageUnit = priorConfig.UsageUnit
	}
	cumulative := boolValue(remote.Config.Cumulative)
	if cumulative.IsNull() {
		cumulative = priorConfig.Cumulative
	}

	config, d := types.ObjectValueFrom(ctx, costReportConfigAttrTypes, costReportConfigModel{
		ChartType:             types.StringValue(remote.Config.ChartType),
		Binning:               types.StringValue(remote.Config.Binning),
		GroupBy:               types.StringValue(remote.Config.GroupBy),
		GroupByTagKey:         stringValue(remote.Config.GroupByTagKey),
		SavedFilterID:         stringValue(remote.Config.SavedFilterID),
		TopN:                  types.Int64Value(remote.Config.TopN),
		ComparePreviousPeriod: types.BoolValue(remote.Config.ComparePreviousPeriod),
		ShowForecast:          types.BoolValue(remote.Config.ShowForecast),
		ScenarioModelID:       stringValue(remote.Config.ScenarioModelID),
		CostBasis:             costBasis,
		UnitCostMetricID:      stringValue(remote.Config.UnitCostMetricID),
		UnitCostMode:          stringValue(remote.Config.UnitCostMode),
		UnitCostScale:         int64Value(remote.Config.UnitCostScale),
		UnitCostUsageUnit:     stringValue(remote.Config.UnitCostUsageUnit),
		UnitCostGroupByLabel:  stringValue(remote.Config.UnitCostGroupByLabel),
		UnitCostLabelFilter:   labelFilters,
		Adjusted:              adjusted,
		Measure:               measure,
		UsageUnit:             usageUnit,
		Cumulative:            cumulative,
		DateRange:             dateRange,
		Filter:                filters,
	})
	diags.Append(d...)
	if diags.HasError() {
		return costReportResourceModel{}, diags
	}

	return costReportResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Description: stringValue(remote.Description),
		FolderID:    stringValue(remote.FolderID),
		Config:      config,
	}, diags
}

/* ------------------------- unit-cost label filters ------------------------- */

type unitCostLabelFilterModel struct {
	Key    types.String `tfsdk:"key"`
	Op     types.String `tfsdk:"op"`
	Values types.List   `tfsdk:"values"`
}

var unitCostLabelFilterObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"key":    types.StringType,
	"op":     types.StringType,
	"values": types.ListType{ElemType: types.StringType},
}}

func unitCostLabelFiltersFrom(ctx context.Context, list types.List) ([]iw.UnitCostLabelFilter, diag.Diagnostics) {
	var diags diag.Diagnostics
	if list.IsNull() || list.IsUnknown() {
		return nil, diags
	}
	var models []unitCostLabelFilterModel
	diags.Append(list.ElementsAs(ctx, &models, false)...)
	out := make([]iw.UnitCostLabelFilter, 0, len(models))
	for _, m := range models {
		values, d := stringSlice(ctx, m.Values)
		diags.Append(d...)
		out = append(out, iw.UnitCostLabelFilter{Key: m.Key.ValueString(), Op: m.Op.ValueString(), Values: values})
	}
	return out, diags
}

// unitCostLabelFiltersTo returns an empty (not null) list when there are none:
// an omitted block plans as an empty list, and null would diff against it.
func unitCostLabelFiltersTo(ctx context.Context, filters []iw.UnitCostLabelFilter) (types.List, diag.Diagnostics) {
	var diags diag.Diagnostics
	models := make([]unitCostLabelFilterModel, 0, len(filters))
	for _, f := range filters {
		values, d := stringList(ctx, f.Values)
		diags.Append(d...)
		models = append(models, unitCostLabelFilterModel{
			Key:    types.StringValue(f.Key),
			Op:     types.StringValue(f.Op),
			Values: values,
		})
	}
	list, d := types.ListValueFrom(ctx, unitCostLabelFilterObjectType, models)
	diags.Append(d...)
	return list, diags
}
