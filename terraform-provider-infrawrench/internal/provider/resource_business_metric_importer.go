package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*businessMetricImporterResource)(nil)
	_ resource.ResourceWithConfigure   = (*businessMetricImporterResource)(nil)
	_ resource.ResourceWithImportState = (*businessMetricImporterResource)(nil)
)

// NewBusinessMetricImporterResource constructs infrawrench_business_metric_importer.
func NewBusinessMetricImporterResource() resource.Resource {
	return &businessMetricImporterResource{}
}

type businessMetricImporterResource struct{ client *iw.Client }

type businessMetricImporterModel struct {
	ID           types.String `tfsdk:"id"`
	MetricID     types.String `tfsdk:"metric_id"`
	AccountID    types.String `tfsdk:"account_id"`
	Params       types.Map    `tfsdk:"params"`
	Schedule     types.String `tfsdk:"schedule"`
	BackfillDays types.Int64  `tfsdk:"backfill_days"`
	Timezone     types.String `tfsdk:"timezone"`
	Aggregation  types.String `tfsdk:"aggregation"`
	Enabled      types.Bool   `tfsdk:"enabled"`
}

var (
	businessMetricImportSchedules    = []string{"every_6_hours", "every_12_hours", "daily", "weekly"}
	businessMetricImportAggregations = []string{"sum", "average", "min", "max", "last", "count"}
)

func (r *businessMetricImporterResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_business_metric_importer"
}

func (r *businessMetricImporterResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A scheduled importer that pulls a business metric's daily values from a connected " +
			"account: a CloudWatch metric, a BigQuery, Snowflake, ClickHouse, PostgreSQL or MySQL query, or " +
			"Metronome usage or revenue. One per metric.\n\n" +
			"Each run restates the trailing `backfill_days` closed days (ending yesterday in `timezone`): a day " +
			"the source returns replaces what was stored for it, and a day it returns nothing for stays a gap. " +
			"Queries are read-only, with a row limit and a timeout. The imported values themselves are not " +
			"Terraform's to own; destroying this resource stops the import and keeps them.\n\n" +
			"`params` are the source plugin's form fields. List them per account with " +
			"`infrawrench unit-costs sources` or `GET /business-metrics/importer-sources`.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned importer id."),
			"metric_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Id of the `infrawrench_business_metric` to feed. Changing it moves the importer, " +
					"which replaces it. Import with the metric's id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"account_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The connected account to read from. Its plugin must declare a business-metric " +
					"source; changing account usually means changing `params` too.",
			},
			"params": schema.MapAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "The source's form values keyed by field, e.g. `{ namespace = \"AWS/ApplicationELB\", " +
					"metricName = \"RequestCount\", stat = \"Sum\" }` or `{ sql = file(\"customers.sql\") }`. A SQL field " +
					"must be one SELECT or WITH statement returning `day` and `value` (and optionally `label`); " +
					"`{{from}}`, `{{to}}`, `{{to_exclusive}}` and `{{timezone}}` are replaced with quoted literals.",
			},
			"schedule": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("daily"),
				MarkdownDescription: "How often it runs: `every_6_hours`, `every_12_hours`, `daily` (the default) or `weekly`.",
				Validators:          []validator.String{oneOfValidator(businessMetricImportSchedules...)},
			},
			"backfill_days": schema.Int64Attribute{
				Optional:            true,
				Computed:            true,
				Default:             int64default.StaticInt64(7),
				MarkdownDescription: "Trailing closed days each scheduled run restates, 1–730. Defaults to 7.",
				Validators:          []validator.Int64{between(1, 730)},
			},
			"timezone": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("UTC"),
				MarkdownDescription: "IANA timezone the days are counted in. Defaults to `UTC`.",
			},
			"aggregation": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("sum"),
				MarkdownDescription: "How several points the source returns for one day become its value: `sum` (the " +
					"default), `average`, `min`, `max`, `last` or `count`.",
				Validators: []validator.String{oneOfValidator(businessMetricImportAggregations...)},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Run on the schedule. `false` pauses it without losing the configuration.",
			},
		},
	}
}

func (r *businessMetricImporterResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *businessMetricImporterResource) put(ctx context.Context, plan businessMetricImporterModel) (*iw.BusinessMetricImporter, error) {
	params := map[string]string{}
	if !plan.Params.IsNull() && !plan.Params.IsUnknown() {
		for k, v := range plan.Params.Elements() {
			if s, ok := v.(types.String); ok {
				params[k] = s.ValueString()
			}
		}
	}
	return r.client.PutBusinessMetricImporter(ctx, plan.MetricID.ValueString(), iw.BusinessMetricImporterInput{
		AccountID:    plan.AccountID.ValueString(),
		Params:       params,
		Schedule:     plan.Schedule.ValueString(),
		BackfillDays: plan.BackfillDays.ValueInt64(),
		Timezone:     plan.Timezone.ValueString(),
		Aggregation:  plan.Aggregation.ValueString(),
		Enabled:      plan.Enabled.ValueBool(),
	})
}

func businessMetricImporterStateFrom(remote *iw.BusinessMetricImporter) businessMetricImporterModel {
	elements := map[string]string{}
	for k, v := range remote.Params {
		elements[k] = v
	}
	params, _ := types.MapValueFrom(context.Background(), types.StringType, elements)
	return businessMetricImporterModel{
		ID:           types.StringValue(remote.ID),
		MetricID:     types.StringValue(remote.MetricID),
		AccountID:    types.StringValue(remote.AccountID),
		Params:       params,
		Schedule:     types.StringValue(remote.Schedule),
		BackfillDays: types.Int64Value(remote.BackfillDays),
		Timezone:     types.StringValue(remote.Timezone),
		Aggregation:  types.StringValue(remote.Aggregation),
		Enabled:      types.BoolValue(remote.Enabled),
	}
}

func (r *businessMetricImporterResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan businessMetricImporterModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.put(ctx, plan)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create business metric importer", err.Error())
		return
	}
	state := businessMetricImporterStateFrom(created)
	// Keep the configured metric reference (an id or key) rather than the
	// resolved id, so a config that names the metric by key does not diff.
	state.MetricID = plan.MetricID
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *businessMetricImporterResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state businessMetricImporterModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetBusinessMetricImporter(ctx, state.MetricID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read business metric importer", err.Error())
		return
	}
	refreshed := businessMetricImporterStateFrom(remote)
	refreshed.MetricID = state.MetricID
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *businessMetricImporterResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan businessMetricImporterModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.put(ctx, plan)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Business metric no longer exists",
				"The metric this importer fed was deleted outside Terraform. The importer has been removed from state.")
			return
		}
		resp.Diagnostics.AddError("Unable to update business metric importer", err.Error())
		return
	}
	next := businessMetricImporterStateFrom(updated)
	next.MetricID = plan.MetricID
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete stops the import. The values it already wrote stay on the metric.
func (r *businessMetricImporterResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state businessMetricImporterModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteBusinessMetricImporter(ctx, state.MetricID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete business metric importer", err.Error())
	}
}

// ImportState takes the metric's id: the importer is addressed through its metric.
func (r *businessMetricImporterResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("metric_id"), req, resp)
}
