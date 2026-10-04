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
	_ resource.Resource                = (*dashboardNotificationResource)(nil)
	_ resource.ResourceWithConfigure   = (*dashboardNotificationResource)(nil)
	_ resource.ResourceWithImportState = (*dashboardNotificationResource)(nil)
)

// NewDashboardNotificationResource constructs the
// infrawrench_dashboard_notification resource.
func NewDashboardNotificationResource() resource.Resource {
	return &dashboardNotificationResource{}
}

type dashboardNotificationResource struct{ client *iw.Client }

type dashboardNotificationResourceModel struct {
	ID              types.String `tfsdk:"id"`
	DashboardID     types.String `tfsdk:"dashboard_id"`
	Cadence         types.String `tfsdk:"cadence"`
	SendDay         types.Int64  `tfsdk:"send_day"`
	SendDayOfMonth  types.Int64  `tfsdk:"send_day_of_month"`
	Hour            types.Int64  `tfsdk:"hour"`
	Timezone        types.String `tfsdk:"timezone"`
	SlackChannelIDs types.List   `tfsdk:"slack_channel_ids"`
	TeamsWebhookIDs types.List   `tfsdk:"teams_webhook_ids"`
	EmailRecipients types.List   `tfsdk:"email_recipients"`
	Enabled         types.Bool   `tfsdk:"enabled"`
	AttachPDF       types.Bool   `tfsdk:"attach_pdf"`
}

func (r *dashboardNotificationResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_dashboard_notification"
}

func (r *dashboardNotificationResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A recurring delivery of one whole dashboard, rendered as a PDF, to Slack, Teams or email.\n\n" +
			"At least one destination is required: a schedule with nowhere to deliver would only ever " +
			"record failures. The dashboard itself decides what the PDF shows; the cadence here only " +
			"decides how often it is sent.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned notification id. Import addresses it as " +
				"`<dashboard_id>/<id>`, because the notification's own id is not enough to build its URL."),
			"dashboard_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The dashboard to send. This provider does not manage dashboards yet, so take " +
					"the id from the dashboard's URL in the web app, or from the `dashboards` section of " +
					"`infrawrench config export`. Changing it replaces the schedule: the route is nested under " +
					"the dashboard, so there is nothing to move.",
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
				MarkdownDescription: "ISO day of week (1 = Monday, 7 = Sunday). Read only when `cadence` is " +
					"`weekly`.\n\n" +
					"Computed as well as optional because the server stores a default in the column whatever " +
					"the cadence is, and reads back null here for any cadence that does not use it.",
				Validators: []validatorInt64{between(1, 7)},
			},
			"send_day_of_month": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "Day of month, 1 to 31. Read only when `cadence` is `monthly`. A day the month " +
					"doesn't have clamps to its last day, so 31 means month end everywhere.",
				Validators: []validatorInt64{between(1, 31)},
			},
			"hour": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "Local hour (0 to 23) in `timezone` the delivery fires at.",
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
				MarkdownDescription: "Stored Slack channel row ids to post to: the `id` of an " +
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
			"attach_pdf": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Defaults to `true`. When set, the rendered PDF is attached to each email and " +
					"uploaded into the Slack message's thread. Teams always receives a summary and a link " +
					"only, because incoming webhooks cannot carry files.\n\n" +
					"The Slack upload needs the Slack app installed with the `files:write` scope. An " +
					"installation that predates it posts the message without the file until the app is " +
					"reinstalled.",
			},
		},
	}
}

func (r *dashboardNotificationResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *dashboardNotificationResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan dashboardNotificationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := dashboardNotificationInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateDashboardNotification(ctx, plan.DashboardID.ValueString(), input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create dashboard notification", err.Error())
		return
	}

	state, diags := dashboardNotificationStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *dashboardNotificationResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state dashboardNotificationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetDashboardNotification(ctx, state.DashboardID.ValueString(), state.ID.ValueString())
	if err != nil {
		// A deleted dashboard takes its schedules with it, and the listing
		// route 404s rather than returning an empty array. Both shapes mean the
		// same thing here: this schedule is gone.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read dashboard notification", err.Error())
		return
	}

	refreshed, diags := dashboardNotificationStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *dashboardNotificationResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan dashboardNotificationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state dashboardNotificationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := dashboardNotificationInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateDashboardNotification(ctx, state.DashboardID.ValueString(), state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Dashboard notification no longer exists",
				"The schedule was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update dashboard notification", err.Error())
		return
	}

	next, diags := dashboardNotificationStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *dashboardNotificationResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state dashboardNotificationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteDashboardNotification(ctx, state.DashboardID.ValueString(), state.ID.ValueString())
	if err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to delete dashboard notification", err.Error())
	}
}

