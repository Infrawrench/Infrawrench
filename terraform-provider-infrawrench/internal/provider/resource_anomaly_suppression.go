package provider

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*anomalySuppressionResource)(nil)
	_ resource.ResourceWithConfigure      = (*anomalySuppressionResource)(nil)
	_ resource.ResourceWithImportState    = (*anomalySuppressionResource)(nil)
	_ resource.ResourceWithValidateConfig = (*anomalySuppressionResource)(nil)
	_ resource.ResourceWithModifyPlan     = (*anomalySuppressionResource)(nil)
)

// NewAnomalySuppressionResource constructs the infrawrench_anomaly_suppression
// resource.
func NewAnomalySuppressionResource() resource.Resource { return &anomalySuppressionResource{} }

type anomalySuppressionResource struct{ client *iw.Client }

// The closed enums the endpoint accepts.
var (
	anomalySuppressionScopes      = []string{"provider", "service", "account", "tag", "cost_centre"}
	anomalySuppressionRecurrences = []string{"one_off", "weekly", "monthly", "seasonal"}
	anomalyFeedbackReasons        = []string{"planned_launch", "migration", "seasonal", "pricing_change", "data_issue", "other"}
)

// anomalySuppressionMaxDays is the furthest expires_on may be from starts_on:
// three years, counting a leap day.
const anomalySuppressionMaxDays = 1096

// anomalySuppressionDatePattern is the calendar-date form the API accepts.
// Whether the date actually exists (no February 30th) is checked in
// ValidateConfig, which parses it.
var anomalySuppressionDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// trimmedPattern refuses leading and trailing whitespace. The server trims
// scope_key, tag_key and note before storing them, so a padded value would
// read back different from the configuration and diff on every plan.
var trimmedPattern = regexp.MustCompile(`(?s)^\S(.*\S)?$`)

type anomalySuppressionResourceModel struct {
	ID              types.String `tfsdk:"id"`
	Scope           types.String `tfsdk:"scope"`
	ScopeKey        types.String `tfsdk:"scope_key"`
	TagKey          types.String `tfsdk:"tag_key"`
	Recurrence      types.String `tfsdk:"recurrence"`
	AnchorDay       types.String `tfsdk:"anchor_day"`
	StartsOn        types.String `tfsdk:"starts_on"`
	ExpiresOn       types.String `tfsdk:"expires_on"`
	Reason          types.String `tfsdk:"reason"`
	Note            types.String `tfsdk:"note"`
	ScopeLabel      types.String `tfsdk:"scope_label"`
	SourceAnomalyID types.String `tfsdk:"source_anomaly_id"`
	CreatedByUserID types.String `tfsdk:"created_by_user_id"`
	CreatedByName   types.String `tfsdk:"created_by_name"`
	CreatedAt       types.String `tfsdk:"created_at"`
	UpdatedAt       types.String `tfsdk:"updated_at"`
	Active          types.Bool   `tfsdk:"active"`
	SuppressedCount types.Int64  `tfsdk:"suppressed_count"`
}

func (r *anomalySuppressionResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_anomaly_suppression"
}

