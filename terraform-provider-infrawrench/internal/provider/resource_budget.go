package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/resourcevalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                     = (*budgetResource)(nil)
	_ resource.ResourceWithConfigure        = (*budgetResource)(nil)
	_ resource.ResourceWithImportState      = (*budgetResource)(nil)
	_ resource.ResourceWithConfigValidators = (*budgetResource)(nil)
)

// budgetDayPattern is the `YYYY-MM-DD` shape every period date takes.
var budgetDayPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// budgetPeriodUnits is the closed set a recurring period repeats in.
var budgetPeriodUnits = []string{"day", "week", "month", "quarter", "year"}

// budgetMaxUsageAmount is the server's ceiling on a usage amount.
const budgetMaxUsageAmount = 1e15

type budgetRecurringPeriodModel struct {
	Unit      types.String `tfsdk:"unit"`
	Interval  types.Int64  `tfsdk:"interval"`
	StartDate types.String `tfsdk:"start_date"`
}

var budgetRecurringPeriodAttrTypes = map[string]attr.Type{
	"unit":       types.StringType,
	"interval":   types.Int64Type,
	"start_date": types.StringType,
}

type budgetExplicitPeriodModel struct {
	Start       types.String  `tfsdk:"start"`
	End         types.String  `tfsdk:"end"`
	AmountCents types.Int64   `tfsdk:"amount_cents"`
	UsageAmount types.Float64 `tfsdk:"usage_amount"`
}

var budgetExplicitPeriodAttrTypes = map[string]attr.Type{
	"start":        types.StringType,
	"end":          types.StringType,
	"amount_cents": types.Int64Type,
	"usage_amount": types.Float64Type,
}

var budgetExplicitPeriodObjectType = types.ObjectType{AttrTypes: budgetExplicitPeriodAttrTypes}

// NewBudgetResource constructs the infrawrench_budget resource.
func NewBudgetResource() resource.Resource { return &budgetResource{} }

type budgetResource struct{ client *iw.Client }

type budgetThresholdModel struct {
	Type    types.String `tfsdk:"type"`
	Percent types.Int64  `tfsdk:"percent"`
}

var budgetThresholdAttrTypes = map[string]attr.Type{
	"type":    types.StringType,
	"percent": types.Int64Type,
}

var budgetThresholdObjectType = types.ObjectType{AttrTypes: budgetThresholdAttrTypes}

type budgetResourceModel struct {
	ID               types.String  `tfsdk:"id"`
	Name             types.String  `tfsdk:"name"`
	AmountCents      types.Int64   `tfsdk:"amount_cents"`
	Currency         types.String  `tfsdk:"currency"`
	SavedFilterID    types.String  `tfsdk:"saved_filter_id"`
	ScenarioModelID  types.String  `tfsdk:"scenario_model_id"`
	CostBasis        types.String  `tfsdk:"cost_basis"`
	UseAdjustedSpend types.Bool    `tfsdk:"use_adjusted_spend"`
	Filter           types.List    `tfsdk:"filter"`
	Threshold        types.List    `tfsdk:"threshold"`
	Measure          types.String  `tfsdk:"measure"`
	UsageUnit        types.String  `tfsdk:"usage_unit"`
	UsageAmount      types.Float64 `tfsdk:"usage_amount"`
	ParentBudgetID   types.String  `tfsdk:"parent_budget_id"`
	RecurringPeriod  types.Object  `tfsdk:"recurring_period"`
	ExplicitPeriod   types.List    `tfsdk:"explicit_period"`
}

func (r *budgetResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_budget"
}

