package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*costAlertResource)(nil)
	_ resource.ResourceWithConfigure      = (*costAlertResource)(nil)
	_ resource.ResourceWithImportState    = (*costAlertResource)(nil)
	_ resource.ResourceWithValidateConfig = (*costAlertResource)(nil)
)

// NewCostAlertResource constructs the infrawrench_cost_alert resource.
func NewCostAlertResource() resource.Resource { return &costAlertResource{} }

type costAlertResource struct{ client *iw.Client }

// costAlertCadences and costAlertDirections are the closed enums the endpoint
// accepts.
var (
	costAlertCadences   = []string{"daily", "weekly", "monthly"}
	costAlertDirections = []string{"increase", "decrease", "both"}
)

type costAlertResourceModel struct {
	ID                   types.String `tfsdk:"id"`
	Name                 types.String `tfsdk:"name"`
	Cadence              types.String `tfsdk:"cadence"`
	Direction            types.String `tfsdk:"direction"`
	GroupBy              types.String `tfsdk:"group_by"`
	GroupByTagKey        types.String `tfsdk:"group_by_tag_key"`
	ThresholdPercent     types.Int64  `tfsdk:"threshold_percent"`
	ThresholdAmountCents types.Int64  `tfsdk:"threshold_amount_cents"`
	Enabled              types.Bool   `tfsdk:"enabled"`
	Filter               types.List   `tfsdk:"filter"`
}

func (r *costAlertResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_alert"
}

func (r *costAlertResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An alert on *change* in spend, evaluated on a cadence and compared " +
			"against the preceding equivalent period.\n\n" +
			"**At least one of `threshold_percent` and `threshold_amount_cents` must be set.** " +
			"When both are set they are ANDed, not ORed: the alert fires only once the change is " +
			"both large enough in relative terms and large enough in absolute terms. That pairing " +
			"is the usual way to stop a small line item doubling in cost from paging anyone.\n\n" +
			"When the alert last ran and when it last fired are evaluation state, not configuration, " +
			"and this resource deliberately does not expose them — they change on nearly every " +
			"refresh and would make every plan noisy, exactly as budget spend status would. Read " +
			"them from the UI, the CLI, or the API.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned alert id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"cadence": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "How often the alert is evaluated, and therefore what it compares: " +
					"one of `" + joinBackticked(costAlertCadences) + "`.",
				Validators: []validator.String{oneOfValidator(costAlertCadences...)},
			},
			"direction": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Which way the change has to go to fire. One of `" +
					joinBackticked(costAlertDirections) + "`. `decrease` is useful for catching a " +
					"pipeline that silently stopped running.",
				Validators: []validator.String{oneOfValidator(costAlertDirections...)},
			},
			"group_by": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Evaluate the thresholds per value of this dimension rather than " +
					"against the total, so a spike in one account or service is not diluted by the rest. " +
					"One of `" + joinBackticked(costDimensions) + "`. Leave unset to alert on the total.",
				Validators: []validator.String{oneOfValidator(costDimensions...)},
			},
			"group_by_tag_key": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Which tag to group by. Required when `group_by` is `tag`, and " +
					"rejected otherwise.",
			},
			"threshold_percent": schema.Int64Attribute{
				Optional: true,
				MarkdownDescription: "Fire when spend changes by at least this percentage, 1–10000. " +
					"Set this, `threshold_amount_cents`, or both.",
				Validators: []validator.Int64{int64validator.Between(1, 10000)},
			},
			"threshold_amount_cents": schema.Int64Attribute{
				Optional: true,
				MarkdownDescription: "Fire when spend changes by at least this many minor currency " +
					"units. Must be greater than zero. Set this, `threshold_percent`, or both.",
				Validators: []validator.Int64{int64validator.AtLeast(1)},
			},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Whether the alert is evaluated. Defaults to `true`. Set it to " +
					"`false` to silence an alert without losing its definition.",
			},
		},
		Blocks: map[string]schema.Block{
			"filter": costFilterBlockSchema("Restricts the alert to matching spend. Clauses are ANDed."),
		},
	}
}

