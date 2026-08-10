package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*budgetResource)(nil)
	_ resource.ResourceWithConfigure   = (*budgetResource)(nil)
	_ resource.ResourceWithImportState = (*budgetResource)(nil)
)

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
	ID               types.String `tfsdk:"id"`
	Name             types.String `tfsdk:"name"`
	AmountCents      types.Int64  `tfsdk:"amount_cents"`
	Currency         types.String `tfsdk:"currency"`
	SavedFilterID    types.String `tfsdk:"saved_filter_id"`
	ScenarioModelID  types.String `tfsdk:"scenario_model_id"`
	CostBasis        types.String `tfsdk:"cost_basis"`
	UseAdjustedSpend types.Bool   `tfsdk:"use_adjusted_spend"`
	Filter           types.List   `tfsdk:"filter"`
	Threshold        types.List   `tfsdk:"threshold"`
}

func (r *budgetResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_budget"
}

func (r *budgetResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A spend budget with alert thresholds.\n\n" +
			"Budgets carry live status (this month's actual and forecast spend) that this resource " +
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
			},
			"amount_cents": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "Monthly budget in minor currency units. Must be greater than zero.",
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
						},
					},
				},
				Validators: []validator.List{listvalidator.SizeBetween(1, 10)},
			},
		},
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
	}, diags
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
	}, diags
}