func (r *anomalySuppressionResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	dateValidators := func() []validatorString {
		return []validatorString{
			stringvalidator.RegexMatches(anomalySuppressionDatePattern, "must be a calendar date in YYYY-MM-DD form"),
		}
	}
	trimmed := stringvalidator.RegexMatches(trimmedPattern,
		"must not be empty or start or end with whitespace (the server trims it, which would diff forever)")

	resp.Schema = schema.Schema{
		MarkdownDescription: "A declaration that spend in one scope is expected on a pattern of days until an " +
			"expiry: the launch week, the Monday batch job, the month-end close, Black Friday.\n\n" +
			"On a covered day, anomaly detection sets the scope's spend aside before judging the day. A " +
			"finding that only existed because of that spend is still stored, so the record stays " +
			"complete, but it is marked suppressed and nobody is alerted. A finding that survives (spend " +
			"beyond the expected slice) alerts as normal. Changes take effect on the next detection pass.\n\n" +
			"Suppressions also appear when somebody marks a detected anomaly `expected` in the app and asks " +
			"for the pattern to be suppressed; `source_anomaly_id` names that anomaly. Those can be imported, " +
			"but they are usually better left to whoever reviewed the finding.\n\n" +
			"An organization can hold at most 100 active (unexpired) suppressions; creating one past that " +
			"fails with a 409. An expired suppression is kept, with `active` false, so the app can still " +
			"show what it suppressed; it stays in state until you remove it from the configuration.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned suppression id. Use it with `terraform import`."),
			"scope": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "What the suppression covers. One of `" + joinBackticked(anomalySuppressionScopes) +
					"`.\n\n" +
					"`provider` and `service` are the two breakdowns detection judges; `account`, `tag` and " +
					"`cost_centre` are slices of spend that cut across them. The rule is the same for every " +
					"scope: on a covered day that slice is set aside before the day is judged.",
				Validators: []validatorString{oneOfValidator(anomalySuppressionScopes...)},
			},
			"scope_key": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The scope's value, 1-256 characters. What it takes depends on `scope`:\n\n" +
					"- `provider`: a plugin id such as `aws`. The `infrawrench_plugins` data source lists them.\n" +
					"- `service`: a service name exactly as the cost breakdown shows it, such as `Amazon EC2`.\n" +
					"- `account`: a connected account id. Reference an `infrawrench_account` resource's `id`, " +
					"or look one up by name with the `infrawrench_accounts` data source.\n" +
					"- `tag`: the tag **value**; the key goes in `tag_key`.\n" +
					"- `cost_centre`: a cost centre id. Reference an `infrawrench_cost_centre` resource's `id`, " +
					"or look one up by name with the `infrawrench_cost_centres` data source.\n\n" +
					"Accounts and cost centres must belong to the organization. Leading and trailing " +
					"whitespace is refused, because the server trims it.",
				Validators: []validatorString{stringvalidator.LengthBetween(1, 256), trimmed},
			},
			"tag_key": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The tag key, 1-256 characters. Required when `scope` is `tag`, and refused " +
					"for every other scope (the server stores null there, which would diff forever).",
				Validators: []validatorString{stringvalidator.LengthBetween(1, 256), trimmed},
			},
			"recurrence": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "How the suppression repeats between `starts_on` and `expires_on`. One of `" +
					joinBackticked(anomalySuppressionRecurrences) + "`.\n\n" +
					"- `one_off`: every day in the window. A migration, a launch week, a load test.\n" +
					"- `weekly`: `anchor_day`'s weekday, every week. A Monday batch job.\n" +
					"- `monthly`: `anchor_day`'s day of the month, give or take a day, because billing runs " +
					"drift around month ends and weekends. An anchor past the end of a shorter month falls on " +
					"its last day. A month-end close.\n" +
					"- `seasonal`: `anchor_day`'s calendar date, give or take three days, every year. Black " +
					"Friday, a yearly renewal.",
				Validators: []validatorString{oneOfValidator(anomalySuppressionRecurrences...)},
			},
			"anchor_day": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The day the pattern is anchored to, as `YYYY-MM-DD`: its weekday for " +
					"`weekly`, its day of the month for `monthly`, its calendar date for `seasonal`. For " +
					"`one_off` it only supplies the default `starts_on`.",
				Validators: dateValidators(),
			},
			"starts_on": schema.StringAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "First day covered, as `YYYY-MM-DD`. Omit it to start on `anchor_day`, " +
					"which is what the server does with an absent value; the plan shows that day rather than " +
					"leaving it unknown.",
				Validators: dateValidators(),
			},
			"expires_on": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Last day covered, as `YYYY-MM-DD`, inclusive. Not before `starts_on`, and " +
					"at most 1096 days (three years) after it. A suppression has an expiry on purpose: a key " +
					"that should never alert again is a threshold question, not a suppression.",
				Validators: dateValidators(),
			},
			"reason": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Why the spend is expected, for filtering and for the precision report. One " +
					"of `" + joinBackticked(anomalyFeedbackReasons) + "`, or omitted for none.",
				Validators: []validatorString{oneOfValidator(anomalyFeedbackReasons...)},
			},
			"note": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Free-text context, 1-500 characters, or omitted for none. Leading and " +
					"trailing whitespace is refused, because the server trims it and stores an empty note " +
					"as none.",
				Validators: []validatorString{stringvalidator.LengthBetween(1, 500), trimmed},
			},
			"scope_label": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The account or cost centre name for id-valued scopes; null for the " +
					"others, or when the id no longer resolves.",
			},
			"source_anomaly_id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The anomaly whose `expected` verdict created this suppression, or null for " +
					"one made by hand, which is every suppression Terraform creates.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"created_by_user_id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The user who created the suppression, when known.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"created_by_name": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Display name (or email) of whoever created it, when they are still known.",
			},
			"created_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "RFC 3339 timestamp of creation.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"updated_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "RFC 3339 timestamp of the last change.",
			},
			"active": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether it still covers today or a later day. Becomes `false` once " +
					"`expires_on` has passed; the object is not deleted.",
			},
			"suppressed_count": schema.Int64Attribute{
				Computed:            true,
				MarkdownDescription: "How many detected findings it has suppressed so far.",
			},
		},
	}
}