func (r *budgetResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A spend or usage budget with alert thresholds.\n\n" +
			"By default a budget limits monthly spend. Set `measure = \"usage\"` with `usage_unit` and " +
			"`usage_amount` to limit a usage quantity (tokens, GB, requests) instead; add a " +
			"`recurring_period` block for a custom cadence or `explicit_period` blocks for a list of " +
			"periods with their own amounts; and set `parent_budget_id` to nest it under a parent, " +
			"whose actual and forecast are then the sum of its children's.\n\n" +
			"Budgets carry live status (this period's actual and forecast) that this resource " +
			"deliberately does not expose: it changes on every refresh and would make every plan " +
			"noisy. Read it from the UI, the CLI, or the API.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned budget id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"amount_cents": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(0),
				MarkdownDescription: "Limit per period of a spend budget, in minor currency units. Must be " +
					"greater than zero for a spend budget unless `explicit_period` blocks carry the amounts; " +
					"ignored by a usage budget. Defaults to 0.",
				Validators: []validatorInt64{atLeast(0)},
			},
			"measure": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("cost"),
				MarkdownDescription: "`cost` to limit spend (the default), `usage` to limit a usage quantity in `usage_unit`.",
				Validators:          []validator.String{oneOfValidator("cost", "usage")},
			},
			"usage_unit": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The usage unit a usage budget counts, exactly as providers report it " +
					"(the unit picker in the app lists the ones in your cost data), 1–64 characters. " +
					"Required when `measure` is `usage`.",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 64)},
			},
			"usage_amount": schema.Float64Attribute{
				Optional: true,
				MarkdownDescription: "A usage budget's limit per period, in `usage_unit`: greater than zero " +
					"and at most 10^15. Required for a usage budget unless `explicit_period` blocks carry the amounts.",
				Validators: []validator.Float64{positiveFloatAtMost(budgetMaxUsageAmount)},
			},
			"parent_budget_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of the `infrawrench_budget` this one rolls up into. A parent's actual and " +
					"forecast are the sum of its children's over the parent's period; parent and child must " +
					"count the same thing (one currency, or one usage unit), and hierarchies are at most four " +
					"levels deep.",
			},
			"currency": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("USD"),
				MarkdownDescription: "ISO 4217 currency code. Defaults to `USD`.",
			},
			"saved_filter_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of an `infrawrench_saved_filter` to apply on top of `filter`. " +
					"Clearing this attribute clears it on the budget.",
			},
			"scenario_model_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of an `infrawrench_scenario_model` whose adjustments feed the " +
					"budget's forecast.",
			},
			"cost_basis": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("cash"),
				MarkdownDescription: "`cash` to measure against invoiced spend, `amortized` to spread commitment fees.",
				Validators:          []validator.String{oneOfValidator("cash", "amortized")},
			},
			"use_adjusted_spend": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(false),
				MarkdownDescription: "Measure against spend restated by `infrawrench_billing_rule`s rather than raw spend.",
			},
		},
		Blocks: map[string]schema.Block{
			"filter": costFilterBlockSchema("Restricts the budget to matching spend. Clauses are ANDed."),
			"threshold": schema.ListNestedBlock{
				MarkdownDescription: "Alert thresholds. At least one and at most ten are required.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"type": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "`actual` to fire on spend to date, `forecast` to fire on projected month end.",
							Validators:          []validator.String{oneOfValidator("actual", "forecast")},
						},
						"percent": schema.Int64Attribute{
							Required:            true,
							MarkdownDescription: "Percentage of the budget at which to alert, 1–1000.",
							Validators:          []validatorInt64{between(1, 1000)},
						},
					},
				},
				Validators: []validator.List{listvalidator.SizeBetween(1, 10)},
			},
			"recurring_period": schema.SingleNestedBlock{
				MarkdownDescription: "A custom cadence: periods of `interval` × `unit`, the first starting on " +
					"`start_date`. Omit both this and `explicit_period` for the calendar month. Conflicts " +
					"with `explicit_period`.",
				Attributes: map[string]schema.Attribute{
					"unit": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "One of `" + joinBackticked(budgetPeriodUnits) + "`. Required in the block.",
						Validators:          []validator.String{oneOfValidator(budgetPeriodUnits...)},
					},
					"interval": schema.Int64Attribute{
						Optional:            true,
						MarkdownDescription: "How many units each period lasts, 1–365. Required in the block.",
						Validators:          []validatorInt64{between(1, 365)},
					},
					"start_date": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "First day of the first period, `YYYY-MM-DD` (UTC). Required in the block.",
						Validators: []validator.String{
							stringvalidator.RegexMatches(budgetDayPattern, "must be YYYY-MM-DD"),
						},
					},
				},
			},
			"explicit_period": schema.ListNestedBlock{
				MarkdownDescription: "An explicit list of non-overlapping periods, each with its own amount " +
					"(`amount_cents` for a spend budget, `usage_amount` for a usage budget). At most 60. " +
					"Days outside every period are not measured. Conflicts with `recurring_period`.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"start": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "First day, `YYYY-MM-DD`, inclusive.",
							Validators: []validator.String{
								stringvalidator.RegexMatches(budgetDayPattern, "must be YYYY-MM-DD"),
							},
						},
						"end": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Last day, `YYYY-MM-DD`, inclusive.",
							Validators: []validator.String{
								stringvalidator.RegexMatches(budgetDayPattern, "must be YYYY-MM-DD"),
							},
						},
						"amount_cents": schema.Int64Attribute{
							Optional:            true,
							MarkdownDescription: "This period's limit for a spend budget, in minor currency units; at least 1.",
							Validators:          []validatorInt64{atLeast(1)},
						},
						"usage_amount": schema.Float64Attribute{
							Optional: true,
							MarkdownDescription: "This period's limit for a usage budget: greater than zero and " +
								"at most 10^15.",
							Validators: []validator.Float64{positiveFloatAtMost(budgetMaxUsageAmount)},
						},
					},
				},
				Validators: []validator.List{sizeAtMost(60)},
			},
		},
	}
}

