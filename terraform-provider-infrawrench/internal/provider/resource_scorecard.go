package provider

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"slices"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*scorecardResource)(nil)
	_ resource.ResourceWithConfigure      = (*scorecardResource)(nil)
	_ resource.ResourceWithImportState    = (*scorecardResource)(nil)
	_ resource.ResourceWithValidateConfig = (*scorecardResource)(nil)
)

// NewScorecardResource constructs the infrawrench_scorecard resource.
func NewScorecardResource() resource.Resource { return &scorecardResource{} }

type scorecardResource struct{ client *iw.Client }

// The API's limits (SCORECARD_LIMITS in client-core).
const (
	scorecardNameMaxLength        = 120
	scorecardDescriptionMaxLength = 1000
	scorecardMaxChecks            = 30
	scorecardMinWeight            = 1
	scorecardMaxWeight            = 10
	scorecardMaxLevels            = 6
	scorecardLevelNameMaxLength   = 40
	scorecardCheckNameMaxLength   = 120
)

var (
	// scorecardCheckTypes is SCORECARD_CHECK_TYPES in client-core, in the
	// order the editors offer them.
	scorecardCheckTypes = []string{
		"has_owner", "has_on_call", "slo_within_budget", "has_runbook", "backups_verified",
		"no_critical_posture", "no_orphans", "required_tags", "cost_within_budget",
		"no_critical_vulnerabilities", "change_failure_rate",
	}
	scorecardSeverities = []string{"critical", "high", "medium", "low"}

	// scorecardParamTypes says which check types each typed parameter
	// attribute belongs to. A parameter on any other type is a plan error.
	scorecardParamTypes = map[string][]string{
		"min_budget_remaining_percent": {"slo_within_budget"},
		"drill_within_days":            {"backups_verified"},
		"severities":                   {"no_critical_posture", "no_critical_vulnerabilities"},
		"tags":                         {"required_tags"},
		"max_failure_rate_percent":     {"change_failure_rate"},
		"window_days":                  {"change_failure_rate"},
	}

	scorecardLevelKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
	scorecardColorPattern    = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

type scorecardResourceModel struct {
	ID               types.String `tfsdk:"id"`
	Name             types.String `tfsdk:"name"`
	Description      types.String `tfsdk:"description"`
	Enabled          types.Bool   `tfsdk:"enabled"`
	AlertOnLevelDrop types.Bool   `tfsdk:"alert_on_level_drop"`
	ApplicableTiers  types.Set    `tfsdk:"applicable_tiers"`
	IsDefault        types.Bool   `tfsdk:"is_default"`
	Check            types.List   `tfsdk:"check"`
	Level            types.List   `tfsdk:"level"`
}

type scorecardCheckModel struct {
	ID                        types.String  `tfsdk:"id"`
	Type                      types.String  `tfsdk:"type"`
	Name                      types.String  `tfsdk:"name"`
	Weight                    types.Int64   `tfsdk:"weight"`
	MinBudgetRemainingPercent types.Float64 `tfsdk:"min_budget_remaining_percent"`
	DrillWithinDays           types.Int64   `tfsdk:"drill_within_days"`
	Severities                types.Set     `tfsdk:"severities"`
	Tags                      types.Set     `tfsdk:"tags"`
	MaxFailureRatePercent     types.Float64 `tfsdk:"max_failure_rate_percent"`
	WindowDays                types.Int64   `tfsdk:"window_days"`
}

var scorecardCheckObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"id":                           types.StringType,
	"type":                         types.StringType,
	"name":                         types.StringType,
	"weight":                       types.Int64Type,
	"min_budget_remaining_percent": types.Float64Type,
	"drill_within_days":            types.Int64Type,
	"severities":                   types.SetType{ElemType: types.StringType},
	"tags":                         types.SetType{ElemType: types.StringType},
	"max_failure_rate_percent":     types.Float64Type,
	"window_days":                  types.Int64Type,
}}

type scorecardLevelModel struct {
	Key      types.String  `tfsdk:"key"`
	Name     types.String  `tfsdk:"name"`
	MinScore types.Float64 `tfsdk:"min_score"`
	Color    types.String  `tfsdk:"color"`
}

var scorecardLevelObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"key":       types.StringType,
	"name":      types.StringType,
	"min_score": types.Float64Type,
	"color":     types.StringType,
}}

func (r *scorecardResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_scorecard"
}

func (r *scorecardResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	trimmed := stringvalidator.RegexMatches(trimmedPattern,
		"must not be empty or start or end with whitespace (the server trims it, which would diff forever)")
	paramNote := func(checkTypes ...string) string {
		return " Only on `" + joinBackticked(checkTypes) + "` checks. Optional and computed: omit it for the " +
			"type's default, which the server fills in and state then records."
	}

	resp.Schema = schema.Schema{
		MarkdownDescription: "A scorecard: how well each `infrawrench_service` meets the organization's own " +
			"operational bar. It is a weighted list of `check` blocks (\"has an on-call schedule\", \"no " +
			"critical posture findings\") and a ladder of `level` blocks (bronze, silver, gold).\n\n" +
			"Every hour each service the scorecard applies to is scored: the weight of passing checks over " +
			"the weight of applicable ones, as a percentage, and the highest level whose `min_score` that " +
			"reaches. A check with nothing to judge (no budget set, no stateful members to back up) is not " +
			"applicable and leaves the denominator, so a stateless service is not marked down for lacking " +
			"restore drills. When `alert_on_level_drop` is set, a service dropping a level raises a " +
			"`scorecardAlerts` alert through `infrawrench_alert_routing`.\n\n" +
			"Every organization is seeded, once, with a \"Production readiness\" scorecard (`is_default`). " +
			"Names are unique, so creating one under that name fails; import the seeded one to manage it " +
			"here, or delete it (it is not seeded again).",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned scorecard id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Unique in the organization; 1–120 characters.",
				Validators: []validatorString{
					stringvalidator.LengthBetween(1, scorecardNameMaxLength), trimmed,
				},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "What the scorecard measures; 1–1000 characters.",
				Validators: []validatorString{
					stringvalidator.LengthBetween(1, scorecardDescriptionMaxLength), trimmed,
				},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "A disabled scorecard scores nothing and raises no alerts. Defaults to `true`.",
			},
			"alert_on_level_drop": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Route a `scorecardAlerts` alert when a service drops a level. " +
					"Defaults to `true`.",
			},
			"applicable_tiers": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.Int64Type,
				Default:     setdefault.StaticValue(types.SetValueMust(types.Int64Type, []attr.Value{})),
				MarkdownDescription: "Service tiers (each 1–4) the scorecard applies to. Empty, the default, " +
					"means every service, tiered or not; otherwise untiered services are skipped.",
				Validators: []validatorSet{setvalidator.ValueInt64sAre(int64validator.Between(1, 4))},
			},
			"is_default": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether this is the scorecard seeded for the organization. It is still " +
					"editable and deletable.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
		},
		Blocks: map[string]schema.Block{
			"check": schema.ListNestedBlock{
				MarkdownDescription: "A weighted check, 1–30 of them. Order is display order.",
				Validators:          []validatorList{sizeBetween(1, scorecardMaxChecks)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Optional: true,
							Computed: true,
							MarkdownDescription: "Stable id within the scorecard; results and score history " +
								"refer to it, so changing it starts the check's history afresh. Omit it to use " +
								"the check's `type` (then `<type>_2`, `<type>_3` for repeats, in order). Set it " +
								"explicitly when the same type appears more than once and the blocks may be " +
								"reordered.",
							Validators: []validatorString{stringvalidator.LengthAtLeast(1)},
						},
						"type": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "The check, one of `" + joinBackticked(scorecardCheckTypes) +
								"`. `has_owner`: an owning team or member. `has_on_call`: an enabled on-call " +
								"schedule. `slo_within_budget`: at least one linked SLO, each with enough error " +
								"budget left. `has_runbook`: at least one enabled runbook. `backups_verified`: " +
								"every stateful member backed up within policy with a recent passing restore " +
								"drill. `no_critical_posture`: no open posture finding at the chosen " +
								"severities. `no_orphans`: no member flagged as orphaned. `required_tags`: " +
								"every taggable member carries the required tags. `cost_within_budget`: the " +
								"last 30 days of member spend within the service's `monthly_budget`. " +
								"`no_critical_vulnerabilities`: no running member has an open (not dismissed) " +
								"vulnerability at the chosen severities; not applicable until a vulnerability " +
								"scanner has reported. `change_failure_rate`: the service's DORA change failure " +
								"rate over the window is at or under the threshold; not applicable when it " +
								"shipped no production change in that window.",
							Validators: []validatorString{oneOfValidator(scorecardCheckTypes...)},
						},
						"name": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Display name, 1–120 characters; the type's own label when " +
								"omitted.",
							Validators: []validatorString{
								stringvalidator.LengthBetween(1, scorecardCheckNameMaxLength), trimmed,
							},
						},
						"weight": schema.Int64Attribute{
							Optional: true,
							Computed: true,
							Default:  int64default.StaticInt64(1),
							MarkdownDescription: "How much the check counts, a whole number 1–10. Defaults " +
								"to `1`.",
							Validators: []validatorInt64{between(scorecardMinWeight, scorecardMaxWeight)},
						},
						"min_budget_remaining_percent": schema.Float64Attribute{
							Optional: true,
							Computed: true,
							MarkdownDescription: "Fail when any linked SLO has less than this share of its " +
								"error budget left, 0–100 (default `0`)." + paramNote("slo_within_budget"),
							Validators: []validatorFloat64{betweenFloat(0, 100)},
						},
						"drill_within_days": schema.Int64Attribute{
							Optional: true,
							Computed: true,
							MarkdownDescription: "How recent the last verified restore drill must be, in days, " +
								"1–730 (default `90`)." + paramNote("backups_verified"),
							Validators: []validatorInt64{between(1, 730)},
						},
						"severities": schema.SetAttribute{
							Optional:    true,
							Computed:    true,
							ElementType: types.StringType,
							MarkdownDescription: "Open posture findings (`no_critical_posture`, default " +
								"`critical` and `high`) or open vulnerabilities on running members " +
								"(`no_critical_vulnerabilities`, default `critical`) at any of these severities " +
								"fail the check: any of `" + joinBackticked(scorecardSeverities) + "`." +
								paramNote("no_critical_posture", "no_critical_vulnerabilities"),
							Validators: []validatorSet{setvalidator.ValueStringsAre(oneOfValidator(scorecardSeverities...))},
						},
						"tags": schema.SetAttribute{
							Optional:    true,
							Computed:    true,
							ElementType: types.StringType,
							MarkdownDescription: "Tag keys every taggable member must carry. Empty (the " +
								"default) uses the organization's tag policy (`infrawrench_tag_policy`)." +
								paramNote("required_tags"),
						},
						"max_failure_rate_percent": schema.Float64Attribute{
							Optional: true,
							Computed: true,
							MarkdownDescription: "Fail when more than this share of the service's production " +
								"changes failed, 0–100 (default `15`)." + paramNote("change_failure_rate"),
							Validators: []validatorFloat64{betweenFloat(0, 100)},
						},
						"window_days": schema.Int64Attribute{
							Optional: true,
							Computed: true,
							MarkdownDescription: "How many trailing days of production changes to count, " +
								"1–90 (default `30`)." + paramNote("change_failure_rate"),
							Validators: []validatorInt64{between(1, 90)},
						},
					},
				},
			},
			"level": schema.ListNestedBlock{
				MarkdownDescription: "A rung of the ladder, 1–6 of them, written **lowest `min_score` first** " +
					"(the server stores them in that order, so any other order would diff forever). A " +
					"service reaches the highest level whose `min_score` its score meets; below the lowest " +
					"it has no level.",
				Validators: []validatorList{sizeBetween(1, scorecardMaxLevels)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"key": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "Stable key, e.g. `gold`: lower-case letters, digits, dashes " +
								"and underscores, unique within the scorecard. Alerts and score history store " +
								"it, so renaming the level (`name`) does not read as a drop but changing the " +
								"key does.",
							Validators: []validatorString{stringvalidator.RegexMatches(scorecardLevelKeyPattern,
								"must be lower-case letters, digits, dashes and underscores, starting with a letter or digit")},
						},
						"name": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Display name; 1–40 characters.",
							Validators: []validatorString{
								stringvalidator.LengthBetween(1, scorecardLevelNameMaxLength), trimmed,
							},
						},
						"min_score": schema.Float64Attribute{
							Required:            true,
							MarkdownDescription: "Minimum score to reach the level, 0–100; unique within the scorecard.",
							Validators:          []validatorFloat64{betweenFloat(0, 100)},
						},
						"color": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "Six-digit hex colour for badges, e.g. `#d4a72c`.",
							Validators: []validatorString{stringvalidator.RegexMatches(scorecardColorPattern,
								"must be a six-digit hex colour like #d4a72c")},
						},
					},
				},
			},
		},
	}
}

