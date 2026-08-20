package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*alertRoutingResource)(nil)
	_ resource.ResourceWithConfigure   = (*alertRoutingResource)(nil)
	_ resource.ResourceWithImportState = (*alertRoutingResource)(nil)
)

// NewAlertRoutingResource constructs the infrawrench_alert_routing resource.
func NewAlertRoutingResource() resource.Resource { return &alertRoutingResource{} }

type alertRoutingResource struct{ client *iw.Client }

// alertRoutingResourceModel is the organization's whole ordered rule list.
//
// One resource holding every rule, rather than one resource per rule, because
// order *is* the semantics: the list is first-match-wins unless a rule tees, so
// a rule cannot be written without stating where it sits relative to the others.
// Per-rule resources would have had to invent a position attribute and then
// defend it against two configurations claiming the same slot.
type alertRoutingResourceModel struct {
	ID    types.String `tfsdk:"id"`
	Rule  types.List   `tfsdk:"rule"`
	Rules types.Int64  `tfsdk:"rule_count"`
}

type alertRuleModel struct {
	ID              types.String `tfsdk:"id"`
	Name            types.String `tfsdk:"name"`
	Enabled         types.Bool   `tfsdk:"enabled"`
	ContinueOnMatch types.Bool   `tfsdk:"continue_on_match"`
	Condition       types.List   `tfsdk:"condition"`
	Destination     types.List   `tfsdk:"destination"`
	QuietHours      types.Object `tfsdk:"quiet_hours"`
	Escalation      types.Object `tfsdk:"escalation"`
}

type alertConditionModel struct {
	Field    types.String `tfsdk:"field"`
	Op       types.String `tfsdk:"op"`
	Values   types.List   `tfsdk:"values"`
	Severity types.String `tfsdk:"severity"`
	Cents    types.Int64  `tfsdk:"cents"`
	Value    types.String `tfsdk:"value"`
}

type alertDestinationModel struct {
	Kind       types.String `tfsdk:"kind"`
	ChannelID  types.String `tfsdk:"channel_id"`
	WebhookID  types.String `tfsdk:"webhook_id"`
	ScheduleID types.String `tfsdk:"schedule_id"`
}

type alertQuietHoursModel struct {
	Timezone       types.String `tfsdk:"timezone"`
	StartMinute    types.Int64  `tfsdk:"start_minute"`
	EndMinute      types.Int64  `tfsdk:"end_minute"`
	Days           types.List   `tfsdk:"days"`
	UrgentOverride types.String `tfsdk:"urgent_override"`
}

type alertEscalationModel struct {
	AfterMinutes types.Int64 `tfsdk:"after_minutes"`
	Destination  types.List  `tfsdk:"destination"`
}

var alertConditionAttrTypes = map[string]attr.Type{
	"field":    types.StringType,
	"op":       types.StringType,
	"values":   types.ListType{ElemType: types.StringType},
	"severity": types.StringType,
	"cents":    types.Int64Type,
	"value":    types.StringType,
}

var alertDestinationAttrTypes = map[string]attr.Type{
	"kind":        types.StringType,
	"channel_id":  types.StringType,
	"webhook_id":  types.StringType,
	"schedule_id": types.StringType,
}

var (
	alertConditionObjectType   = types.ObjectType{AttrTypes: alertConditionAttrTypes}
	alertDestinationObjectType = types.ObjectType{AttrTypes: alertDestinationAttrTypes}
)

var alertQuietHoursAttrTypes = map[string]attr.Type{
	"timezone":        types.StringType,
	"start_minute":    types.Int64Type,
	"end_minute":      types.Int64Type,
	"days":            types.ListType{ElemType: types.Int64Type},
	"urgent_override": types.StringType,
}

var alertEscalationAttrTypes = map[string]attr.Type{
	"after_minutes": types.Int64Type,
	"destination":   types.ListType{ElemType: alertDestinationObjectType},
}

var (
	alertQuietHoursObjectType = types.ObjectType{AttrTypes: alertQuietHoursAttrTypes}
	alertEscalationObjectType = types.ObjectType{AttrTypes: alertEscalationAttrTypes}
)

var alertRuleAttrTypes = map[string]attr.Type{
	"id":                types.StringType,
	"name":              types.StringType,
	"enabled":           types.BoolType,
	"continue_on_match": types.BoolType,
	"condition":         types.ListType{ElemType: alertConditionObjectType},
	"destination":       types.ListType{ElemType: alertDestinationObjectType},
	"quiet_hours":       alertQuietHoursObjectType,
	"escalation":        alertEscalationObjectType,
}

