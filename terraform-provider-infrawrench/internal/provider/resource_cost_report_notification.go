package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costReportNotificationResource)(nil)
	_ resource.ResourceWithConfigure   = (*costReportNotificationResource)(nil)
	_ resource.ResourceWithImportState = (*costReportNotificationResource)(nil)
)

// NewCostReportNotificationResource constructs the
// infrawrench_cost_report_notification resource.
func NewCostReportNotificationResource() resource.Resource {
	return &costReportNotificationResource{}
}

type costReportNotificationResource struct{ client *iw.Client }

type costReportNotificationResourceModel struct {
	ID              types.String `tfsdk:"id"`
	CostReportID    types.String `tfsdk:"cost_report_id"`
	Cadence         types.String `tfsdk:"cadence"`
	SendDay         types.Int64  `tfsdk:"send_day"`
	SendDayOfMonth  types.Int64  `tfsdk:"send_day_of_month"`
	Hour            types.Int64  `tfsdk:"hour"`
	Timezone        types.String `tfsdk:"timezone"`
	SlackChannelIDs types.List   `tfsdk:"slack_channel_ids"`
	TeamsWebhookIDs types.List   `tfsdk:"teams_webhook_ids"`
	EmailRecipients types.List   `tfsdk:"email_recipients"`
	Enabled         types.Bool   `tfsdk:"enabled"`
}

var reportCadences = []string{"daily", "weekly", "monthly"}

func (r *costReportNotificationResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_report_notification"
}

func (r *costReportNotificationResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A recurring delivery of one `infrawrench_cost_report` to Slack, Teams or email.\n\n" +
			"At least one destination is required: a schedule with nowhere to deliver would only ever " +
			"record failures. The report itself decides what window it charts — the cadence here only " +
			"decides how often it is sent.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned notification id. Import addresses it as " +
				"`<cost_report_id>/<id>`, because the notification's own id is not enough to build its URL."),
			"cost_report_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The report to send. Changing it replaces the schedule — the route is nested " +
					"under the report, so there is nothing to move.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"cadence": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "How often the schedule fires. One of `" + joinBackticked(reportCadences) + "`.",
				Validators:          []validatorString{oneOfValidator(reportCadences...)},
			},
			"send_day": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "ISO day of week (1 = Monday … 7 = Sunday). Read only when `cadence` is " +
					"`weekly`.\n\n" +
					"Computed as well as optional because the server stores a default in the column whatever " +
					"the cadence is, and reads back null here for any cadence that does not use it.",
				Validators: []validatorInt64{between(1, 7)},
			},
			"send_day_of_month": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "Day of month, 1–31. Read only when `cadence` is `monthly`. A day the month " +
					"doesn't have clamps to its last day, so 31 means month end everywhere.",
				Validators: []validatorInt64{between(1, 31)},
			},
			"hour": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "Local hour (0–23) in `timezone` the delivery fires at.",
				Validators:          []validatorInt64{between(0, 23)},
			},
			"timezone": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "IANA zone, e.g. `Europe/Berlin`. Validated server-side.",
			},
			"slack_channel_ids": schema.ListAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Stored Slack channel row ids to post to — the `id` of an " +
					"`infrawrench_slack_channel`, not a Slack `C…` id.",
			},
			"teams_webhook_ids": schema.ListAttribute{
				Optional:            true,
				Computed:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Stored Teams webhook ids to post to, from `infrawrench_msteams_webhook`.",
			},
			"email_recipients": schema.ListAttribute{
				Optional:            true,
				Computed:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Email addresses, at most 20. Lowercased server-side.",
				Validators:          []validatorList{sizeAtMost(20)},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Defaults to `true`. A disabled schedule keeps its settings and never fires.",
			},
		},
	}
}

