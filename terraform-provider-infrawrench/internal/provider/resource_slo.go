package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*sloResource)(nil)
	_ resource.ResourceWithConfigure      = (*sloResource)(nil)
	_ resource.ResourceWithImportState    = (*sloResource)(nil)
	_ resource.ResourceWithValidateConfig = (*sloResource)(nil)
)

// NewSloResource constructs the infrawrench_slo resource.
func NewSloResource() resource.Resource { return &sloResource{} }

type sloResource struct{ client *iw.Client }

var (
	sloKinds       = []string{"probe_availability", "probe_latency", "metric_threshold"}
	sloComparators = []string{"<", "<=", ">", ">="}
)

type sloResourceModel struct {
	ID                 types.String  `tfsdk:"id"`
	Name               types.String  `tfsdk:"name"`
	Description        types.String  `tfsdk:"description"`
	SliKind            types.String  `tfsdk:"sli_kind"`
	ProbeID            types.String  `tfsdk:"probe_id"`
	LatencyThresholdMs types.Int64   `tfsdk:"latency_threshold_ms"`
	ResourceID         types.String  `tfsdk:"resource_id"`
	MetricKey          types.String  `tfsdk:"metric_key"`
	Comparator         types.String  `tfsdk:"comparator"`
	Threshold          types.Float64 `tfsdk:"threshold"`
	TargetPercent      types.Float64 `tfsdk:"target_percent"`
	WindowDays         types.Int64   `tfsdk:"window_days"`
	AlertsEnabled      types.Bool    `tfsdk:"alerts_enabled"`
	SuggestFreeze      types.Bool    `tfsdk:"suggest_freeze"`
	Enabled            types.Bool    `tfsdk:"enabled"`

	Status                 types.String  `tfsdk:"status"`
	Sli                    types.Float64 `tfsdk:"sli"`
	BudgetRemaining        types.Float64 `tfsdk:"budget_remaining"`
	BudgetTotalMinutes     types.Float64 `tfsdk:"budget_total_minutes"`
	BudgetRemainingMinutes types.Float64 `tfsdk:"budget_remaining_minutes"`
}

func (r *sloResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_slo"
}

