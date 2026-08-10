package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/objectvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*billingRuleResource)(nil)
	_ resource.ResourceWithConfigure   = (*billingRuleResource)(nil)
	_ resource.ResourceWithImportState = (*billingRuleResource)(nil)
)

// billingRuleCurrencyPattern is an uppercase ISO 4217 code.
var billingRuleCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

// billingRuleChargeTypes is the closed set the API classifies every cost row
// into. Matching on it is how a rule targets, say, only commitment fees while
// leaving on-demand usage alone.
var billingRuleChargeTypes = []string{
	"usage", "commitment_covered_usage", "commitment_fee", "commitment_discount",
	"credit", "tax", "refund", "adjustment", "support", "other",
}

// NewBillingRuleResource constructs the infrawrench_billing_rule resource.
func NewBillingRuleResource() resource.Resource { return &billingRuleResource{} }

type billingRuleResource struct{ client *iw.Client }

type billingRuleMatchModel struct {
	TagKey     types.String `tfsdk:"tag_key"`
	TagValue   types.String `tfsdk:"tag_value"`
	AccountID  types.String `tfsdk:"account_id"`
	PluginID   types.String `tfsdk:"plugin_id"`
	Service    types.String `tfsdk:"service"`
	ChargeType types.String `tfsdk:"charge_type"`
}

var billingRuleMatchAttrTypes = map[string]attr.Type{
	"tag_key":     types.StringType,
	"tag_value":   types.StringType,
	"account_id":  types.StringType,
	"plugin_id":   types.StringType,
	"service":     types.StringType,
	"charge_type": types.StringType,
}

type billingRuleAdjustmentModel struct {
	Kind       types.String  `tfsdk:"kind"`
	Percent    types.Float64 `tfsdk:"percent"`
	Amount     types.Float64 `tfsdk:"amount"`
	Currency   types.String  `tfsdk:"currency"`
	Period     types.String  `tfsdk:"period"`
	TargetKind types.String  `tfsdk:"target_kind"`
	TargetID   types.String  `tfsdk:"target_id"`
}

var billingRuleAdjustmentAttrTypes = map[string]attr.Type{
	"kind":        types.StringType,
	"percent":     types.Float64Type,
	"amount":      types.Float64Type,
	"currency":    types.StringType,
	"period":      types.StringType,
	"target_kind": types.StringType,
	"target_id":   types.StringType,
}

type billingRuleResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Enabled     types.Bool   `tfsdk:"enabled"`
	Priority    types.Int64  `tfsdk:"priority"`
	Match       types.Object `tfsdk:"match"`
	Adjustment  types.Object `tfsdk:"adjustment"`
}

func (r *billingRuleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_billing_rule"
}

