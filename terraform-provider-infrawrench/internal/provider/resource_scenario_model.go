package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*scenarioModelResource)(nil)
	_ resource.ResourceWithConfigure   = (*scenarioModelResource)(nil)
	_ resource.ResourceWithImportState = (*scenarioModelResource)(nil)
)

// scenarioISODatePattern is the calendar-date form the API accepts. Dates are
// plain days, not timestamps: a scenario adjustment starts at the beginning of
// a billing day and carries no timezone.
var scenarioISODatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// scenarioCurrencyPattern is an uppercase ISO 4217 code, the same form the
// budget resource defaults to.
var scenarioCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

var scenarioAdjustmentKinds = []string{"one_off", "recurring", "rate_change"}

// NewScenarioModelResource constructs the infrawrench_scenario_model resource.
func NewScenarioModelResource() resource.Resource { return &scenarioModelResource{} }

type scenarioModelResource struct{ client *iw.Client }

type scenarioAdjustmentModel struct {
	Key         types.String  `tfsdk:"key"`
	Label       types.String  `tfsdk:"label"`
	Kind        types.String  `tfsdk:"kind"`
	StartDate   types.String  `tfsdk:"start_date"`
	EndDate     types.String  `tfsdk:"end_date"`
	AmountCents types.Int64   `tfsdk:"amount_cents"`
	Period      types.String  `tfsdk:"period"`
	Percent     types.Float64 `tfsdk:"percent"`
	Scope       types.List    `tfsdk:"scope"`
}

var scenarioAdjustmentAttrTypes = map[string]attr.Type{
	"key":          types.StringType,
	"label":        types.StringType,
	"kind":         types.StringType,
	"start_date":   types.StringType,
	"end_date":     types.StringType,
	"amount_cents": types.Int64Type,
	"period":       types.StringType,
	"percent":      types.Float64Type,
	"scope":        types.ListType{ElemType: costFilterObjectType},
}

var scenarioAdjustmentObjectType = types.ObjectType{AttrTypes: scenarioAdjustmentAttrTypes}

type scenarioModelResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Currency    types.String `tfsdk:"currency"`
	Adjustment  types.List   `tfsdk:"adjustment"`
}

func (r *scenarioModelResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_scenario_model"
}