func (r *costAlertResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// ValidateConfig enforces the one rule the schema cannot express: an alert with
// neither threshold set has no condition to fire on, and the server rejects it
// with a 400.
//
// Catching it here makes it a plan-time error. The alternative is discovering it
// halfway through an apply that may already have created other resources in the
// graph, which costs a cleanup pass for a mistake that is visible in the config.
func (r *costAlertResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config costAlertResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Unknown counts as set: a threshold that comes from another resource's
	// output is not yet computed at validate time, and refusing it here would
	// reject a configuration that is perfectly legal.
	if config.ThresholdPercent.IsNull() && config.ThresholdAmountCents.IsNull() {
		resp.Diagnostics.AddError(
			"Cost alert has no threshold",
			"Set threshold_percent, threshold_amount_cents, or both. An alert with neither has no "+
				"condition to fire on and is rejected by the API.")
	}
}

func (r *costAlertResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costAlertResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costAlertInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCostAlert(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create cost alert", err.Error())
		return
	}

	state, diags := costAlertStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *costAlertResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costAlertResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCostAlert(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform: drop it from state so the next plan
		// recreates it, rather than failing the refresh.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost alert", err.Error())
		return
	}

	refreshed, diags := costAlertStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costAlertResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costAlertResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costAlertResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costAlertInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCostAlert(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Cost alert no longer exists",
				"The alert was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update cost alert", err.Error())
		return
	}

	next, diags := costAlertStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costAlertResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costAlertResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteCostAlert(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete cost alert", err.Error())
	}
}

func (r *costAlertResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// costAlertInputFrom maps Terraform configuration onto the write body.
//
// The two threshold fields travel as explicit JSON nulls rather than omitted
// keys — that is why they have no omitempty on the wire struct. Omitting one
// would be indistinguishable from clearing it, and since every write here is a
// full replace, "I no longer want an absolute threshold" has to be sayable.
func costAlertInputFrom(ctx context.Context, model costAlertResourceModel) (iw.CostAlertInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	filters, d := costFiltersFrom(ctx, model.Filter)
	diags.Append(d...)

	return iw.CostAlertInput{
		Name:                 model.Name.ValueString(),
		Filters:              filters,
		GroupBy:              stringPtr(model.GroupBy),
		GroupByTagKey:        stringPtr(model.GroupByTagKey),
		Cadence:              model.Cadence.ValueString(),
		ThresholdPercent:     int64Ptr(model.ThresholdPercent),
		ThresholdAmountCents: int64Ptr(model.ThresholdAmountCents),
		Direction:            model.Direction.ValueString(),
		Enabled:              model.Enabled.ValueBool(),
	}, diags
}

// costAlertStateFrom maps a server alert into Terraform state.
//
// The prior model is not consulted, unlike in the budget resource: every
// attribute this resource exposes is either non-nullable on the wire or
// genuinely nullable in a way the practitioner can express, so the response is
// always a complete answer and there is nothing for a fallback to repair.
//
// The evaluation timestamps the response also carries are dropped on the floor
// here, for the reason given in the schema description.
func costAlertStateFrom(ctx context.Context, remote *iw.CostAlert, _ costAlertResourceModel) (costAlertResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	filters, d := costFiltersTo(ctx, remote.Filters)
	diags.Append(d...)

	return costAlertResourceModel{
		ID:                   types.StringValue(remote.ID),
		Name:                 types.StringValue(remote.Name),
		Cadence:              types.StringValue(remote.Cadence),
		Direction:            types.StringValue(remote.Direction),
		GroupBy:              stringValue(remote.GroupBy),
		GroupByTagKey:        stringValue(remote.GroupByTagKey),
		ThresholdPercent:     int64Value(remote.ThresholdPercent),
		ThresholdAmountCents: int64Value(remote.ThresholdAmountCents),
		Enabled:              types.BoolValue(remote.Enabled),
		Filter:               filters,
	}, diags
}