func (r *billingRuleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A rule that restates matched spend — a negotiated discount, an internal " +
			"markup, a flat platform fee, a reallocation onto another cost centre.\n\n" +
			"Rules are applied at **query** time and never written into stored cost rows. Nothing is " +
			"rewritten, backfilled or restated in the warehouse, so deleting a rule restores the raw " +
			"figures on the very next query and leaves no residue to clean up. That also means a rule " +
			"is retroactive by construction: it applies to every period the query covers, including " +
			"months that closed long before the rule existed.\n\n" +
			"Permissions on this object are asymmetric, and the asymmetry catches people out. " +
			"Reading a rule needs `costs:read`, but every write — create, update, delete — needs " +
			"`org:settings:write`, because a rule changes what every cost figure in the " +
			"organization reports. A token scoped to `costs:write` can therefore refresh this " +
			"resource perfectly well and then fail the apply with a 403. Grant " +
			"`org:settings:write` to whatever runs Terraform.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned rule id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Free text explaining why the rule exists, up to 2000 characters. " +
					"Clearing the attribute clears it on the rule.",
				Validators: []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Whether the rule participates in queries. Disabling is the reversible " +
					"way to see the raw numbers again without destroying the rule.",
			},
			"priority": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Evaluation order, 0–100000, lowest first. Unlike allocation rules, " +
					"billing rules do not stop at the first match: every enabled rule whose `match` " +
					"holds is applied, in this order.",
				Validators: []validator.Int64{int64validator.Between(0, 100000)},
			},
		},
		Blocks: map[string]schema.Block{
			"match": schema.SingleNestedBlock{
				MarkdownDescription: "Which cost rows the rule restates. Every field set is ANDed. " +
					"Omitting the block entirely matches all spend, which is a legitimate " +
					"organization-wide markup and a dangerous typo — say so in `description`.",
				Attributes: map[string]schema.Attribute{
					"tag_key": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Match rows carrying this tag key.",
					},
					"tag_value": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Narrow `tag_key` to a single value. Meaningless on its own, " +
							"so setting it without `tag_key` is a plan error.",
						Validators: []validator.String{
							stringvalidator.AlsoRequires(path.MatchRelative().AtParent().AtName("tag_key")),
						},
					},
					"account_id": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Match one connected account. See the `infrawrench_accounts` data source.",
					},
					"plugin_id": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Match every account of one provider plugin, e.g. `aws`.",
					},
					"service": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Match one provider service name as it appears in cost rows.",
					},
					"charge_type": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Match one class of charge. One of `" +
							joinBackticked(billingRuleChargeTypes) + "`.",
						Validators: []validator.String{oneOfValidator(billingRuleChargeTypes...)},
					},
				},
			},
			"adjustment": schema.SingleNestedBlock{
				MarkdownDescription: "What the rule does to the rows it matched. Required.",
				Attributes: map[string]schema.Attribute{
					"kind": schema.StringAttribute{
						Required: true,
						MarkdownDescription: "`percentage` to scale matched spend, `fixed` to add a flat " +
							"amount per period, `reallocation` to move matched spend onto another " +
							"cost centre or account without changing the total.",
						Validators: []validator.String{oneOfValidator("percentage", "fixed", "reallocation")},
					},
					"percent": schema.Float64Attribute{
						Optional: true,
						MarkdownDescription: "Percentage shift for a `percentage` rule, between -100 and " +
							"1000. `-15` applies a fifteen percent discount, `10` a ten percent " +
							"markup.\n\n" +
							"Percentage rules **compound**. Two matching rules of -10 and -10 do not " +
							"produce -20; the second applies to the output of the first and the result " +
							"is -19. Order therefore changes the answer, and order is `priority`.",
						Validators: []validator.Float64{float64validator.Between(-100, 1000)},
					},
					"amount": schema.Float64Attribute{
						Optional: true,
						MarkdownDescription: "Flat amount for a `fixed` rule, per `period`.\n\n" +
							"This is in the **major** unit of `currency` — 12.50 means twelve dollars " +
							"fifty, not twelve and a half cents. It is the one money field in this " +
							"provider that is not in minor units; everything named `*_cents` elsewhere " +
							"is. Getting it wrong is off by a hundred and the API cannot tell.",
					},
					"currency": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Uppercase ISO 4217 code that `amount` is denominated in, e.g. `USD`. " +
							"`fixed` rules only.",
						Validators: []validator.String{
							stringvalidator.RegexMatches(billingRuleCurrencyPattern,
								"must be a three-letter uppercase ISO 4217 code, e.g. USD"),
						},
					},
					"period": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "How often a `fixed` amount is charged, `daily` or `monthly`. " +
							"A `monthly` amount is pro-rated across the days a query actually covers, so " +
							"a half-month window carries half the fee rather than all of it.",
						Validators: []validator.String{oneOfValidator("daily", "monthly")},
					},
					"target_kind": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "What `target_id` names: `cost_centre` or `account`. Required " +
							"for `reallocation`, which has nowhere to move spend to without it; optional " +
							"for `fixed`, where it decides who is billed the fee.",
						Validators: []validator.String{oneOfValidator("cost_centre", "account")},
					},
					"target_id": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Id of the cost centre or account named by `target_kind`.",
					},
				},
				Validators: []validator.Object{objectvalidator.IsRequired()},
			},
		},
	}
}

func (r *billingRuleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *billingRuleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan billingRuleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := billingRuleInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateBillingRule(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create billing rule", err.Error())
		return
	}

	state, diags := billingRuleStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *billingRuleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state billingRuleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetBillingRule(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform: drop it from state so the next plan
		// recreates it, rather than failing the refresh.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read billing rule", err.Error())
		return
	}

	refreshed, diags := billingRuleStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *billingRuleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan billingRuleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state billingRuleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := billingRuleInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateBillingRule(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Billing rule no longer exists",
				"The billing rule was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update billing rule", err.Error())
		return
	}

	next, diags := billingRuleStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *billingRuleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state billingRuleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteBillingRule(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete billing rule", err.Error())
	}
}