func (r *sloResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	trimmed := stringvalidator.RegexMatches(trimmedPattern,
		"must not be empty or start or end with whitespace (the server trims it, which would diff forever)")

	resp.Schema = schema.Schema{
		MarkdownDescription: "A service-level objective: a target over a rolling window, measured from data " +
			"Infrawrench already records. The SLI is the share of good minutes in the window, from a synthetic " +
			"probe's success ratio, the share of its checks under a latency threshold, or the share of minutes " +
			"a resource's metric satisfies a comparison.\n\n" +
			"The poller computes the error budget and multiwindow burn rates every minute and routes " +
			"`sloAlerts` through the organization's alert routing rules: a page when 2% of the budget burns in " +
			"an hour or 5% in six hours, a ticket-level alert when 10% burns in three days. When the budget " +
			"runs out and `suggest_freeze` is set, the alert suggests a change freeze; nothing is frozen " +
			"until somebody starts one.\n\n" +
			"Only the source fields the `sli_kind` uses may be set. Unlike probes, an out-of-range value is " +
			"rejected rather than clamped.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned SLO id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Unique in the organization; 1–120 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120), trimmed},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text shown under the name; 1–500 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 500), trimmed},
			},
			"sli_kind": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Where the SLI comes from: one of `" + joinBackticked(sloKinds) + "`. " +
					"`probe_availability` and `probe_latency` need `probe_id`; `probe_latency` also needs " +
					"`latency_threshold_ms`; `metric_threshold` needs `resource_id`, `metric_key`, " +
					"`comparator` and `threshold`.",
				Validators: []validatorString{oneOfValidator(sloKinds...)},
			},
			"probe_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "`probe_*`: the `infrawrench_probe` to measure. Deleting the probe does not " +
					"delete the SLO; it goes to `unknown` until it is pointed at another one.",
			},
			"latency_threshold_ms": schema.Int64Attribute{
				Optional:            true,
				MarkdownDescription: "`probe_latency`: a check is good at or under this many milliseconds, 1–60000.",
				Validators:          []validatorInt64{between(1, 60000)},
			},
			"resource_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "`metric_threshold`: the Infrawrench resource whose metric is measured. Use " +
					"`data.infrawrench_resources` to resolve one; it must have reported metrics recently.",
			},
			"metric_key": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "`metric_threshold`: the series label as the resource reports it, for " +
					"example `CPU %`; 1–200 characters.",
				Validators: []validatorString{stringvalidator.LengthBetween(1, 200), trimmed},
			},
			"comparator": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "`metric_threshold`: a minute is good when `value <comparator> threshold`. " +
					"One of `" + joinBackticked(sloComparators) + "`.",
				Validators: []validatorString{oneOfValidator(sloComparators...)},
			},
			"threshold": schema.Float64Attribute{
				Optional:            true,
				MarkdownDescription: "`metric_threshold`: the right-hand side of the comparison, in the metric's unit.",
			},
			"target_percent": schema.Float64Attribute{
				Required: true,
				MarkdownDescription: "The objective as a percentage, 50–99.999. `99.9` over 30 days is 43 minutes " +
					"of budget.",
				Validators: []validatorFloat64{betweenFloat(50, 99.999)},
			},
			"window_days": schema.Int64Attribute{
				Optional:            true,
				Computed:            true,
				Default:             int64default.StaticInt64(30),
				MarkdownDescription: "Rolling window in days: `7`, `28` or `30`. Defaults to `30`.",
				Validators:          []validatorInt64{int64validator.OneOf(7, 28, 30)},
			},
			"alerts_enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Route burn-rate and exhaustion alerts. Burn rates are computed either way.",
			},
			"suggest_freeze": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "When the budget runs out, the alert and the SLO's page suggest a change freeze.",
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "A disabled SLO is not evaluated and raises no alerts.",
			},

			"status": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The last evaluation, worst first: `exhausted`, `fast_burn`, `slow_burn`, " +
					"`ok`, or `unknown` (no data in the window, never evaluated, or disabled).",
			},
			"sli": schema.Float64Attribute{
				Computed:            true,
				MarkdownDescription: "Share of good minutes over the window, as a fraction; null with no data.",
			},
			"budget_remaining": schema.Float64Attribute{
				Computed:            true,
				MarkdownDescription: "Share of the window's error budget left, as a fraction; negative when overspent.",
			},
			"budget_total_minutes": schema.Float64Attribute{
				Computed:            true,
				MarkdownDescription: "The window's whole error budget in minutes of total badness.",
			},
			"budget_remaining_minutes": schema.Float64Attribute{
				Computed:            true,
				MarkdownDescription: "`budget_remaining` in minutes; negative when overspent.",
			},
		},
	}
}

// ValidateConfig enforces that only the source fields the kind uses are set.
// The server nulls the others rather than rejecting them, which would read
// back different from the configuration and fail the apply as an
// inconsistent result.
func (r *sloResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var cfg sloResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() || cfg.SliKind.IsUnknown() || cfg.SliKind.IsNull() {
		return
	}
	kind := cfg.SliKind.ValueString()
	isProbe := kind == "probe_availability" || kind == "probe_latency"
	isMetric := kind == "metric_threshold"

	set := func(v interface{ IsNull() bool }) bool { return !v.IsNull() }
	forbid := func(attr string, present bool) {
		if present {
			resp.Diagnostics.AddAttributeError(path.Root(attr), "Not used by this sli_kind",
				"`"+attr+"` does not apply to sli_kind `"+kind+"`; remove it.")
		}
	}
	require := func(attr string, present bool) {
		if !present {
			resp.Diagnostics.AddAttributeError(path.Root(attr), "Required by this sli_kind",
				"sli_kind `"+kind+"` needs `"+attr+"`.")
		}
	}

	if isProbe {
		require("probe_id", set(cfg.ProbeID))
	} else {
		forbid("probe_id", set(cfg.ProbeID))
	}
	if kind == "probe_latency" {
		require("latency_threshold_ms", set(cfg.LatencyThresholdMs))
	} else {
		forbid("latency_threshold_ms", set(cfg.LatencyThresholdMs))
	}
	for attr, v := range map[string]interface{ IsNull() bool }{
		"resource_id": cfg.ResourceID,
		"metric_key":  cfg.MetricKey,
		"comparator":  cfg.Comparator,
		"threshold":   cfg.Threshold,
	} {
		if isMetric {
			require(attr, set(v))
		} else {
			forbid(attr, set(v))
		}
	}
}