func (r *scenarioModelResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A what-if model: a named list of adjustments that budgets and cost reports " +
			"can layer over real spend to forecast a decision before it is made.\n\n" +
			"An adjustment's fields are nullable rather than a discriminated union, so which " +
			"combinations are legal depends on `kind`, and the API — not this provider — is what " +
			"decides. `amount_cents` belongs to `one_off` and `recurring`, `percent` to " +
			"`rate_change`, `period` to `recurring` only, and `end_date` is refused outright on " +
			"`one_off`. None of that is expressible in a Terraform schema, so a malformed " +
			"adjustment passes `terraform plan` and fails the apply with a 400 naming the offending " +
			"field. Read the diagnostic rather than the plan when an adjustment is rejected.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned model id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text explaining what the model represents, up to 2000 characters.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"currency": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Uppercase ISO 4217 currency code, e.g. `USD`. Every adjustment in " +
					"the model is denominated in it; there is deliberately no per-adjustment currency.",
				Validators: []validator.String{
					stringvalidator.RegexMatches(scenarioCurrencyPattern,
						"must be a three-letter uppercase ISO 4217 code, e.g. USD"),
				},
			},
		},
		Blocks: map[string]schema.Block{
			"adjustment": schema.ListNestedBlock{
				MarkdownDescription: "The what-if lines that make up the model. At most 50.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"key": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "Stable identity for this adjustment, chosen by you.\n\n" +
								"The API stores an id on every adjustment but does not mint one: whatever " +
								"the client sends is what is persisted, and a PUT replaces the whole list. " +
								"That leaves exactly two options, and only one of them is safe. If the " +
								"provider generated the id — from the list position, or from a hash of the " +
								"contents — then moving a block, renaming a label, or inserting a line " +
								"above another would change the identity of adjustments the practitioner " +
								"did not touch, and anything that references an adjustment by id (a saved " +
								"forecast, an audit entry, a comparison against a previous run) would " +
								"quietly point at the wrong line. So the key is yours to own. Give each " +
								"adjustment a short, meaningful, permanent slug — `q3-headcount`, " +
								"`ri-purchase`, `egress-renegotiation` — and never reuse one for a " +
								"different line. Reordering the blocks then costs nothing, because order " +
								"is not identity.",
							Validators: []validator.String{stringvalidator.LengthBetween(1, 120)},
						},
						"label": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Human-readable name shown on forecasts, 1–120 characters.",
							Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
						},
						"kind": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "`one_off` for a single dated charge or saving, `recurring` " +
								"for one repeated every period, `rate_change` for a percentage shift in " +
								"whatever spend the scope matches.",
							Validators: []validator.String{oneOfValidator(scenarioAdjustmentKinds...)},
						},
						"start_date": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Calendar date the adjustment takes effect, `YYYY-MM-DD`.",
							Validators: []validator.String{
								stringvalidator.RegexMatches(scenarioISODatePattern, "must be a calendar date in YYYY-MM-DD form"),
							},
						},
						"end_date": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Calendar date the adjustment stops applying, `YYYY-MM-DD`. " +
								"Leave it unset to run indefinitely. The server rejects it on a `one_off`, " +
								"which has no duration to end.",
							Validators: []validator.String{
								stringvalidator.RegexMatches(scenarioISODatePattern, "must be a calendar date in YYYY-MM-DD form"),
							},
						},
						"amount_cents": schema.Int64Attribute{
							Optional: true,
							MarkdownDescription: "Amount in minor units of the model's `currency`, for " +
								"`one_off` and `recurring`. Negative values are meaningful and expected: " +
								"a saving is a negative amount.",
						},
						"period": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "How often a `recurring` amount lands, `daily` or `monthly`. " +
								"Rejected on the other two kinds.",
							Validators: []validator.String{oneOfValidator("daily", "monthly")},
						},
						"percent": schema.Float64Attribute{
							Optional: true,
							MarkdownDescription: "Rate shift for a `rate_change`, between -100 and 1000. " +
								"`-30` models a thirty percent discount on the scoped spend, `25` models a " +
								"price rise. Rejected on the other two kinds.",
							Validators: []validator.Float64{float64validator.Between(-100, 1000)},
						},
					},
					Blocks: map[string]schema.Block{
						"scope": scenarioScopeBlockSchema(),
					},
				},
				Validators: []validator.List{listvalidator.SizeAtMost(50)},
			},
		},
	}
}

// scenarioScopeBlockSchema is the per-adjustment filter, which is the shared
// cost filter block with a cap on it. An adjustment with no scope applies to
// all spend in the model's currency.
func scenarioScopeBlockSchema() schema.ListNestedBlock {
	block := costFilterBlockSchema(
		"Restricts the adjustment to matching spend. Clauses are ANDed; an empty scope means all spend. At most 20.")
	block.Validators = []validator.List{listvalidator.SizeAtMost(20)}
	return block
}

func (r *scenarioModelResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *scenarioModelResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan scenarioModelResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := scenarioModelInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateScenarioModel(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create scenario model", err.Error())
		return
	}

	state, diags := scenarioModelStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *scenarioModelResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state scenarioModelResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetScenarioModel(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform: drop it from state so the next plan
		// recreates it, rather than failing the refresh.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read scenario model", err.Error())
		return
	}

	refreshed, diags := scenarioModelStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *scenarioModelResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan scenarioModelResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state scenarioModelResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := scenarioModelInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateScenarioModel(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Scenario model no longer exists",
				"The scenario model was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update scenario model", err.Error())
		return
	}

	next, diags := scenarioModelStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *scenarioModelResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state scenarioModelResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteScenarioModel(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		// A 409 means a budget or a cost report still points at this model. It is
		// not a transient condition and retrying cannot clear it, so the delete
		// fails once with the referents the server named — APIError.Error()
		// already renders them — and the practitioner decides where those objects
		// should point instead.
		if iw.IsConflict(err) {
			resp.Diagnostics.AddError(
				"Scenario model is still referenced",
				err.Error()+"\n\nA scenario model cannot be deleted while a budget or cost report "+
					"forecasts against it. Repoint or destroy the referencing objects first, then "+
					"destroy this model.")
			return
		}
		resp.Diagnostics.AddError("Unable to delete scenario model", err.Error())
	}
}

