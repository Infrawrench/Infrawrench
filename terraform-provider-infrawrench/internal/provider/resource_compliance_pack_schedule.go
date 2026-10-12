package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*compliancePackScheduleResource)(nil)
	_ resource.ResourceWithConfigure      = (*compliancePackScheduleResource)(nil)
	_ resource.ResourceWithImportState    = (*compliancePackScheduleResource)(nil)
	_ resource.ResourceWithValidateConfig = (*compliancePackScheduleResource)(nil)
)

// compliancePackCadences is the pack schedule's closed cadence vocabulary.
var compliancePackCadences = []string{"monthly", "quarterly"}

// NewCompliancePackScheduleResource constructs the
// infrawrench_compliance_pack_schedule resource.
func NewCompliancePackScheduleResource() resource.Resource {
	return &compliancePackScheduleResource{}
}

type compliancePackScheduleResource struct{ client *iw.Client }

type compliancePackScheduleResourceModel struct {
	ID              types.String `tfsdk:"id"`
	FrameworkID     types.String `tfsdk:"framework_id"`
	Cadence         types.String `tfsdk:"cadence"`
	SendDayOfMonth  types.Int64  `tfsdk:"send_day_of_month"`
	Hour            types.Int64  `tfsdk:"hour"`
	Timezone        types.String `tfsdk:"timezone"`
	EmailRecipients types.Set    `tfsdk:"email_recipients"`
	SlackChannelIDs types.Set    `tfsdk:"slack_channel_ids"`
	TeamsWebhookIDs types.Set    `tfsdk:"teams_webhook_ids"`
	Enabled         types.Bool   `tfsdk:"enabled"`
	NextSendAt      types.String `tfsdk:"next_send_at"`
	LastSentAt      types.String `tfsdk:"last_sent_at"`
	LastStatus      types.String `tfsdk:"last_status"`
	LastError       types.String `tfsdk:"last_error"`
}

// noUppercase rejects an address the server would lowercase. Storing
// "Audit@Example.com" as "audit@example.com" is a different set element, which
// Terraform reports as an inconsistent result after apply.
var noUppercase = regexp.MustCompile(`^[^A-Z]*$`)

func (r *compliancePackScheduleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_compliance_pack_schedule"
}

func (r *compliancePackScheduleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A recurring delivery of a compliance evidence pack: the ZIP of per-control and " +
			"per-source CSV and JSON files, a summary PDF and a checksummed manifest, covering the previous " +
			"calendar month or quarter in the schedule's time zone.\n\n" +
			"Email attaches the ZIP. Slack posts the summary and uploads the ZIP into the message's thread " +
			"(which needs the Slack app's `files:write` scope; without it the message goes out alone). " +
			"Teams receives the summary and a link, because incoming webhooks cannot carry files.\n\n" +
			"At least one destination is required, and a framework can have at most 10 schedules.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned schedule id, which is also the import address."),
			"framework_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The framework whose pack is sent. One of `" +
					joinBackticked(complianceFrameworks) + "`. Changing it moves the schedule in place.",
				Validators: []validatorString{oneOfValidator(complianceFrameworks...)},
			},
			"cadence": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "One of `" + joinBackticked(compliancePackCadences) + "`. `monthly` " +
					"delivers the previous calendar month every month; `quarterly` delivers the previous " +
					"calendar quarter in January, April, July and October.",
				Validators: []validatorString{oneOfValidator(compliancePackCadences...)},
			},
			"send_day_of_month": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(1),
				MarkdownDescription: "Day of the sending month, 1–31. Defaults to `1`. A day the month " +
					"doesn't have clamps to its last day, so 31 means month end everywhere.",
				Validators: []validatorInt64{between(1, 31)},
			},
			"hour": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "Local hour, 0–23, in `timezone` the delivery fires at.",
				Validators:          []validatorInt64{between(0, 23)},
			},
			"timezone": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "IANA zone, e.g. `Europe/London`. It decides both when the delivery " +
					"fires and where the covered month or quarter begins and ends. Validated server-side.",
				Validators: []validatorString{stringvalidator.LengthAtLeast(1)},
			},
			"email_recipients": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Email addresses to send the pack to, at most 20. Write them in lower " +
					"case: the server lowercases addresses, and a mixed-case one would never match.",
				Validators: []validatorSet{
					setSizeAtMost(20),
					setvalidator.ValueStringsAre(stringvalidator.RegexMatches(noUppercase,
						"must be lower case; the server lowercases email addresses")),
				},
			},
			"slack_channel_ids": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Stored Slack channel ids to post to, at most 20: the `id` of an " +
					"`infrawrench_slack_channel`, not a Slack `C…` id.",
				Validators: []validatorSet{setSizeAtMost(20)},
			},
			"teams_webhook_ids": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Stored Teams webhook ids to post to, at most 20, from " +
					"`infrawrench_msteams_webhook`.",
				Validators: []validatorSet{setSizeAtMost(20)},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Defaults to `true`. A disabled schedule keeps its settings and never fires.",
			},
			"next_send_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "When the next delivery fires (RFC 3339); null while disabled.",
			},
			"last_sent_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "When the last delivery was attempted (RFC 3339), or null if never.",
			},
			"last_status": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "Outcome of the last delivery: `pending`, `succeeded`, `partial`, " +
					"`failed` or `no_targets`. Cleared by every update.",
			},
			"last_error": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Why the last delivery failed, if it did. Cleared by every update.",
			},
		},
	}
}

