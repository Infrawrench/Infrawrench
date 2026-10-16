package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/float64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costReportAnomalyAlertResource)(nil)
	_ resource.ResourceWithConfigure   = (*costReportAnomalyAlertResource)(nil)
	_ resource.ResourceWithImportState = (*costReportAnomalyAlertResource)(nil)
)

// NewCostReportAnomalyAlertResource constructs the
// infrawrench_cost_report_anomaly_alert resource.
func NewCostReportAnomalyAlertResource() resource.Resource {
	return &costReportAnomalyAlertResource{}
}

type costReportAnomalyAlertResource struct{ client *iw.Client }

type costReportAnomalyAlertResourceModel struct {
	ID            types.String  `tfsdk:"id"`
	CostReportID  types.String  `tfsdk:"cost_report_id"`
	Enabled       types.Bool    `tfsdk:"enabled"`
	Sigmas        types.Float64 `tfsdk:"sigmas"`
	MinDeltaCents types.Int64   `tfsdk:"min_delta_cents"`
	Destination   types.List    `tfsdk:"destination"`
}

func (r *costReportAnomalyAlertResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_report_anomaly_alert"
}

func (r *costReportAnomalyAlertResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Anomaly alerts scoped to one `infrawrench_cost_report`: the report's filtered daily " +
			"total (its filters and saved filter, per currency) is judged against its trailing 28 days after " +
			"each cost collection, and a day that spikes is sent to this resource's own destinations.\n\n" +
			"It runs **beside** the organization's anomaly detection and `infrawrench_alert_routing`, not " +
			"instead of them: routing rules neither redirect, swallow nor hold these alerts for quiet hours, " +
			"because the report's owner chose these destinations for this scope. One per report; the " +
			"resource is addressed, and imported, by the report's id.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned alert id. Import addresses the resource by " +
				"`cost_report_id`, since a report has at most one alert."),
			"cost_report_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The report whose scope is watched. Changing it replaces the alert: the " +
					"alert is nested under the report, so there is nothing to move.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Defaults to `true`. A disabled alert keeps its settings and is not evaluated.",
			},
			"sigmas": schema.Float64Attribute{
				Optional: true,
				Computed: true,
				Default:  float64default.StaticFloat64(3),
				MarkdownDescription: "Standard deviations above the report's trailing 28-day mean that count " +
					"as a spike, 1–10. Lower is more sensitive. Defaults to 3, the organization-wide default.",
				Validators: []validatorFloat64{betweenFloat(1, 10)},
			},
			"min_delta_cents": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(1000),
				MarkdownDescription: "Least rise over the trailing mean before a day is reported, however many " +
					"standard deviations it is, in cents of the spend's **own** currency (not converted: you " +
					"state it for this report). 100–10000000; defaults to 1000.",
				Validators: []validatorInt64{between(100, 10000000)},
			},
		},
		Blocks: map[string]schema.Block{
			"destination": schema.ListNestedBlock{
				MarkdownDescription: "Where a finding goes, in the `infrawrench_alert_routing` destination " +
					"vocabulary (see that resource for each kind). At least one is required while `enabled`, " +
					"at most 20. Each destination must belong to this organization: a connected Slack channel, " +
					"a Teams webhook, a current member, an address the email policy allows.",
				Validators: []validatorList{sizeAtMost(20)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"kind": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "One of `" + joinBackticked(alertDestinationKind) + "`.",
							Validators:          []validatorString{oneOfValidator(alertDestinationKind...)},
						},
						"channel_id": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `slack`: the `id` of an `infrawrench_slack_channel`.",
						},
						"webhook_id": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `msteams`: the `id` of an `infrawrench_msteams_webhook`.",
						},
						"schedule_id": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `on-call`: the `id` of an `infrawrench_on_call_schedule`.",
						},
						"user_id": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `email-member`: a member's `id` from the `infrawrench_members` data source.",
						},
						"address": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `email-address`: a literal address, which must pass the organization's external-address policy.",
						},
						"account_id": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `paging-provider` and `provider-on-call`: a connected paging account's `id`.",
						},
						"target_id": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `paging-provider`: the provider's id for the target.",
						},
						"source_id": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `provider-on-call`: the provider's id for a schedule or escalation policy.",
						},
					},
				},
			},
		},
	}
}

func (r *costReportAnomalyAlertResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costReportAnomalyAlertResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costReportAnomalyAlertResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, plan, &resp.State, &resp.Diagnostics, "create")
}

func (r *costReportAnomalyAlertResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costReportAnomalyAlertResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCostReportAnomalyAlert(ctx, state.CostReportID.ValueString())
	if err != nil {
		// No alert on the report, or the report itself is gone: either way
		// there is nothing left for this resource to manage.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read report anomaly alert", err.Error())
		return
	}

	refreshed, diags := costReportAnomalyAlertStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costReportAnomalyAlertResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costReportAnomalyAlertResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, plan, &resp.State, &resp.Diagnostics, "update")
}

// put is create and update alike: the route is a whole replace keyed on the
// report, so the two differ only in the word in the error.
func (r *costReportAnomalyAlertResource) put(ctx context.Context, plan costReportAnomalyAlertResourceModel, state *tfsdk.State, diags *diag.Diagnostics, verb string) {
	destinations, d := alertDestinationsFrom(ctx, plan.Destination)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	saved, err := r.client.PutCostReportAnomalyAlert(ctx, plan.CostReportID.ValueString(), iw.CostReportAnomalyAlertInput{
		Enabled:       plan.Enabled.ValueBool(),
		Sigmas:        plan.Sigmas.ValueFloat64(),
		MinDeltaCents: plan.MinDeltaCents.ValueInt64(),
		Destinations:  destinations,
	})
	if err != nil {
		diags.AddError("Unable to "+verb+" report anomaly alert", err.Error())
		return
	}
	next, d := costReportAnomalyAlertStateFrom(ctx, saved)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

func (r *costReportAnomalyAlertResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costReportAnomalyAlertResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteCostReportAnomalyAlert(ctx, state.CostReportID.ValueString())
	if err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to delete report anomaly alert", err.Error())
	}
}

// ImportState takes the report id: a report has at most one alert, and the
// route is addressed by the report.
func (r *costReportAnomalyAlertResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("cost_report_id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func costReportAnomalyAlertStateFrom(ctx context.Context, remote *iw.CostReportAnomalyAlert) (costReportAnomalyAlertResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	destinations := make([]alertDestinationModel, 0, len(remote.Destinations))
	for _, dest := range remote.Destinations {
		destinations = append(destinations, alertDestinationModel{
			Kind:       types.StringValue(dest.Kind),
			ChannelID:  stringValue(dest.ChannelID),
			WebhookID:  stringValue(dest.WebhookID),
			ScheduleID: stringValue(dest.ScheduleID),
			UserID:     stringValue(dest.UserID),
			Address:    stringValue(dest.Address),
			AccountID:  stringValue(dest.AccountID),
			TargetID:   stringValue(dest.TargetID),
			SourceID:   stringValue(dest.SourceID),
		})
	}
	list, d := types.ListValueFrom(ctx, alertDestinationObjectType, destinations)
	diags.Append(d...)
	return costReportAnomalyAlertResourceModel{
		ID:            types.StringValue(remote.ID),
		CostReportID:  types.StringValue(remote.ReportID),
		Enabled:       types.BoolValue(remote.Enabled),
		Sigmas:        types.Float64Value(remote.Sigmas),
		MinDeltaCents: types.Int64Value(remote.MinDeltaCents),
		Destination:   list,
	}, diags
}