func (r *anomalySuppressionResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// ValidateConfig enforces the rules that span attributes, all of which the
// server would otherwise reject with a 400 mid-apply: a tag key exactly when the
// scope is a tag, real calendar dates, and an expiry that is neither before the
// start nor more than three years after it.
//
// Unknown values are skipped: a date that comes from another resource's output
// is not computed yet at validate time, and the server still checks it.
func (r *anomalySuppressionResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config anomalySuppressionResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if !config.Scope.IsNull() && !config.Scope.IsUnknown() {
		isTag := config.Scope.ValueString() == "tag"
		if isTag && config.TagKey.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("tag_key"), "Missing tag key",
				"A suppression with scope \"tag\" needs tag_key; scope_key then holds the tag value.")
		}
		if !isTag && !config.TagKey.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("tag_key"), "Unexpected tag key",
				"tag_key only applies when scope is \"tag\". The server discards it for any other scope, "+
					"which would show as a diff on every plan.")
		}
	}

	parse := func(attr string, v types.String) (time.Time, bool) {
		if v.IsNull() || v.IsUnknown() || !anomalySuppressionDatePattern.MatchString(v.ValueString()) {
			// A malformed value is already reported by the attribute's own
			// validator.
			return time.Time{}, false
		}
		t, err := time.Parse(time.DateOnly, v.ValueString())
		if err != nil {
			resp.Diagnostics.AddAttributeError(path.Root(attr), "Invalid date",
				fmt.Sprintf("%q is not a calendar date.", v.ValueString()))
			return time.Time{}, false
		}
		return t, true
	}

	anchor, anchorOK := parse("anchor_day", config.AnchorDay)
	start, startOK := parse("starts_on", config.StartsOn)
	expires, expiresOK := parse("expires_on", config.ExpiresOn)
	if config.StartsOn.IsNull() {
		start, startOK = anchor, anchorOK
	}
	if !startOK || !expiresOK {
		return
	}
	if expires.Before(start) {
		resp.Diagnostics.AddAttributeError(path.Root("expires_on"), "Expiry before start",
			"expires_on must be on or after starts_on (which defaults to anchor_day).")
		return
	}
	if days := int(expires.Sub(start).Hours() / 24); days > anomalySuppressionMaxDays {
		resp.Diagnostics.AddAttributeError(path.Root("expires_on"), "Suppression too long",
			fmt.Sprintf("A suppression can last at most %d days (three years) after starts_on; this one is %d.",
				anomalySuppressionMaxDays, days))
	}
}

