package provider

import (
	"context"

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
	_ resource.Resource                = (*metricAlertResource)(nil)
	_ resource.ResourceWithConfigure   = (*metricAlertResource)(nil)
	_ resource.ResourceWithImportState = (*metricAlertResource)(nil)
)

// NewMetricAlertResource constructs the infrawrench_metric_alert resource.
func NewMetricAlertResource() resource.Resource { return &metricAlertResource{} }

type metricAlertResource struct{ client *iw.Client }

type metricAlertResourceModel struct {
	ID              types.String  `tfsdk:"id"`
	Name            types.String  `tfsdk:"name"`
	PluginID        types.String  `tfsdk:"plugin_id"`
	ResourceTypeID  types.String  `tfsdk:"resource_type_id"`
	TagKey          types.String  `tfsdk:"tag_key"`
	TagValue        types.String  `tfsdk:"tag_value"`
	MetricKey       types.String  `tfsdk:"metric_key"`
	Comparator      types.String  `tfsdk:"comparator"`
	Threshold       types.Float64 `tfsdk:"threshold"`
	ForMinutes      types.Int64   `tfsdk:"for_minutes"`
	CooldownMinutes types.Int64   `tfsdk:"cooldown_minutes"`
	Enabled         types.Bool    `tfsdk:"enabled"`
}

var metricComparators = []string{">", ">=", "<", "<="}

func (r *metricAlertResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_metric_alert"
}

func (r *metricAlertResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A threshold on a resource metric — CPU above 90% for twenty minutes, free disk " +
			"below 10% — evaluated against every resource the selector matches.\n\n" +
			"Resources are selected **by query, never by id**, which is the property that makes this worth " +
			"keeping in Terraform: one rule written once covers every instance the team creates " +
			"afterwards, without anyone having to remember to add it.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned rule id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"plugin_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Selector: plugin the resource must belong to. Omit it to match any plugin. " +
					"Use `data.infrawrench_plugins` for the valid ids.",
			},
			"resource_type_id": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Selector: resource type within the plugin. Omit it to match any type.",
			},
			"tag_key": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Selector: tag key the resource must carry, matched case-insensitively. Omit " +
					"it to apply no tag filter.",
			},
			"tag_value": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Selector: exact value `tag_key` must have. Omit it to match any value.",
			},
			"metric_key": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The metric series label as the resource's charts report it, e.g. `CPU %`. " +
					"The organization's available keys are listed at `/metric-alerts/metric-keys`; a key no " +
					"resource reports is accepted and simply never fires.",
			},
			"comparator": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "One of `" + joinBackticked(metricComparators) + "`.",
				Validators:          []validatorString{oneOfValidator(metricComparators...)},
			},
			"threshold": schema.Float64Attribute{
				Required:            true,
				MarkdownDescription: "The value compared against, in the metric's own units.",
			},
			"for_minutes": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(15),
				MarkdownDescription: "Trailing window in minutes the condition must hold for before firing, " +
					"5–1440. A momentary spike is not an incident.",
				Validators: []validatorInt64{between(5, 1440)},
			},
			"cooldown_minutes": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(60),
				MarkdownDescription: "Least minutes between notified firings for one (rule, resource) pair, " +
					"0–10080. Per pair rather than per rule, so one noisy instance does not silence the others.",
				Validators: []validatorInt64{between(0, 10080)},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "A disabled rule keeps its settings and is never evaluated.",
			},
		},
	}
}

func (r *metricAlertResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *metricAlertResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan metricAlertResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateMetricAlert(ctx, metricAlertInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to create metric alert", err.Error())
		return
	}

	state := metricAlertStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *metricAlertResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state metricAlertResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetMetricAlert(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read metric alert", err.Error())
		return
	}

	refreshed := metricAlertStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *metricAlertResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan metricAlertResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state metricAlertResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateMetricAlert(ctx, state.ID.ValueString(), metricAlertInputFrom(plan))
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Metric alert no longer exists",
				"The rule was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update metric alert", err.Error())
		return
	}

	next := metricAlertStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *metricAlertResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state metricAlertResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteMetricAlert(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete metric alert", err.Error())
	}
}

func (r *metricAlertResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// metricAlertInputFrom maps configuration onto the POST/PUT body. The four
// selector fields go through as pointers so an omitted attribute reaches the
// server as an explicit null, which is how "match anything" is spelled.
func metricAlertInputFrom(model metricAlertResourceModel) iw.MetricAlertRuleInput {
	return iw.MetricAlertRuleInput{
		Name:            model.Name.ValueString(),
		PluginID:        stringPtr(model.PluginID),
		ResourceTypeID:  stringPtr(model.ResourceTypeID),
		TagKey:          stringPtr(model.TagKey),
		TagValue:        stringPtr(model.TagValue),
		MetricKey:       model.MetricKey.ValueString(),
		Comparator:      model.Comparator.ValueString(),
		Threshold:       model.Threshold.ValueFloat64(),
		ForMinutes:      model.ForMinutes.ValueInt64(),
		CooldownMinutes: model.CooldownMinutes.ValueInt64(),
		Enabled:         model.Enabled.ValueBool(),
	}
}

func metricAlertStateFrom(remote *iw.MetricAlertRule) metricAlertResourceModel {
	return metricAlertResourceModel{
		ID:              types.StringValue(remote.ID),
		Name:            types.StringValue(remote.Name),
		PluginID:        stringValue(remote.PluginID),
		ResourceTypeID:  stringValue(remote.ResourceTypeID),
		TagKey:          stringValue(remote.TagKey),
		TagValue:        stringValue(remote.TagValue),
		MetricKey:       types.StringValue(remote.MetricKey),
		Comparator:      types.StringValue(remote.Comparator),
		Threshold:       types.Float64Value(remote.Threshold),
		ForMinutes:      types.Int64Value(remote.ForMinutes),
		CooldownMinutes: types.Int64Value(remote.CooldownMinutes),
		Enabled:         types.BoolValue(remote.Enabled),
	}
}