func (r *scenarioModelResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func scenarioModelInputFrom(ctx context.Context, model scenarioModelResourceModel) (iw.CostScenarioModelInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	adjustments := []iw.CostScenarioAdjustment{}
	if !model.Adjustment.IsNull() && !model.Adjustment.IsUnknown() {
		var rows []scenarioAdjustmentModel
		diags.Append(model.Adjustment.ElementsAs(ctx, &rows, false)...)
		if diags.HasError() {
			return iw.CostScenarioModelInput{}, diags
		}
		for _, row := range rows {
			scope, d := costFiltersFrom(ctx, row.Scope)
			diags.Append(d...)
			if diags.HasError() {
				return iw.CostScenarioModelInput{}, diags
			}
			adjustments = append(adjustments, iw.CostScenarioAdjustment{
				// The practitioner's key is the wire id verbatim. See the `key`
				// attribute description for why the provider does not invent one.
				ID:          row.Key.ValueString(),
				Label:       row.Label.ValueString(),
				Kind:        row.Kind.ValueString(),
				StartDate:   row.StartDate.ValueString(),
				EndDate:     stringPtr(row.EndDate),
				AmountCents: int64Ptr(row.AmountCents),
				// An adjustment is always denominated in the model's own currency,
				// so the per-adjustment field is left nil rather than exposed as an
				// attribute a practitioner could set to something contradictory.
				Currency: nil,
				Period:   stringPtr(row.Period),
				Percent:  float64Ptr(row.Percent),
				Scope:    scope,
			})
		}
	}

	return iw.CostScenarioModelInput{
		Name:        model.Name.ValueString(),
		Description: stringPtr(model.Description),
		Currency:    model.Currency.ValueString(),
		Adjustments: adjustments,
	}, diags
}

// scenarioModelStateFrom maps a server model into Terraform state.
//
// `prior` is the plan (on write) or the previous state (on refresh); it is
// unused today because every attribute of this resource is either Required or
// plainly Optional, so the response is authoritative for all of them. It stays
// in the signature to match the other resources, and so that adding an
// Optional+Computed attribute later has an obvious place to fall back to.
//
// The per-adjustment `currency` the server echoes is deliberately dropped: it
// is always the model's own currency and there is no attribute to put it in.
func scenarioModelStateFrom(ctx context.Context, remote *iw.CostScenarioModel, _ scenarioModelResourceModel) (scenarioModelResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	rows := make([]scenarioAdjustmentModel, 0, len(remote.Adjustments))
	for _, a := range remote.Adjustments {
		scope, d := costFiltersTo(ctx, a.Scope)
		diags.Append(d...)
		if diags.HasError() {
			return scenarioModelResourceModel{}, diags
		}
		rows = append(rows, scenarioAdjustmentModel{
			Key:         types.StringValue(a.ID),
			Label:       types.StringValue(a.Label),
			Kind:        types.StringValue(a.Kind),
			StartDate:   types.StringValue(a.StartDate),
			EndDate:     stringValue(a.EndDate),
			AmountCents: int64Value(a.AmountCents),
			Period:      stringValue(a.Period),
			Percent:     float64Value(a.Percent),
			Scope:       scope,
		})
	}
	adjustments, d := types.ListValueFrom(ctx, scenarioAdjustmentObjectType, rows)
	diags.Append(d...)

	return scenarioModelResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Description: stringValue(remote.Description),
		Currency:    types.StringValue(remote.Currency),
		Adjustment:  adjustments,
	}, diags
}