func (r *budgetResource) ConfigValidators(_ context.Context) []resource.ConfigValidator {
	return []resource.ConfigValidator{
		resourcevalidator.Conflicting(
			path.MatchRoot("recurring_period"),
			path.MatchRoot("explicit_period"),
		),
	}
}

func (r *budgetResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *budgetResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan budgetResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := budgetInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateBudget(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create budget", err.Error())
		return
	}

	state, diags := budgetStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *budgetResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state budgetResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetBudget(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform: drop it from state so the next plan
		// recreates it, rather than failing the refresh.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read budget", err.Error())
		return
	}

	refreshed, diags := budgetStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *budgetResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan budgetResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state budgetResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := budgetInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateBudget(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Budget no longer exists",
				"The budget was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update budget", err.Error())
		return
	}

	next, diags := budgetStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *budgetResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state budgetResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteBudget(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete budget", err.Error())
	}
}

func (r *budgetResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func budgetInputFrom(ctx context.Context, model budgetResourceModel) (iw.BudgetInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	filters, d := costFiltersFrom(ctx, model.Filter)
	diags.Append(d...)

	thresholds := []iw.BudgetThreshold{}
	if !model.Threshold.IsNull() && !model.Threshold.IsUnknown() {
		var rows []budgetThresholdModel
		diags.Append(model.Threshold.ElementsAs(ctx, &rows, false)...)
		for _, row := range rows {
			thresholds = append(thresholds, iw.BudgetThreshold{
				Type:    row.Type.ValueString(),
				Percent: row.Percent.ValueInt64(),
			})
		}
	}

	period, d := budgetPeriodFrom(ctx, model)
	diags.Append(d...)

	// "cost" is the server's default and is sent as absent, so a config that
	// never mentions measure produces exactly the body it always did.
	var measure *string
	if m := stringPtr(model.Measure); m != nil && *m == "usage" {
		measure = m
	}

	return iw.BudgetInput{
		Name:             model.Name.ValueString(),
		AmountCents:      model.AmountCents.ValueInt64(),
		Currency:         model.Currency.ValueString(),
		Filters:          filters,
		SavedFilterID:    stringPtr(model.SavedFilterID),
		ScenarioModelID:  stringPtr(model.ScenarioModelID),
		Thresholds:       thresholds,
		CostBasis:        stringPtr(model.CostBasis),
		UseAdjustedSpend: boolPtr(model.UseAdjustedSpend),
		Measure:          measure,
		UsageUnit:        stringPtr(model.UsageUnit),
		UsageAmount:      float64Ptr(model.UsageAmount),
		Period:           period,
		ParentBudgetID:   stringPtr(model.ParentBudgetID),
	}, diags
}

// budgetPeriodFrom builds the wire period from whichever block is set, or nil
// (the calendar month) when neither is.
func budgetPeriodFrom(ctx context.Context, model budgetResourceModel) (*iw.BudgetPeriod, diag.Diagnostics) {
	var diags diag.Diagnostics
	if !model.RecurringPeriod.IsNull() && !model.RecurringPeriod.IsUnknown() {
		var rp budgetRecurringPeriodModel
		diags.Append(model.RecurringPeriod.As(ctx, &rp, basetypes.ObjectAsOptions{
			UnhandledNullAsEmpty:    true,
			UnhandledUnknownAsEmpty: true,
		})...)
		if rp.Unit.IsNull() || rp.Interval.IsNull() || rp.StartDate.IsNull() {
			diags.AddAttributeError(path.Root("recurring_period"), "Incomplete recurring period",
				"`unit`, `interval` and `start_date` are all required in a recurring_period block.")
			return nil, diags
		}
		return &iw.BudgetPeriod{
			Kind:      "recurring",
			Unit:      stringPtr(rp.Unit),
			Interval:  int64Ptr(rp.Interval),
			StartDate: stringPtr(rp.StartDate),
		}, diags
	}
	if !model.ExplicitPeriod.IsNull() && !model.ExplicitPeriod.IsUnknown() {
		var rows []budgetExplicitPeriodModel
		diags.Append(model.ExplicitPeriod.ElementsAs(ctx, &rows, false)...)
		if len(rows) == 0 {
			return nil, diags
		}
		periods := make([]iw.BudgetExplicitPeriod, 0, len(rows))
		for _, row := range rows {
			periods = append(periods, iw.BudgetExplicitPeriod{
				Start:       row.Start.ValueString(),
				End:         row.End.ValueString(),
				AmountCents: int64Ptr(row.AmountCents),
				UsageAmount: float64Ptr(row.UsageAmount),
			})
		}
		return &iw.BudgetPeriod{Kind: "explicit", Periods: periods}, diags
	}
	return nil, diags
}

// budgetStateFrom maps a server budget into Terraform state.
//
// `prior` is the plan (on write) or the previous state (on refresh). It exists
// for the two attributes the API may echo back as null even though they are
// Optional+Computed with a default: falling back to the prior known value is
// what keeps `terraform apply` from reporting an inconsistent result, while
// still surfacing a genuine remote change when the server does send a value.
func budgetStateFrom(ctx context.Context, remote *iw.Budget, prior budgetResourceModel) (budgetResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	filters, d := costFiltersTo(ctx, remote.Filters)
	diags.Append(d...)

	rows := make([]budgetThresholdModel, 0, len(remote.Thresholds))
	for _, t := range remote.Thresholds {
		rows = append(rows, budgetThresholdModel{
			Type:    types.StringValue(t.Type),
			Percent: types.Int64Value(t.Percent),
		})
	}
	thresholds, d := types.ListValueFrom(ctx, budgetThresholdObjectType, rows)
	diags.Append(d...)

	costBasis := stringValue(remote.CostBasis)
	if costBasis.IsNull() {
		costBasis = prior.CostBasis
	}
	useAdjusted := boolValue(remote.UseAdjustedSpend)
	if useAdjusted.IsNull() {
		useAdjusted = prior.UseAdjustedSpend
	}
	measure := stringValue(remote.Measure)
	if measure.IsNull() {
		measure = prior.Measure
		if measure.IsNull() || measure.IsUnknown() {
			measure = types.StringValue("cost")
		}
	}

	recurring := types.ObjectNull(budgetRecurringPeriodAttrTypes)
	explicit := types.ListNull(budgetExplicitPeriodObjectType)
	if p := remote.Period; p != nil {
		switch p.Kind {
		case "recurring":
			obj, d := types.ObjectValueFrom(ctx, budgetRecurringPeriodAttrTypes, budgetRecurringPeriodModel{
				Unit:      stringValue(p.Unit),
				Interval:  int64Value(p.Interval),
				StartDate: stringValue(p.StartDate),
			})
			diags.Append(d...)
			recurring = obj
		case "explicit":
			rows := make([]budgetExplicitPeriodModel, 0, len(p.Periods))
			for _, e := range p.Periods {
				rows = append(rows, budgetExplicitPeriodModel{
					Start:       types.StringValue(e.Start),
					End:         types.StringValue(e.End),
					AmountCents: int64Value(e.AmountCents),
					UsageAmount: float64Value(e.UsageAmount),
				})
			}
			list, d := types.ListValueFrom(ctx, budgetExplicitPeriodObjectType, rows)
			diags.Append(d...)
			explicit = list
		}
	}

	return budgetResourceModel{
		ID:               types.StringValue(remote.ID),
		Name:             types.StringValue(remote.Name),
		AmountCents:      types.Int64Value(remote.AmountCents),
		Currency:         types.StringValue(remote.Currency),
		SavedFilterID:    stringValue(remote.SavedFilterID),
		ScenarioModelID:  stringValue(remote.ScenarioModelID),
		CostBasis:        costBasis,
		UseAdjustedSpend: useAdjusted,
		Filter:           filters,
		Threshold:        thresholds,
		Measure:          measure,
		UsageUnit:        stringValue(remote.UsageUnit),
		UsageAmount:      float64Value(remote.UsageAmount),
		ParentBudgetID:   stringValue(remote.ParentBudgetID),
		RecurringPeriod:  recurring,
		ExplicitPeriod:   explicit,
	}, diags
}