// ValidateConfig catches what the per-attribute validators cannot see: a
// parameter on a check type that does not read it (the server would keep it
// and score nothing differently, which reads as a mistake), duplicate check
// ids, and levels out of order or sharing a key or minimum.
func (r *scorecardResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var cfg scorecardResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if !cfg.Check.IsNull() && !cfg.Check.IsUnknown() {
		var checks []scorecardCheckModel
		resp.Diagnostics.Append(cfg.Check.ElementsAs(ctx, &checks, false)...)
		if resp.Diagnostics.HasError() {
			return
		}
		ids := map[string]bool{}
		for i, check := range checks {
			at := func(attribute string) path.Path {
				return path.Root("check").AtListIndex(i).AtName(attribute)
			}
			if !check.ID.IsNull() && !check.ID.IsUnknown() {
				id := check.ID.ValueString()
				if ids[id] {
					resp.Diagnostics.AddAttributeError(at("id"), "Duplicate check id",
						fmt.Sprintf("Check id %q is used more than once; every check needs a unique id.", id))
				}
				ids[id] = true
			}
			if check.Type.IsNull() || check.Type.IsUnknown() {
				continue
			}
			checkType := check.Type.ValueString()
			for attribute, present := range map[string]bool{
				"min_budget_remaining_percent": !check.MinBudgetRemainingPercent.IsNull(),
				"drill_within_days":            !check.DrillWithinDays.IsNull(),
				"severities":                   !check.Severities.IsNull(),
				"tags":                         !check.Tags.IsNull(),
				"max_failure_rate_percent":     !check.MaxFailureRatePercent.IsNull(),
				"window_days":                  !check.WindowDays.IsNull(),
			} {
				if present && !slices.Contains(scorecardParamTypes[attribute], checkType) {
					resp.Diagnostics.AddAttributeError(at(attribute), "Parameter not used by this check",
						"`"+attribute+"` only applies to `"+joinBackticked(scorecardParamTypes[attribute])+
							"` checks, not `"+checkType+"`; remove it.")
				}
			}
		}
	}

	if !cfg.Level.IsNull() && !cfg.Level.IsUnknown() {
		var levels []scorecardLevelModel
		resp.Diagnostics.Append(cfg.Level.ElementsAs(ctx, &levels, false)...)
		if resp.Diagnostics.HasError() {
			return
		}
		keys := map[string]bool{}
		previous := math.Inf(-1)
		for i, level := range levels {
			at := func(attribute string) path.Path {
				return path.Root("level").AtListIndex(i).AtName(attribute)
			}
			if !level.Key.IsNull() && !level.Key.IsUnknown() {
				key := level.Key.ValueString()
				if keys[key] {
					resp.Diagnostics.AddAttributeError(at("key"), "Duplicate level key",
						fmt.Sprintf("Level key %q is used more than once.", key))
				}
				keys[key] = true
			}
			if level.MinScore.IsUnknown() {
				previous = math.Inf(-1)
				continue
			}
			score := level.MinScore.ValueFloat64()
			if score <= previous {
				resp.Diagnostics.AddAttributeError(at("min_score"), "Levels out of order",
					"Write levels lowest `min_score` first, with no two sharing a minimum. The server "+
						"stores them sorted, so any other order would show a change on every plan.")
			}
			previous = score
		}
	}
}

