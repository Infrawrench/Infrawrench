package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costForecastResource)(nil)
	_ resource.ResourceWithConfigure   = (*costForecastResource)(nil)
	_ resource.ResourceWithImportState = (*costForecastResource)(nil)
)

// NewCostForecastResource constructs the infrawrench_cost_forecast resource.
func NewCostForecastResource() resource.Resource { return &costForecastResource{} }

type costForecastResource struct{ client *iw.Client }

type costForecastResourceModel struct {
	ID               types.String `tfsdk:"id"`
	CostReportID     types.String `tfsdk:"cost_report_id"`
	Name             types.String `tfsdk:"name"`
	Description      types.String `tfsdk:"description"`
	ScenarioModelIDs types.List   `tfsdk:"scenario_model_ids"`
	DriverMetricID   types.String `tfsdk:"driver_metric_id"`
	IsDefault        types.Bool   `tfsdk:"is_default"`
}

func (r *costForecastResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_forecast"
}

func (r *costForecastResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A named forecast on an `infrawrench_cost_report`: the plan you compare the " +
			"automatic trend forecast against.\n\n" +
			"A forecast starts from a baseline, either the report's spend trend or, when " +
			"`driver_metric_id` is set, the report's projected spend per unit of a business metric " +
			"multiplied by that metric's forecasted values. Scenario models are then applied in the " +
			"order listed, each to the line the previous ones produced. Every forecast carries a " +
			"low/expected/high band from the least-squares prediction interval; scenario models shift " +
			"the band rather than widening it.\n\n" +
			"At least one of `scenario_model_ids` and `driver_metric_id` must be set: without either " +
			"the forecast is the automatic one, which every report already has. A scenario model a " +
			"forecast names cannot be deleted until the forecast stops naming it.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned forecast id. Import addresses it as " +
				"`<cost_report_id>/<id>`, because the forecast's own id is not enough to build its URL."),
			"cost_report_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The report whose scope the forecast projects. Changing it replaces the " +
					"forecast: the route is nested under the report, so there is nothing to move.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Shown in the report's Forecasts view, 1–120 characters, unique on the report.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text, at most 500 characters.",
				Validators:          []validatorString{stringvalidator.LengthAtMost(500)},
			},
			"scenario_model_ids": schema.ListAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     listdefault.StaticValue(types.ListValueMust(types.StringType, []attr.Value{})),
				MarkdownDescription: "`infrawrench_scenario_model` ids, in priority order (first applied first), " +
					"at most 10, each at most once. Order matters only for org-wide percentage changes: a " +
					"later model's percentage also scales the amounts an earlier one added.",
				Validators: []validatorList{sizeAtMost(10)},
			},
			"driver_metric_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "An `infrawrench_business_metric` id. When set, the baseline is the report's " +
					"projected spend per unit of the metric times the metric's forecasted values; days with " +
					"no forecasted value fall back to the trend. Forecasted values are data, entered in the " +
					"app, by CSV, or over the API, and are not managed here.",
			},
			"is_default": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "Make this the report's default forecast: the one its Forecasts view opens " +
					"on and the forecasted-costs read returns. Setting it clears any other default on the " +
					"report, so set it on at most one forecast per report or the two will take turns on " +
					"every apply. Defaults to `false`.",
			},
		},
	}
}

func (r *costForecastResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costForecastResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costForecastResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := costForecastInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateCostForecast(ctx, plan.CostReportID.ValueString(), input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create cost forecast", err.Error())
		return
	}
	state, diags := costForecastStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *costForecastResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costForecastResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetCostForecast(ctx, state.CostReportID.ValueString(), state.ID.ValueString())
	if err != nil {
		// A deleted report takes its forecasts with it and 404s the listing;
		// both shapes mean this forecast needs recreating.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost forecast", err.Error())
		return
	}
	refreshed, diags := costForecastStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costForecastResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costForecastResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costForecastResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := costForecastInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateCostForecast(ctx, state.CostReportID.ValueString(), state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Cost forecast no longer exists",
				"The forecast was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update cost forecast", err.Error())
		return
	}
	next, diags := costForecastStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costForecastResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costForecastResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteCostForecast(ctx, state.CostReportID.ValueString(), state.ID.ValueString())
	if err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to delete cost forecast", err.Error())
	}
}

// ImportState takes a composite "<cost_report_id>/<forecast_id>" address: the
// route is nested under the report, so the forecast id alone builds no URL.
func (r *costForecastResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, err := splitImportID(req.ID, 2, "<cost_report_id>/<forecast_id>")
	if err != nil {
		resp.Diagnostics.AddError("Invalid import id", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("cost_report_id"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), parts[1])...)
}

/* -------------------------------- mapping --------------------------------- */

func costForecastInputFrom(ctx context.Context, model costForecastResourceModel) (iw.CostForecastInput, diag.Diagnostics) {
	ids, diags := stringSlice(ctx, model.ScenarioModelIDs)
	return iw.CostForecastInput{
		Name:             model.Name.ValueString(),
		Description:      stringPtr(model.Description),
		ScenarioModelIDs: ids,
		DriverMetricID:   stringPtr(model.DriverMetricID),
		IsDefault:        model.IsDefault.ValueBool(),
	}, diags
}

func costForecastStateFrom(ctx context.Context, remote *iw.CostForecast) (costForecastResourceModel, diag.Diagnostics) {
	ids, diags := stringList(ctx, remote.ScenarioModelIDs)
	return costForecastResourceModel{
		ID:               types.StringValue(remote.ID),
		CostReportID:     types.StringValue(remote.ReportID),
		Name:             types.StringValue(remote.Name),
		Description:      stringValue(remote.Description),
		ScenarioModelIDs: ids,
		DriverMetricID:   stringValue(remote.DriverMetricID),
		IsDefault:        types.BoolValue(remote.IsDefault),
	}, diags
}