func (r *sloResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func sloInputFrom(plan sloResourceModel) iw.SloInput {
	return iw.SloInput{
		Name:               plan.Name.ValueString(),
		Description:        stringPtr(plan.Description),
		SliKind:            plan.SliKind.ValueString(),
		ProbeID:            stringPtr(plan.ProbeID),
		LatencyThresholdMs: int64Ptr(plan.LatencyThresholdMs),
		ResourceID:         stringPtr(plan.ResourceID),
		MetricKey:          stringPtr(plan.MetricKey),
		Comparator:         stringPtr(plan.Comparator),
		Threshold:          float64Ptr(plan.Threshold),
		TargetPercent:      plan.TargetPercent.ValueFloat64(),
		WindowDays:         plan.WindowDays.ValueInt64(),
		AlertsEnabled:      plan.AlertsEnabled.ValueBool(),
		SuggestFreeze:      plan.SuggestFreeze.ValueBool(),
		Enabled:            plan.Enabled.ValueBool(),
	}
}

func (r *sloResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan sloResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateSlo(ctx, sloInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to create SLO", err.Error())
		return
	}
	state := sloStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *sloResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state sloResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetSlo(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read SLO", err.Error())
		return
	}
	refreshed := sloStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update sends every field: the route leaves an omitted key alone, and a
// removed attribute means "back to the default", which the schema defaults
// have already filled in.
func (r *sloResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan sloResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state sloResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateSlo(ctx, state.ID.ValueString(), sloInputFrom(plan))
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"SLO no longer exists",
				"The SLO was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update SLO", err.Error())
		return
	}
	next := sloStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the SLO. The measured probe or metric series are untouched.
func (r *sloResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state sloResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteSlo(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete SLO", err.Error())
	}
}

func (r *sloResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func sloStateFrom(remote *iw.Slo) sloResourceModel {
	return sloResourceModel{
		ID:                     types.StringValue(remote.ID),
		Name:                   types.StringValue(remote.Name),
		Description:            stringValue(remote.Description),
		SliKind:                types.StringValue(remote.SliKind),
		ProbeID:                stringValue(remote.ProbeID),
		LatencyThresholdMs:     int64Value(remote.LatencyThresholdMs),
		ResourceID:             stringValue(remote.ResourceID),
		MetricKey:              stringValue(remote.MetricKey),
		Comparator:             stringValue(remote.Comparator),
		Threshold:              float64Value(remote.Threshold),
		TargetPercent:          types.Float64Value(remote.TargetPercent),
		WindowDays:             types.Int64Value(remote.WindowDays),
		AlertsEnabled:          types.BoolValue(remote.AlertsEnabled),
		SuggestFreeze:          types.BoolValue(remote.SuggestFreeze),
		Enabled:                types.BoolValue(remote.Enabled),
		Status:                 types.StringValue(remote.Status),
		Sli:                    float64Value(remote.Sli),
		BudgetRemaining:        float64Value(remote.BudgetRemaining),
		BudgetTotalMinutes:     types.Float64Value(remote.BudgetTotalMinutes),
		BudgetRemainingMinutes: float64Value(remote.BudgetRemainingMinutes),
	}
}