// ValidateConfig enforces "at least one destination" when every destination
// is known: a schedule with nowhere to deliver is a guaranteed 400.
func (r *compliancePackScheduleResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config compliancePackScheduleResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	empty := func(s types.Set) bool { return s.IsNull() || (!s.IsUnknown() && len(s.Elements()) == 0) }
	if empty(config.EmailRecipients) && empty(config.SlackChannelIDs) && empty(config.TeamsWebhookIDs) {
		resp.Diagnostics.AddAttributeError(path.Root("email_recipients"), "No destination",
			"A pack schedule needs at least one destination: set `email_recipients`, `slack_channel_ids` "+
				"or `teams_webhook_ids`.")
	}
}

func (r *compliancePackScheduleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *compliancePackScheduleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan compliancePackScheduleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := compliancePackScheduleInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCompliancePackSchedule(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create compliance pack schedule", err.Error())
		return
	}

	state, diags := compliancePackScheduleStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *compliancePackScheduleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state compliancePackScheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCompliancePackSchedule(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read compliance pack schedule", err.Error())
		return
	}

	refreshed, diags := compliancePackScheduleStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *compliancePackScheduleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan compliancePackScheduleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state compliancePackScheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := compliancePackScheduleInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCompliancePackSchedule(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Compliance pack schedule no longer exists",
				"The schedule was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update compliance pack schedule", err.Error())
		return
	}

	next, diags := compliancePackScheduleStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *compliancePackScheduleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state compliancePackScheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteCompliancePackSchedule(ctx, state.ID.ValueString())
	if err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to delete compliance pack schedule", err.Error())
	}
}

func (r *compliancePackScheduleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// stringSetSlice reads a set of strings, null or unknown becoming an empty
// slice: the API's arrays are `[]`, never null.
func stringSetSlice(ctx context.Context, set types.Set) ([]string, diag.Diagnostics) {
	out := []string{}
	if set.IsNull() || set.IsUnknown() {
		return out, nil
	}
	diags := set.ElementsAs(ctx, &out, false)
	if out == nil {
		out = []string{}
	}
	return out, diags
}

// compliancePackScheduleInputFrom maps configuration onto the POST/PUT body.
// Both cadences read send_day_of_month, so it is always sent.
func compliancePackScheduleInputFrom(ctx context.Context, model compliancePackScheduleResourceModel) (iw.CompliancePackScheduleInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	emails, d := stringSetSlice(ctx, model.EmailRecipients)
	diags.Append(d...)
	slack, d := stringSetSlice(ctx, model.SlackChannelIDs)
	diags.Append(d...)
	teams, d := stringSetSlice(ctx, model.TeamsWebhookIDs)
	diags.Append(d...)

	return iw.CompliancePackScheduleInput{
		FrameworkID:     model.FrameworkID.ValueString(),
		Cadence:         model.Cadence.ValueString(),
		SendDayOfMonth:  int64Ptr(model.SendDayOfMonth),
		Hour:            model.Hour.ValueInt64(),
		Timezone:        model.Timezone.ValueString(),
		EmailRecipients: emails,
		SlackChannelIDs: slack,
		TeamsWebhookIDs: teams,
		Enabled:         model.Enabled.ValueBool(),
	}, diags
}

// compliancePackScheduleStateFrom maps the stored schedule into state. The
// server always returns all three destination arrays, so a set the
// configuration omitted resolves to an empty one.
func compliancePackScheduleStateFrom(ctx context.Context, remote *iw.CompliancePackSchedule) (compliancePackScheduleResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	nonNil := func(v []string) []string {
		if v == nil {
			return []string{}
		}
		return v
	}
	emails, d := nilStringSet(ctx, nonNil(remote.EmailRecipients))
	diags.Append(d...)
	slack, d := nilStringSet(ctx, nonNil(remote.SlackChannelIDs))
	diags.Append(d...)
	teams, d := nilStringSet(ctx, nonNil(remote.TeamsWebhookIDs))
	diags.Append(d...)

	return compliancePackScheduleResourceModel{
		ID:              types.StringValue(remote.ID),
		FrameworkID:     types.StringValue(remote.FrameworkID),
		Cadence:         types.StringValue(remote.Cadence),
		SendDayOfMonth:  types.Int64Value(remote.SendDayOfMonth),
		Hour:            types.Int64Value(remote.Hour),
		Timezone:        types.StringValue(remote.Timezone),
		EmailRecipients: emails,
		SlackChannelIDs: slack,
		TeamsWebhookIDs: teams,
		Enabled:         types.BoolValue(remote.Enabled),
		NextSendAt:      stringValue(remote.NextSendAt),
		LastSentAt:      stringValue(remote.LastSentAt),
		LastStatus:      stringValue(remote.LastStatus),
		LastError:       stringValue(remote.LastError),
	}, diags
}