var alertRuleObjectType = types.ObjectType{AttrTypes: alertRuleAttrTypes}

var (
	alertConditionFields = []string{
		"trigger", "severity", "accountId", "pluginId", "resourceTypeId", "amountCents", "key", "text",
	}
	alertConditionOps = []string{
		"in", "notIn", "gte", "eq", "lt", "contains", "notContains",
	}
	alertSeverities      = []string{"info", "warning", "critical"}
	alertDestinationKind = []string{"push", "slack", "msteams", "on-call"}
	alertTriggers        = []string{
		"syncIncidents", "budgetAlerts", "anomalyAlerts", "costChangeAlerts", "commitmentExpiryAlerts",
		"commitmentIdleAlerts", "unitCostRegressionAlerts", "metricAlerts", "resourceDrift", "workflowPages",
		"providerIncidents", "expiryAlerts", "logMatchAlerts", "postureAlerts", "probeAlerts", "weeklyDigest",
	}
)

func (r *alertRoutingResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_alert_routing"
}

func (r *alertRoutingResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The organization's alert routing table: which alerts go to which Slack channels, " +
			"Teams webhooks and phones.\n\n" +
			"**One resource holds every rule, in order**, because order is the semantics. The list is " +
			"evaluated top to bottom and is first-match-wins unless a rule sets `continue_on_match`, which " +
			"is what lets a narrow rule sit above a broad one. A rule cannot meaningfully be written " +
			"without saying where it sits, so per-rule resources would have had to invent a position " +
			"attribute and then defend it against two configurations claiming the same slot.\n\n" +
			"An organization **singleton**. `terraform destroy` restores the built-in default ruleset " +
			"rather than leaving the organization with no rules at all — an organization that routes " +
			"nothing is a worse state than the default, and is not what removing a resource block should " +
			"mean.\n\n" +
			"An organization that has saved nothing still reads back a full synthesized rule list, so a " +
			"first `terraform plan` against a fresh organization shows your rules replacing the defaults " +
			"rather than being added to an empty table.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Alert routing"),
			"rule_count": schema.Int64Attribute{
				Computed:            true,
				MarkdownDescription: "How many rules the table holds. A cheap guard in a `precondition`.",
			},
		},
		Blocks: map[string]schema.Block{
			"rule": schema.ListNestedBlock{
				MarkdownDescription: "One routing rule. Order is evaluation order.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed: true,
							MarkdownDescription: "Server-assigned rule id. Sent back on every write so that " +
								"in-flight held and escalating deliveries keep pointing at their rule across a " +
								"rewrite of the list.\n\n" +
								"Inserting a rule in the middle shifts the ids of everything below it by one " +
								"position, which is inherent to modelling an ordered list as blocks: the plan " +
								"will show those rules as changed even though their content did not.",
						},
						"name": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Display name, up to 80 characters.",
						},
						"enabled": schema.BoolAttribute{
							Optional: true,
							Computed: true,
							Default:  booldefault.StaticBool(true),
							MarkdownDescription: "A disabled rule is skipped entirely — it neither delivers nor " +
								"shadows the rules below it.",
						},
						"continue_on_match": schema.BoolAttribute{
							Optional: true,
							Computed: true,
							Default:  booldefault.StaticBool(false),
							MarkdownDescription: "`false` (the default) makes the list first-match-wins. `true` " +
								"makes the rule a tee: it delivers and evaluation carries on down the list.",
						},
					},
					Blocks: map[string]schema.Block{
						"condition": schema.ListNestedBlock{
							MarkdownDescription: "A clause. A rule matches when **every** condition matches; " +
								"\"or\" is expressed by writing a second rule.\n\n" +
								"A condition on a fact the alert does not carry never matches — in either " +
								"direction, so `accountId notIn [x]` does **not** match an alert with no account. " +
								"A rule with no conditions matches everything.",
							NestedObject: schema.NestedBlockObject{
								Attributes: map[string]schema.Attribute{
									"field": schema.StringAttribute{
										Required: true,
										MarkdownDescription: "One of `" + joinBackticked(alertConditionFields) + "`. " +
											"Which of the value attributes below applies depends on it: `severity` " +
											"takes `severity`, `amountCents` takes `cents`, `key` and `text` take " +
											"`value`, and the rest take `values`.",
										Validators: []validatorString{oneOfValidator(alertConditionFields...)},
									},
									"op": schema.StringAttribute{
										Required: true,
										MarkdownDescription: "The comparison. `in`/`notIn` for the list fields, " +
											"`gte`/`eq` for `severity`, `gte`/`lt` for `amountCents`, " +
											"`contains`/`notContains`/`eq` for `key`, `contains`/`notContains` for " +
											"`text`.",
										Validators: []validatorString{oneOfValidator(alertConditionOps...)},
									},
									"values": schema.ListAttribute{
										Optional:    true,
										ElementType: types.StringType,
										MarkdownDescription: "For `trigger`, `accountId`, `pluginId` and " +
											"`resourceTypeId`. Trigger values are one of `" +
											joinBackticked(alertTriggers) + "`.",
									},
									"severity": schema.StringAttribute{
										Optional: true,
										MarkdownDescription: "For `field = \"severity\"`. One of `" +
											joinBackticked(alertSeverities) + "`, ordered info < warning < critical.",
										Validators: []validatorString{oneOfValidator(alertSeverities...)},
									},
									"cents": schema.Int64Attribute{
										Optional: true,
										MarkdownDescription: "For `field = \"amountCents\"` — the money the alert " +
											"is about, in cents.",
										Validators: []validatorInt64{atLeast(0)},
									},
									"value": schema.StringAttribute{
										Optional:            true,
										MarkdownDescription: "For `field = \"key\"` or `field = \"text\"`.",
									},
								},
							},
						},
						"destination": schema.ListNestedBlock{
							MarkdownDescription: "Where a matched alert goes.\n\n" +
								"**Empty is legal and meaningful**: an enabled rule with no destinations swallows " +
								"matching alerts and shadows the rules below it, which is how you silence a " +
								"category without deleting the rules that would otherwise catch it.",
							NestedObject: schema.NestedBlockObject{
								Attributes: map[string]schema.Attribute{
									"kind": schema.StringAttribute{
										Required: true,
										MarkdownDescription: "One of `" + joinBackticked(alertDestinationKind) + "`. " +
											"`push` reaches the organization's phones, still filtered by each " +
											"member's own mutes — an organization rule decides whether the org is " +
											"told, a member decides whether their phone rings.",
										Validators: []validatorString{oneOfValidator(alertDestinationKind...)},
									},
									"channel_id": schema.StringAttribute{
										Optional: true,
										MarkdownDescription: "Required when `kind` is `slack`: the `id` of an " +
											"`infrawrench_slack_channel`.",
									},
									"webhook_id": schema.StringAttribute{
										Optional: true,
										MarkdownDescription: "Required when `kind` is `msteams`: the `id` of an " +
											"`infrawrench_msteams_webhook`.",
									},
									"schedule_id": schema.StringAttribute{
										Optional: true,
										MarkdownDescription: "Required when `kind` is `on-call`: the `id` of an " +
											"`infrawrench_on_call_schedule`. The rule then reaches whoever is " +
											"holding that rotation when the alert fires, rather than a person " +
											"named when the rule was written. A disabled rotation contributes " +
											"nobody and the rule's other destinations still deliver.",
									},
								},
							},
						},
						"quiet_hours": schema.SingleNestedBlock{
							MarkdownDescription: "A recurring local-time window during which the rule **holds** its " +
								"alerts. Held, not dropped: a held alert is queued and delivered when the window " +
								"closes.\n\n" +
								"Omit the block for a rule that never holds anything.",
							Attributes: map[string]schema.Attribute{
								"timezone": schema.StringAttribute{
									Optional:            true,
									MarkdownDescription: "IANA zone the window's minutes are read in, e.g. `Europe/Berlin`.",
								},
								"start_minute": schema.Int64Attribute{
									Optional:            true,
									MarkdownDescription: "Minute of the day the window opens, 0–1439.",
									Validators:          []validatorInt64{between(0, 1439)},
								},
								"end_minute": schema.Int64Attribute{
									Optional: true,
									MarkdownDescription: "Minute of the day the window closes, 0–1439. May be **less " +
										"than** `start_minute` for an overnight window; equal means the window is empty.",
									Validators: []validatorInt64{between(0, 1439)},
								},
								"days": schema.ListAttribute{
									Optional:    true,
									ElementType: types.Int64Type,
									MarkdownDescription: "ISO weekdays the window applies on, matched against the day " +
										"the window opened. Omit or leave empty for every day.",
									Validators: []validatorList{elementsBetween(1, 7)},
								},
								"urgent_override": schema.StringAttribute{
									Optional: true,
									MarkdownDescription: "Severity at or above which quiet hours do **not** apply, one " +
										"of `" + joinBackticked(alertSeverities) + "`. Omit it to hold everything.",
									Validators: []validatorString{oneOfValidator(alertSeverities...)},
								},
							},
						},
						"escalation": schema.SingleNestedBlock{
							MarkdownDescription: "Notify a second set of destinations if nobody acknowledges within " +
								"`after_minutes`.\n\n" +
								"Acknowledgement comes from the button on the Slack message, so a rule routed only " +
								"to Teams or to push will **always** escalate. Omit the block for a rule that " +
								"never escalates.",
							Attributes: map[string]schema.Attribute{
								"after_minutes": schema.Int64Attribute{
									Optional:            true,
									MarkdownDescription: "Minutes to wait for an acknowledgement, 1–10080.",
									Validators:          []validatorInt64{between(1, 10080)},
								},
							},
							Blocks: map[string]schema.Block{
								"destination": schema.ListNestedBlock{
									MarkdownDescription: "Where the escalation goes. Same shape as a rule's own " +
										"destinations.",
									NestedObject: schema.NestedBlockObject{
										Attributes: map[string]schema.Attribute{
											"kind": schema.StringAttribute{
												Required:            true,
												MarkdownDescription: "One of `" + joinBackticked(alertDestinationKind) + "`.",
												Validators:          []validatorString{oneOfValidator(alertDestinationKind...)},
											},
											"channel_id": schema.StringAttribute{
												Optional:            true,
												MarkdownDescription: "Required when `kind` is `slack`.",
											},
											"webhook_id": schema.StringAttribute{
												Optional:            true,
												MarkdownDescription: "Required when `kind` is `msteams`.",
											},
											"schedule_id": schema.StringAttribute{
												Optional:            true,
												MarkdownDescription: "Required when `kind` is `on-call`.",
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	}
}

func (r *alertRoutingResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *alertRoutingResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan alertRoutingResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *alertRoutingResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state alertRoutingResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAlertRules(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read alert routing", err.Error())
		return
	}

	refreshed, diags := alertRoutingStateFrom(ctx, r.client.OrgID(), remote.Rules)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *alertRoutingResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan alertRoutingResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete restores the built-in defaults. See the schema description for why it
// does not clear the table.
func (r *alertRoutingResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if err := r.client.AdoptAlertRuleDefaults(ctx); err != nil {
		resp.Diagnostics.AddError("Unable to restore the default alert routing", err.Error())
	}
}

func (r *alertRoutingResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *alertRoutingResource) write(ctx context.Context, plan alertRoutingResourceModel, diags *diagnostics, state *tfState) {
	rules, d := alertRulesFrom(ctx, plan.Rule)
	diags.Append(d...)
	if diags.HasError() {
		return
	}

	saved, err := r.client.PutAlertRules(ctx, rules)
	if err != nil {
		diags.AddError("Unable to write alert routing", err.Error())
		return
	}

	next, d := alertRoutingStateFrom(ctx, r.client.OrgID(), saved)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

/* -------------------------------- mapping --------------------------------- */

// alertRulesFrom maps the rule blocks onto the PUT body.
//
// A rule's id is sent back when state already has one, which is what preserves
// in-flight deliveries across a rewrite. On the first apply every id is unknown
// and is simply omitted, and the server mints them.
func alertRulesFrom(ctx context.Context, list types.List) ([]iw.AlertRuleInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	out := []iw.AlertRuleInput{}
	if list.IsNull() || list.IsUnknown() {
		return out, diags
	}

	var blocks []alertRuleModel
	diags.Append(list.ElementsAs(ctx, &blocks, false)...)
	if diags.HasError() {
		return out, diags
	}

	for _, b := range blocks {
		conditions, d := alertConditionsFrom(ctx, b.Condition)
		diags.Append(d...)
		destinations, d := alertDestinationsFrom(ctx, b.Destination)
		diags.Append(d...)
		quietHours, d := alertQuietHoursFrom(ctx, b.QuietHours)
		diags.Append(d...)
		escalation, d := alertEscalationFrom(ctx, b.Escalation)
		diags.Append(d...)
		if diags.HasError() {
			return out, diags
		}

		out = append(out, iw.AlertRuleInput{
			ID:              stringPtr(b.ID),
			Name:            b.Name.ValueString(),
			Enabled:         boolPtr(b.Enabled),
			Conditions:      conditions,
			Destinations:    destinations,
			ContinueOnMatch: boolPtr(b.ContinueOnMatch),
			QuietHours:      quietHours,
			Escalation:      escalation,
		})
	}
	return out, diags
}

// alertQuietHoursFrom reads the optional quiet-hours block.
//
// Both this and alertEscalationFrom must be wired through, not skipped: the
// replacement route normalises an omitted `quietHours` to an explicit null, so a
// provider that dropped the field would silently delete a window configured in
// the app on the very next apply.
func alertQuietHoursFrom(ctx context.Context, obj types.Object) (*iw.QuietHours, diag.Diagnostics) {
	var diags diag.Diagnostics
	if obj.IsNull() || obj.IsUnknown() {
		return nil, diags
	}

	var model alertQuietHoursModel
	diags.Append(obj.As(ctx, &model, basetypes.ObjectAsOptions{})...)
	if diags.HasError() {
		return nil, diags
	}

	days, d := int64Slice(ctx, model.Days)
	diags.Append(d...)
	if diags.HasError() {
		return nil, diags
	}

	return &iw.QuietHours{
		Timezone:       model.Timezone.ValueString(),
		StartMinute:    model.StartMinute.ValueInt64(),
		EndMinute:      model.EndMinute.ValueInt64(),
		Days:           days,
		UrgentOverride: stringPtr(model.UrgentOverride),
	}, diags
}

// alertEscalationFrom reads the optional escalation block.
func alertEscalationFrom(ctx context.Context, obj types.Object) (*iw.EscalationPolicy, diag.Diagnostics) {
	var diags diag.Diagnostics
	if obj.IsNull() || obj.IsUnknown() {
		return nil, diags
	}

	var model alertEscalationModel
	diags.Append(obj.As(ctx, &model, basetypes.ObjectAsOptions{})...)
	if diags.HasError() {
		return nil, diags
	}

	destinations, d := alertDestinationsFrom(ctx, model.Destination)
	diags.Append(d...)
	if diags.HasError() {
		return nil, diags
	}

	return &iw.EscalationPolicy{
		AfterMinutes: model.AfterMinutes.ValueInt64(),
		Destinations: destinations,
	}, diags
}

func alertConditionsFrom(ctx context.Context, list types.List) ([]iw.AlertCondition, diag.Diagnostics) {
	var diags diag.Diagnostics

	out := []iw.AlertCondition{}
	if list.IsNull() || list.IsUnknown() {
		return out, diags
	}

	var blocks []alertConditionModel
	diags.Append(list.ElementsAs(ctx, &blocks, false)...)
	if diags.HasError() {
		return out, diags
	}

	for _, b := range blocks {
		values, d := stringSlice(ctx, b.Values)
		diags.Append(d...)
		if diags.HasError() {
			return out, diags
		}
		out = append(out, iw.AlertCondition{
			Field:    b.Field.ValueString(),
			Op:       b.Op.ValueString(),
			Values:   values,
			Severity: stringPtr(b.Severity),
			Cents:    int64Ptr(b.Cents),
			Value:    stringPtr(b.Value),
		})
	}
	return out, diags
}

func alertDestinationsFrom(ctx context.Context, list types.List) ([]iw.AlertDestination, diag.Diagnostics) {
	var diags diag.Diagnostics

	out := []iw.AlertDestination{}
	if list.IsNull() || list.IsUnknown() {
		return out, diags
	}

	var blocks []alertDestinationModel
	diags.Append(list.ElementsAs(ctx, &blocks, false)...)
	if diags.HasError() {
		return out, diags
	}

	for _, b := range blocks {
		out = append(out, iw.AlertDestination{
			Kind:       b.Kind.ValueString(),
			ChannelID:  stringPtr(b.ChannelID),
			WebhookID:  stringPtr(b.WebhookID),
			ScheduleID: stringPtr(b.ScheduleID),
		})
	}
	return out, diags
}

// alertRoutingStateFrom maps the stored rule list back into blocks.
//
// `position` is dropped: it is the list's own index, so storing it would be
// recording the same fact twice and inviting the two to disagree. Everything
// else the route carries is surfaced, quiet hours and escalation included —
// anything this resource failed to read back would be written away as null on
// the next apply, because the write is a whole-list replacement.
func alertRoutingStateFrom(ctx context.Context, orgID string, rules []iw.AlertRule) (alertRoutingResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	blocks := make([]alertRuleModel, 0, len(rules))
	for _, rule := range rules {
		conditions := make([]alertConditionModel, 0, len(rule.Conditions))
		for _, c := range rule.Conditions {
			values, d := nilStringList(ctx, c.Values)
			diags.Append(d...)
			conditions = append(conditions, alertConditionModel{
				Field:    types.StringValue(c.Field),
				Op:       types.StringValue(c.Op),
				Values:   values,
				Severity: stringValue(c.Severity),
				Cents:    int64Value(c.Cents),
				Value:    stringValue(c.Value),
			})
		}
		conditionList, d := types.ListValueFrom(ctx, alertConditionObjectType, conditions)
		diags.Append(d...)

		destinations := make([]alertDestinationModel, 0, len(rule.Destinations))
		for _, dest := range rule.Destinations {
			destinations = append(destinations, alertDestinationModel{
				Kind:       types.StringValue(dest.Kind),
				ChannelID:  stringValue(dest.ChannelID),
				WebhookID:  stringValue(dest.WebhookID),
				ScheduleID: stringValue(dest.ScheduleID),
			})
		}
		destinationList, d := types.ListValueFrom(ctx, alertDestinationObjectType, destinations)
		diags.Append(d...)

		quietHours, d := alertQuietHoursTo(ctx, rule.QuietHours)
		diags.Append(d...)
		escalation, d := alertEscalationTo(ctx, rule.Escalation)
		diags.Append(d...)

		blocks = append(blocks, alertRuleModel{
			ID:              types.StringValue(rule.ID),
			Name:            types.StringValue(rule.Name),
			Enabled:         types.BoolValue(rule.Enabled),
			ContinueOnMatch: types.BoolValue(rule.ContinueOnMatch),
			Condition:       conditionList,
			Destination:     destinationList,
			QuietHours:      quietHours,
			Escalation:      escalation,
		})
	}

	list, d := types.ListValueFrom(ctx, alertRuleObjectType, blocks)
	diags.Append(d...)

	return alertRoutingResourceModel{
		ID:    types.StringValue(orgID),
		Rule:  list,
		Rules: types.Int64Value(int64(len(rules))),
	}, diags
}

// alertQuietHoursTo renders a stored quiet-hours window back into its block. A
// rule without one gets a null object, which is how an omitted block reads.
func alertQuietHoursTo(ctx context.Context, quiet *iw.QuietHours) (types.Object, diag.Diagnostics) {
	var diags diag.Diagnostics
	if quiet == nil {
		return types.ObjectNull(alertQuietHoursAttrTypes), diags
	}

	// `days` distinguishes nil from empty for the same reason the condition
	// clauses do: an empty list means every day, and a configuration that spells
	// it out must not read back as null.
	days, d := int64ListOrNull(ctx, quiet.Days)
	diags.Append(d...)
	if diags.HasError() {
		return types.ObjectNull(alertQuietHoursAttrTypes), diags
	}

	obj, d := types.ObjectValueFrom(ctx, alertQuietHoursAttrTypes, alertQuietHoursModel{
		Timezone:       types.StringValue(quiet.Timezone),
		StartMinute:    types.Int64Value(quiet.StartMinute),
		EndMinute:      types.Int64Value(quiet.EndMinute),
		Days:           days,
		UrgentOverride: stringValue(quiet.UrgentOverride),
	})
	diags.Append(d...)
	return obj, diags
}

// alertEscalationTo renders a stored escalation policy back into its block.
func alertEscalationTo(ctx context.Context, escalation *iw.EscalationPolicy) (types.Object, diag.Diagnostics) {
	var diags diag.Diagnostics
	if escalation == nil {
		return types.ObjectNull(alertEscalationAttrTypes), diags
	}

	destinations := make([]alertDestinationModel, 0, len(escalation.Destinations))
	for _, dest := range escalation.Destinations {
		destinations = append(destinations, alertDestinationModel{
			Kind:       types.StringValue(dest.Kind),
			ChannelID:  stringValue(dest.ChannelID),
			WebhookID:  stringValue(dest.WebhookID),
			ScheduleID: stringValue(dest.ScheduleID),
		})
	}
	list, d := types.ListValueFrom(ctx, alertDestinationObjectType, destinations)
	diags.Append(d...)
	if diags.HasError() {
		return types.ObjectNull(alertEscalationAttrTypes), diags
	}

	obj, d := types.ObjectValueFrom(ctx, alertEscalationAttrTypes, alertEscalationModel{
		AfterMinutes: types.Int64Value(escalation.AfterMinutes),
		Destination:  list,
	})
	diags.Append(d...)
	return obj, diags
}