// ModifyPlan fills an omitted starts_on with anchor_day, which is exactly what
// the server stores. Without it the attribute would plan as unknown on every
// change, and UseStateForUnknown would be wrong: after anchor_day changes, the
// stored start moves with it.
func (r *anomalySuppressionResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.Plan.Raw.IsNull() {
		return
	}
	var configStart types.String
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("starts_on"), &configStart)...)
	var anchor types.String
	resp.Diagnostics.Append(req.Plan.GetAttribute(ctx, path.Root("anchor_day"), &anchor)...)
	if resp.Diagnostics.HasError() || !configStart.IsNull() || anchor.IsUnknown() || anchor.IsNull() {
		return
	}
	resp.Diagnostics.Append(resp.Plan.SetAttribute(ctx, path.Root("starts_on"), anchor)...)
}

func (r *anomalySuppressionResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan anomalySuppressionResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateAnomalySuppression(ctx, anomalySuppressionInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to create anomaly suppression", err.Error())
		return
	}

	state := anomalySuppressionStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *anomalySuppressionResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state anomalySuppressionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAnomalySuppression(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read anomaly suppression", err.Error())
		return
	}

	refreshed := anomalySuppressionStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *anomalySuppressionResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan anomalySuppressionResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state anomalySuppressionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateAnomalySuppression(ctx, state.ID.ValueString(), anomalySuppressionInputFrom(plan))
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Anomaly suppression no longer exists",
				"The suppression was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update anomaly suppression", err.Error())
		return
	}

	next := anomalySuppressionStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *anomalySuppressionResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state anomalySuppressionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteAnomalySuppression(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete anomaly suppression", err.Error())
	}
}

func (r *anomalySuppressionResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// anomalySuppressionInputFrom maps the plan onto the POST/PUT body. PUT is a
// full replace, so reason and note go as explicit nulls when unset; starts_on
// has been filled from anchor_day by ModifyPlan, and is sent only when known.
func anomalySuppressionInputFrom(model anomalySuppressionResourceModel) iw.CostAnomalySuppressionInput {
	return iw.CostAnomalySuppressionInput{
		Scope:      model.Scope.ValueString(),
		ScopeKey:   model.ScopeKey.ValueString(),
		TagKey:     stringPtr(model.TagKey),
		Recurrence: model.Recurrence.ValueString(),
		AnchorDay:  model.AnchorDay.ValueString(),
		StartsOn:   stringPtr(model.StartsOn),
		ExpiresOn:  model.ExpiresOn.ValueString(),
		Reason:     stringPtr(model.Reason),
		Note:       stringPtr(model.Note),
	}
}

func anomalySuppressionStateFrom(remote *iw.CostAnomalySuppression) anomalySuppressionResourceModel {
	return anomalySuppressionResourceModel{
		ID:              types.StringValue(remote.ID),
		Scope:           types.StringValue(remote.Scope),
		ScopeKey:        types.StringValue(remote.ScopeKey),
		TagKey:          stringValue(remote.TagKey),
		Recurrence:      types.StringValue(remote.Recurrence),
		AnchorDay:       types.StringValue(remote.AnchorDay),
		StartsOn:        types.StringValue(remote.StartsOn),
		ExpiresOn:       types.StringValue(remote.ExpiresOn),
		Reason:          stringValue(remote.Reason),
		Note:            stringValue(remote.Note),
		ScopeLabel:      stringValue(remote.ScopeLabel),
		SourceAnomalyID: stringValue(remote.SourceAnomalyID),
		CreatedByUserID: stringValue(remote.CreatedByUserID),
		CreatedByName:   stringValue(remote.CreatedByName),
		CreatedAt:       types.StringValue(remote.CreatedAt),
		UpdatedAt:       types.StringValue(remote.UpdatedAt),
		Active:          types.BoolValue(remote.Active),
		SuppressedCount: types.Int64Value(remote.SuppressedCount),
	}
}