func (r *costReportNotificationResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costReportNotificationResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costReportNotificationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := reportNotificationInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateReportNotification(ctx, plan.CostReportID.ValueString(), input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create report notification", err.Error())
		return
	}

	state, diags := reportNotificationStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *costReportNotificationResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costReportNotificationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetReportNotification(ctx, state.CostReportID.ValueString(), state.ID.ValueString())
	if err != nil {
		// A deleted *report* takes its schedules with it, and the listing route
		// 404s rather than returning an empty array. Both shapes mean the same
		// thing here: this schedule is gone.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read report notification", err.Error())
		return
	}

	refreshed, diags := reportNotificationStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costReportNotificationResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costReportNotificationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costReportNotificationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := reportNotificationInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateReportNotification(ctx, state.CostReportID.ValueString(), state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Report notification no longer exists",
				"The schedule was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update report notification", err.Error())
		return
	}

	next, diags := reportNotificationStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costReportNotificationResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costReportNotificationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteReportNotification(ctx, state.CostReportID.ValueString(), state.ID.ValueString())
	if err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to delete report notification", err.Error())
	}
}

// ImportState takes a composite "<cost_report_id>/<notification_id>" address.
//
// The notification id alone would not do: the route is nested under the report,
// so without the report id there is no URL to read.
func (r *costReportNotificationResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, err := splitImportID(req.ID, 2, "<cost_report_id>/<notification_id>")
	if err != nil {
		resp.Diagnostics.AddError("Invalid import id", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("cost_report_id"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), parts[1])...)
}

/* -------------------------------- mapping --------------------------------- */

// reportNotificationInputFrom maps configuration onto the POST/PUT body.
//
// The two day fields are sent only when the cadence reads them. Sending a
// weekday alongside a monthly cadence would store a number nothing ever looks
// at, and the server would echo its own default back — which reads as drift
// against a configuration that never mentioned it.
func reportNotificationInputFrom(ctx context.Context, model costReportNotificationResourceModel) (iw.ReportNotificationInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	slack, d := stringSlice(ctx, model.SlackChannelIDs)
	diags.Append(d...)
	teams, d := stringSlice(ctx, model.TeamsWebhookIDs)
	diags.Append(d...)
	emails, d := stringSlice(ctx, model.EmailRecipients)
	diags.Append(d...)
	if diags.HasError() {
		return iw.ReportNotificationInput{}, diags
	}

	cadence := model.Cadence.ValueString()
	input := iw.ReportNotificationInput{
		Cadence:         cadence,
		Hour:            model.Hour.ValueInt64(),
		Timezone:        model.Timezone.ValueString(),
		SlackChannelIDs: slack,
		TeamsWebhookIDs: teams,
		EmailRecipients: emails,
		Enabled:         model.Enabled.ValueBool(),
	}
	if cadence == "weekly" {
		input.SendDay = int64Ptr(model.SendDay)
	}
	if cadence == "monthly" {
		input.SendDayOfMonth = int64Ptr(model.SendDayOfMonth)
	}
	return input, diags
}

// reportNotificationStateFrom maps the server's schedule into state.
//
// The two day fields are read back only for the cadence that uses them. The
// server always returns both — they are non-null columns with defaults — and
// writing the unused one into state would show a permanent diff against a
// configuration that correctly leaves it out.
func reportNotificationStateFrom(ctx context.Context, remote *iw.ReportNotification) (costReportNotificationResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	slack, d := nilStringList(ctx, remote.SlackChannelIDs)
	diags.Append(d...)
	teams, d := nilStringList(ctx, remote.TeamsWebhookIDs)
	diags.Append(d...)
	emails, d := nilStringList(ctx, remote.EmailRecipients)
	diags.Append(d...)
	if diags.HasError() {
		return costReportNotificationResourceModel{}, diags
	}

	model := costReportNotificationResourceModel{
		ID:              types.StringValue(remote.ID),
		CostReportID:    types.StringValue(remote.CostReportID),
		Cadence:         types.StringValue(remote.Cadence),
		SendDay:         types.Int64Null(),
		SendDayOfMonth:  types.Int64Null(),
		Hour:            types.Int64Value(remote.Hour),
		Timezone:        types.StringValue(remote.Timezone),
		SlackChannelIDs: slack,
		TeamsWebhookIDs: teams,
		EmailRecipients: emails,
		Enabled:         types.BoolValue(remote.Enabled),
	}
	switch remote.Cadence {
	case "weekly":
		model.SendDay = types.Int64Value(remote.SendDay)
	case "monthly":
		model.SendDayOfMonth = types.Int64Value(remote.SendDayOfMonth)
	}
	return model, diags
}