func (r *billingRuleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func billingRuleInputFrom(ctx context.Context, model billingRuleResourceModel) (iw.BillingRuleInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	// A missing `match` block is not an error: it is the catch-all rule, and the
	// wire spells that as an object with no keys set rather than as a null.
	match := iw.BillingRuleMatch{}
	if !model.Match.IsNull() && !model.Match.IsUnknown() {
		var m billingRuleMatchModel
		diags.Append(model.Match.As(ctx, &m, basetypes.ObjectAsOptions{
			UnhandledNullAsEmpty:    true,
			UnhandledUnknownAsEmpty: true,
		})...)
		if diags.HasError() {
			return iw.BillingRuleInput{}, diags
		}
		match = iw.BillingRuleMatch{
			TagKey:     stringPtr(m.TagKey),
			TagValue:   stringPtr(m.TagValue),
			AccountID:  stringPtr(m.AccountID),
			PluginID:   stringPtr(m.PluginID),
			Service:    stringPtr(m.Service),
			ChargeType: stringPtr(m.ChargeType),
		}
	}

	adjustment := iw.BillingRuleAdjustment{}
	if !model.Adjustment.IsNull() && !model.Adjustment.IsUnknown() {
		var a billingRuleAdjustmentModel
		diags.Append(model.Adjustment.As(ctx, &a, basetypes.ObjectAsOptions{
			UnhandledNullAsEmpty:    true,
			UnhandledUnknownAsEmpty: true,
		})...)
		if diags.HasError() {
			return iw.BillingRuleInput{}, diags
		}
		adjustment = iw.BillingRuleAdjustment{
			Kind:       a.Kind.ValueString(),
			Percent:    float64Ptr(a.Percent),
			Amount:     float64Ptr(a.Amount),
			Currency:   stringPtr(a.Currency),
			Period:     stringPtr(a.Period),
			TargetKind: stringPtr(a.TargetKind),
			TargetID:   stringPtr(a.TargetID),
		}
	}

	return iw.BillingRuleInput{
		Name: model.Name.ValueString(),
		// Description has no omitempty on the wire, so a null attribute marshals
		// as an explicit JSON null and clears the stored description. That is what
		// removing the attribute from config should mean.
		Description: stringPtr(model.Description),
		Enabled:     model.Enabled.ValueBool(),
		Priority:    model.Priority.ValueInt64(),
		Match:       match,
		Adjustment:  adjustment,
	}, diags
}

// billingRuleStateFrom maps a server rule into Terraform state.
//
// `prior` is the plan (on write) or the previous state (on refresh). It matters
// for exactly one thing here: whether an all-empty match comes back as a null
// object or as an object of nulls. Terraform treats those as different values,
// and a config with no `match` block plans a null — so echoing an object would
// fail the apply with "provider produced inconsistent result". See
// billingRuleMatchTo.
func billingRuleStateFrom(ctx context.Context, remote *iw.BillingRule, prior billingRuleResourceModel) (billingRuleResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	match, d := billingRuleMatchTo(ctx, remote.Match, prior.Match)
	diags.Append(d...)

	adjustment, d := types.ObjectValueFrom(ctx, billingRuleAdjustmentAttrTypes, billingRuleAdjustmentModel{
		Kind:       types.StringValue(remote.Adjustment.Kind),
		Percent:    float64Value(remote.Adjustment.Percent),
		Amount:     float64Value(remote.Adjustment.Amount),
		Currency:   stringValue(remote.Adjustment.Currency),
		Period:     stringValue(remote.Adjustment.Period),
		TargetKind: stringValue(remote.Adjustment.TargetKind),
		TargetID:   stringValue(remote.Adjustment.TargetID),
	})
	diags.Append(d...)

	return billingRuleResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Description: stringValue(remote.Description),
		Enabled:     types.BoolValue(remote.Enabled),
		Priority:    types.Int64Value(remote.Priority),
		Match:       match,
		Adjustment:  adjustment,
	}, diags
}

// billingRuleMatchTo renders the match object, preserving the null/empty
// distinction the practitioner's configuration established.
//
// A catch-all rule is written with no `match` block at all, which Terraform
// plans as a null object; the server round-trips it as `{}` and the naive
// mapping would hand back an object whose six attributes are all null. Those
// are not the same value to Terraform. Keeping null when the prior value was
// null — and only when the server genuinely returned nothing — means a
// catch-all rule refreshes clean, while a match added outside Terraform still
// shows up as drift.
func billingRuleMatchTo(ctx context.Context, m iw.BillingRuleMatch, prior types.Object) (types.Object, diag.Diagnostics) {
	empty := m.TagKey == nil && m.TagValue == nil && m.AccountID == nil &&
		m.PluginID == nil && m.Service == nil && m.ChargeType == nil
	if empty && (prior.IsNull() || prior.IsUnknown()) {
		return types.ObjectNull(billingRuleMatchAttrTypes), nil
	}
	return types.ObjectValueFrom(ctx, billingRuleMatchAttrTypes, billingRuleMatchModel{
		TagKey:     stringValue(m.TagKey),
		TagValue:   stringValue(m.TagValue),
		AccountID:  stringValue(m.AccountID),
		PluginID:   stringValue(m.PluginID),
		Service:    stringValue(m.Service),
		ChargeType: stringValue(m.ChargeType),
	})
}