// ImportState takes a composite "<dashboard_id>/<notification_id>" address.
//
// The notification id alone would not do: the route is nested under the
// dashboard, so without the dashboard id there is no URL to read.
func (r *dashboardNotificationResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, err := splitImportID(req.ID, 2, "<dashboard_id>/<notification_id>")
	if err != nil {
		resp.Diagnostics.AddError("Invalid import id", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("dashboard_id"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), parts[1])...)
}

/* -------------------------------- mapping --------------------------------- */

// dashboardNotificationInputFrom maps configuration onto the POST/PUT body.
//
// As with report notifications, only the day field the cadence reads is sent.
// attach_pdf is always sent: it has a schema default, so the plan always holds
// a known value, and sending it explicitly means a server-side change to the
// absent-key default could never flip an existing schedule.
func dashboardNotificationInputFrom(ctx context.Context, model dashboardNotificationResourceModel) (iw.DashboardNotificationInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	slack, d := stringSlice(ctx, model.SlackChannelIDs)
	diags.Append(d...)
	teams, d := stringSlice(ctx, model.TeamsWebhookIDs)
	diags.Append(d...)
	emails, d := stringSlice(ctx, model.EmailRecipients)
	diags.Append(d...)
	if diags.HasError() {
		return iw.DashboardNotificationInput{}, diags
	}

	cadence := model.Cadence.ValueString()
	attach := true
	if !model.AttachPDF.IsNull() && !model.AttachPDF.IsUnknown() {
		attach = model.AttachPDF.ValueBool()
	}
	input := iw.DashboardNotificationInput{
		Cadence:         cadence,
		Hour:            model.Hour.ValueInt64(),
		Timezone:        model.Timezone.ValueString(),
		SlackChannelIDs: slack,
		TeamsWebhookIDs: teams,
		EmailRecipients: emails,
		Enabled:         model.Enabled.ValueBool(),
		AttachPDF:       &attach,
	}
	if cadence == "weekly" {
		input.SendDay = int64Ptr(model.SendDay)
	}
	if cadence == "monthly" {
		input.SendDayOfMonth = int64Ptr(model.SendDayOfMonth)
	}
	return input, diags
}

// dashboardNotificationStateFrom maps the server's schedule into state. The
// unused day field stays null for the same reason as report notifications: the
// server always returns both, and writing the unused one would diff forever.
func dashboardNotificationStateFrom(ctx context.Context, remote *iw.DashboardNotification) (dashboardNotificationResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	slack, d := nilStringList(ctx, remote.SlackChannelIDs)
	diags.Append(d...)
	teams, d := nilStringList(ctx, remote.TeamsWebhookIDs)
	diags.Append(d...)
	emails, d := nilStringList(ctx, remote.EmailRecipients)
	diags.Append(d...)
	if diags.HasError() {
		return dashboardNotificationResourceModel{}, diags
	}

	model := dashboardNotificationResourceModel{
		ID:              types.StringValue(remote.ID),
		DashboardID:     types.StringValue(remote.DashboardID),
		Cadence:         types.StringValue(remote.Cadence),
		SendDay:         types.Int64Null(),
		SendDayOfMonth:  types.Int64Null(),
		Hour:            types.Int64Value(remote.Hour),
		Timezone:        types.StringValue(remote.Timezone),
		SlackChannelIDs: slack,
		TeamsWebhookIDs: teams,
		EmailRecipients: emails,
		Enabled:         types.BoolValue(remote.Enabled),
		AttachPDF:       types.BoolValue(remote.AttachPDF),
	}
	switch remote.Cadence {
	case "weekly":
		model.SendDay = types.Int64Value(remote.SendDay)
	case "monthly":
		model.SendDayOfMonth = types.Int64Value(remote.SendDayOfMonth)
	}
	return model, diags
}