func (r *scorecardResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *scorecardResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan scorecardResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := scorecardInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateScorecard(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create scorecard", err.Error())
		return
	}
	state, diags := scorecardStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *scorecardResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state scorecardResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetScorecard(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read scorecard", err.Error())
		return
	}
	refreshed, diags := scorecardStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update sends every field, so the configuration replaces the scorecard
// rather than patching it.
func (r *scorecardResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan scorecardResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state scorecardResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := scorecardInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateScorecard(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Scorecard no longer exists",
				"The scorecard was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update scorecard", err.Error())
		return
	}
	next, diags := scorecardStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the scorecard. Services are untouched. Deleting the seeded
// default is allowed and it is not re-created.
func (r *scorecardResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state scorecardResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteScorecard(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete scorecard", err.Error())
	}
}

func (r *scorecardResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// scorecardCheckIDs resolves every check's id: the configured one where set,
// otherwise the type, then `<type>_2`, `<type>_3` and so on, skipping any id
// already taken. Deterministic, so an unconfigured id resolves to the same
// value on every apply as long as the blocks keep their order.
func scorecardCheckIDs(checks []scorecardCheckModel) []string {
	ids := make([]string, len(checks))
	taken := map[string]bool{}
	for i, c := range checks {
		if !c.ID.IsNull() && !c.ID.IsUnknown() {
			ids[i] = c.ID.ValueString()
			taken[ids[i]] = true
		}
	}
	for i, c := range checks {
		if ids[i] != "" {
			continue
		}
		base := c.Type.ValueString()
		candidate := base
		for n := 2; taken[candidate]; n++ {
			candidate = fmt.Sprintf("%s_%d", base, n)
		}
		ids[i] = candidate
		taken[candidate] = true
	}
	return ids
}

// setStringsPtr reads a set into a pointer to a slice, nil when null or
// unknown, so an unconfigured parameter is omitted and the server fills its
// default while an explicit empty set still goes out as `[]`.
func setStringsPtr(ctx context.Context, set types.Set) (*[]string, diag.Diagnostics) {
	if set.IsNull() || set.IsUnknown() {
		return nil, nil
	}
	out := []string{}
	diags := set.ElementsAs(ctx, &out, false)
	if out == nil {
		out = []string{}
	}
	return &out, diags
}

func scorecardInputFrom(ctx context.Context, plan scorecardResourceModel) (iw.ScorecardInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	in := iw.ScorecardInput{
		Name:             plan.Name.ValueString(),
		Description:      stringPtr(plan.Description),
		Checks:           []iw.ScorecardCheck{},
		Levels:           []iw.ScorecardLevel{},
		ApplicableTiers:  []int64{},
		AlertOnLevelDrop: plan.AlertOnLevelDrop.ValueBool(),
		Enabled:          plan.Enabled.ValueBool(),
	}

	if !plan.ApplicableTiers.IsNull() && !plan.ApplicableTiers.IsUnknown() {
		diags.Append(plan.ApplicableTiers.ElementsAs(ctx, &in.ApplicableTiers, false)...)
		if in.ApplicableTiers == nil {
			in.ApplicableTiers = []int64{}
		}
	}

	if !plan.Check.IsNull() && !plan.Check.IsUnknown() {
		var checks []scorecardCheckModel
		diags.Append(plan.Check.ElementsAs(ctx, &checks, false)...)
		if diags.HasError() {
			return in, diags
		}
		ids := scorecardCheckIDs(checks)
		for i, c := range checks {
			weight := int64(scorecardMinWeight)
			if !c.Weight.IsNull() && !c.Weight.IsUnknown() {
				weight = c.Weight.ValueInt64()
			}
			params := iw.ScorecardCheckParams{
				MinBudgetRemainingPercent: float64Ptr(c.MinBudgetRemainingPercent),
				MaxFailureRatePercent:     float64Ptr(c.MaxFailureRatePercent),
			}
			if days := int64Ptr(c.DrillWithinDays); days != nil {
				f := float64(*days)
				params.DrillWithinDays = &f
			}
			if days := int64Ptr(c.WindowDays); days != nil {
				f := float64(*days)
				params.WindowDays = &f
			}
			var d diag.Diagnostics
			params.Severities, d = setStringsPtr(ctx, c.Severities)
			diags.Append(d...)
			params.Tags, d = setStringsPtr(ctx, c.Tags)
			diags.Append(d...)
			in.Checks = append(in.Checks, iw.ScorecardCheck{
				ID:     ids[i],
				Type:   c.Type.ValueString(),
				Name:   stringPtr(c.Name),
				Weight: weight,
				Params: params,
			})
		}
	}

	if !plan.Level.IsNull() && !plan.Level.IsUnknown() {
		var levels []scorecardLevelModel
		diags.Append(plan.Level.ElementsAs(ctx, &levels, false)...)
		for _, l := range levels {
			in.Levels = append(in.Levels, iw.ScorecardLevel{
				Key:      l.Key.ValueString(),
				Name:     l.Name.ValueString(),
				MinScore: l.MinScore.ValueFloat64(),
				Color:    stringPtr(l.Color),
			})
		}
	}
	return in, diags
}

// scorecardStateFrom maps a scorecard into state. Each typed parameter is
// written only for the check type that reads it and is null elsewhere, which
// is what ValidateConfig requires of the configuration. lastEvaluatedAt is
// left out: it moves every hour.
func scorecardStateFrom(ctx context.Context, remote *iw.Scorecard) (scorecardResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	nullSet := types.SetNull(types.StringType)
	checks := make([]scorecardCheckModel, 0, len(remote.Checks))
	for _, c := range remote.Checks {
		m := scorecardCheckModel{
			ID:                        types.StringValue(c.ID),
			Type:                      types.StringValue(c.Type),
			Name:                      stringValue(c.Name),
			Weight:                    types.Int64Value(c.Weight),
			MinBudgetRemainingPercent: types.Float64Null(),
			DrillWithinDays:           types.Int64Null(),
			Severities:                nullSet,
			Tags:                      nullSet,
			MaxFailureRatePercent:     types.Float64Null(),
			WindowDays:                types.Int64Null(),
		}
		switch c.Type {
		case "slo_within_budget":
			m.MinBudgetRemainingPercent = float64Value(c.Params.MinBudgetRemainingPercent)
		case "backups_verified":
			if c.Params.DrillWithinDays != nil {
				m.DrillWithinDays = types.Int64Value(int64(math.Round(*c.Params.DrillWithinDays)))
			}
		case "no_critical_posture", "no_critical_vulnerabilities":
			if c.Params.Severities != nil {
				set, d := stringSetOf(ctx, *c.Params.Severities)
				diags.Append(d...)
				m.Severities = set
			}
		case "required_tags":
			tags := []string{}
			if c.Params.Tags != nil {
				tags = *c.Params.Tags
			}
			set, d := stringSetOf(ctx, tags)
			diags.Append(d...)
			m.Tags = set
		case "change_failure_rate":
			m.MaxFailureRatePercent = float64Value(c.Params.MaxFailureRatePercent)
			if c.Params.WindowDays != nil {
				m.WindowDays = types.Int64Value(int64(math.Round(*c.Params.WindowDays)))
			}
		}
		checks = append(checks, m)
	}
	checkList, d := types.ListValueFrom(ctx, scorecardCheckObjectType, checks)
	diags.Append(d...)

	levels := make([]scorecardLevelModel, 0, len(remote.Levels))
	for _, l := range remote.Levels {
		levels = append(levels, scorecardLevelModel{
			Key:      types.StringValue(l.Key),
			Name:     types.StringValue(l.Name),
			MinScore: types.Float64Value(l.MinScore),
			Color:    stringValue(l.Color),
		})
	}
	levelList, d := types.ListValueFrom(ctx, scorecardLevelObjectType, levels)
	diags.Append(d...)

	tiers := remote.ApplicableTiers
	if tiers == nil {
		tiers = []int64{}
	}
	tierSet, d := types.SetValueFrom(ctx, types.Int64Type, tiers)
	diags.Append(d...)

	return scorecardResourceModel{
		ID:               types.StringValue(remote.ID),
		Name:             types.StringValue(remote.Name),
		Description:      stringValue(remote.Description),
		Enabled:          types.BoolValue(remote.Enabled),
		AlertOnLevelDrop: types.BoolValue(remote.AlertOnLevelDrop),
		ApplicableTiers:  tierSet,
		IsDefault:        types.BoolValue(remote.IsDefault),
		Check:            checkList,
		Level:            levelList,
	}, diags
}
