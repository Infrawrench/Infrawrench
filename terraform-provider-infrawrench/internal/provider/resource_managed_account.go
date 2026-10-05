package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/float64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*managedAccountResource)(nil)
	_ resource.ResourceWithConfigure      = (*managedAccountResource)(nil)
	_ resource.ResourceWithImportState    = (*managedAccountResource)(nil)
	_ resource.ResourceWithValidateConfig = (*managedAccountResource)(nil)
)

// NewManagedAccountResource constructs the infrawrench_managed_account resource.
func NewManagedAccountResource() resource.Resource { return &managedAccountResource{} }

type managedAccountResource struct{ client *iw.Client }

type managedAccountResourceModel struct {
	ID                types.String `tfsdk:"id"`
	Name              types.String `tfsdk:"name"`
	ContactName       types.String `tfsdk:"contact_name"`
	ContactEmail      types.String `tfsdk:"contact_email"`
	BillingAddress    types.String `tfsdk:"billing_address"`
	BillingCurrency   types.String `tfsdk:"billing_currency"`
	CostBasis         types.String `tfsdk:"cost_basis"`
	ApplyBillingRules types.Bool   `tfsdk:"apply_billing_rules"`
	Notes             types.String `tfsdk:"notes"`
	CostCentreIDs     types.Set    `tfsdk:"cost_centre_ids"`
	AccountIDs        types.Set    `tfsdk:"account_ids"`
	InvoiceCount      types.Int64  `tfsdk:"invoice_count"`

	// Pricing, flattened so every attribute can carry its own default and a
	// configuration that sets one of them plans cleanly against the rest.
	RerateToListPrice               types.Bool    `tfsdk:"rerate_to_list_price"`
	RerateProviders                 types.List    `tfsdk:"rerate_providers"`
	RerateFallbackUpliftPercent     types.Float64 `tfsdk:"rerate_fallback_uplift_percent"`
	RerateUplifts                   types.List    `tfsdk:"rerate_uplifts"`
	DiscountTreatment               types.String  `tfsdk:"discount_treatment"`
	DiscountPassThroughPercent      types.Float64 `tfsdk:"discount_pass_through_percent"`
	CreditTreatment                 types.String  `tfsdk:"credit_treatment"`
	CreditPassThroughPercent        types.Float64 `tfsdk:"credit_pass_through_percent"`
	CommitmentBenefitTreatment      types.String  `tfsdk:"commitment_benefit_treatment"`
	CommitmentBenefitPassThroughPct types.Float64 `tfsdk:"commitment_benefit_pass_through_percent"`
}

type pricingScopeModel struct {
	PluginID types.String `tfsdk:"plugin_id"`
	Service  types.String `tfsdk:"service"`
}

type pricingUpliftModel struct {
	PluginID types.String  `tfsdk:"plugin_id"`
	Service  types.String  `tfsdk:"service"`
	Percent  types.Float64 `tfsdk:"percent"`
}

var pricingScopeAttrTypes = map[string]attr.Type{
	"plugin_id": types.StringType,
	"service":   types.StringType,
}

var pricingUpliftAttrTypes = map[string]attr.Type{
	"plugin_id": types.StringType,
	"service":   types.StringType,
	"percent":   types.Float64Type,
}

var managedAccountCostBases = []string{"cash", "amortized"}

// discountTreatmentModes is the closed set for the three *_treatment attributes.
var discountTreatmentModes = []string{"pass_through", "partial", "retain"}

func treatmentAttribute(what string) schema.StringAttribute {
	return schema.StringAttribute{
		Optional: true,
		Computed: true,
		Default:  stringdefault.StaticString("pass_through"),
		MarkdownDescription: "What happens to " + what + " on this customer's invoices: `pass_through` " +
			"(the default) gives the customer all of it, `retain` keeps all of it, `partial` gives the " +
			"customer the share in the matching `*_pass_through_percent`.",
		Validators: []validator.String{oneOfValidator(discountTreatmentModes...)},
	}
}

func passThroughAttribute(what string) schema.Float64Attribute {
	return schema.Float64Attribute{
		Optional: true,
		MarkdownDescription: "With a `partial` treatment, the share of " + what + " the customer " +
			"receives, strictly between 0 and 100. Required with `partial` and refused with any other " +
			"treatment, so a stale share cannot sit in configuration doing nothing.",
		Validators: []validator.Float64{betweenFloat(0, 100)},
	}
}

func (r *managedAccountResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_managed_account"
}

func (r *managedAccountResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A customer a managed service provider bills.\n\n" +
			"Its scope is a set of existing cost centres and cloud accounts rather than a rule of its own. " +
			"That is deliberate: which spend lands in which centre is already decided by " +
			"`infrawrench_allocation_rule`, and a second vocabulary over the same data would eventually " +
			"disagree with the first — at which point an invoice would stop matching the showback report " +
			"the customer was shown.\n\n" +
			"A cost centre or cloud account belongs to **at most one** managed account. Claiming one twice " +
			"is refused with a 409 naming the other customer.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned customer id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Customer name, 1–120 characters. Appears on their invoices.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"contact_name": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Billing contact, up to 120 characters.",
			},
			"contact_email": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Where invoices are sent, up to 254 characters.",
			},
			"billing_address": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Address printed on the invoice, up to 1000 characters.",
			},
			"billing_currency": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "ISO 4217 code the customer is invoiced in, e.g. `GBP`.\n\n" +
					"Spend collected in another currency is converted through the organization's own " +
					"`infrawrench_exchange_rate` table, and the rate used is **frozen onto every invoice** — " +
					"so restating a rate later cannot restate history.",
			},
			"cost_basis": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("amortized"),
				MarkdownDescription: "One of `" + joinBackticked(managedAccountCostBases) + "`. Defaults to " +
					"`amortized`: charging a customer the whole cash value of a three-year commitment in the " +
					"month it was signed is not a bill anyone can budget against.",
				Validators: []validatorString{oneOfValidator(managedAccountCostBases...)},
			},
			"apply_billing_rules": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Defaults to `true`. `false` is a pass-through contract: the customer is " +
					"billed exactly what the providers charged, with no markup, discount or fixed fee from " +
					"`infrawrench_billing_rule` applied.",
			},
			"notes": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Internal notes, up to 4000 characters. Not shown to the customer.",
			},
			"cost_centre_ids": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Cost centres whose spend belongs to this customer, at most 100.\n\n" +
					"**Subtrees are included** — naming a parent bills every descendant, and naming both a " +
					"parent and its child bills the child once, not twice.",
			},
			"account_ids": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Cloud accounts whose spend belongs to this customer, at most 100.\n\n" +
					"Evaluated **after** every allocation rule, so an account in scope claims only the spend no " +
					"cost centre already claimed. Every cost row therefore resolves exactly once: nothing is " +
					"billed twice and nothing goes missing.",
			},

			"rerate_to_list_price": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "Present this customer's usage at the providers' public on-demand list " +
					"price instead of what the organization paid. Where a provider reports a list price for a " +
					"line (GCP's `cost_at_list`, AWS on-demand usage, and providers whose amounts are list " +
					"prices by construction) it is used; elsewhere the line is billed at its collected amount " +
					"plus `rerate_fallback_uplift_percent`, and every invoice reports how much went each way. " +
					"Applied when the invoice is computed; collected spend is never rewritten.",
			},
			"rerate_providers": schema.ListNestedAttribute{
				Optional: true,
				Computed: true,
				Default: listdefault.StaticValue(types.ListValueMust(
					types.ObjectType{AttrTypes: pricingScopeAttrTypes}, []attr.Value{})),
				MarkdownDescription: "Providers, or single services of a provider, to re-rate, at most 100. " +
					"Empty (the default) re-rates every provider. See the `infrawrench_plugins` data source " +
					"for provider ids.",
				Validators: []validator.List{sizeAtMost(100)},
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"plugin_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Provider plugin id, e.g. `aws`.",
						},
						"service": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "One service as it appears in cost rows; unset means all of them.",
						},
					},
				},
			},
			"rerate_fallback_uplift_percent": schema.Float64Attribute{
				Optional: true,
				Computed: true,
				Default:  float64default.StaticFloat64(0),
				MarkdownDescription: "Uplift applied to re-rated usage that has no reported list price, " +
					"between -100 and 1000. Defaults to 0.",
				Validators: []validator.Float64{betweenFloat(-100, 1000)},
			},
			"rerate_uplifts": schema.ListNestedAttribute{
				Optional: true,
				Computed: true,
				Default: listdefault.StaticValue(types.ListValueMust(
					types.ObjectType{AttrTypes: pricingUpliftAttrTypes}, []attr.Value{})),
				MarkdownDescription: "Per-provider or per-service overrides of the fallback uplift, at most " +
					"100. The most specific entry wins.",
				Validators: []validator.List{sizeAtMost(100)},
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"plugin_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Provider plugin id, e.g. `aws`.",
						},
						"service": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "One service; unset applies to the whole provider.",
						},
						"percent": schema.Float64Attribute{
							Required:            true,
							MarkdownDescription: "Uplift, between -100 and 1000.",
							Validators:          []validator.Float64{betweenFloat(-100, 1000)},
						},
					},
				},
			},
			"discount_treatment": treatmentAttribute("provider discounts (enterprise agreements, private " +
				"pricing, Savings Plan negation lines)"),
			"discount_pass_through_percent": passThroughAttribute("provider discounts"),
			"credit_treatment":              treatmentAttribute("provider credits"),
			"credit_pass_through_percent":   passThroughAttribute("credits"),
			"commitment_benefit_treatment": treatmentAttribute("reservation and Savings Plan benefits on " +
				"covered usage (measurable only where the provider reports a list price)"),
			"commitment_benefit_pass_through_percent": passThroughAttribute("commitment benefits"),

			"invoice_count": schema.Int64Attribute{
				Computed: true,
				MarkdownDescription: "How many invoices this customer has. Useful as a guard before a destroy: " +
					"it is the count of financial records that exist against them.",
			},
		},
	}
}

// ValidateConfig pairs each treatment with its percentage at plan time, so a
// mismatch is a plan error rather than an apply that echoes back different
// values.
func (r *managedAccountResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config managedAccountResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	pairs := []struct {
		mode    types.String
		percent types.Float64
		modeKey string
		pctKey  string
	}{
		{config.DiscountTreatment, config.DiscountPassThroughPercent, "discount_treatment", "discount_pass_through_percent"},
		{config.CreditTreatment, config.CreditPassThroughPercent, "credit_treatment", "credit_pass_through_percent"},
		{config.CommitmentBenefitTreatment, config.CommitmentBenefitPassThroughPct, "commitment_benefit_treatment", "commitment_benefit_pass_through_percent"},
	}
	for _, p := range pairs {
		if p.mode.IsUnknown() || p.percent.IsUnknown() {
			continue
		}
		partial := p.mode.ValueString() == "partial"
		if partial && p.percent.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root(p.pctKey), "Missing pass-through share",
				"`"+p.modeKey+" = \"partial\"` needs `"+p.pctKey+"`.")
		}
		if !partial && !p.percent.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root(p.pctKey), "Pass-through share without partial",
				"`"+p.pctKey+"` only applies when `"+p.modeKey+" = \"partial\"`.")
		}
		if partial && !p.percent.IsNull() {
			v := p.percent.ValueFloat64()
			if v <= 0 || v >= 100 {
				resp.Diagnostics.AddAttributeError(path.Root(p.pctKey), "Pass-through share out of range",
					"A partial share must be strictly between 0 and 100; use pass_through or retain for the ends.")
			}
		}
	}
}

func (r *managedAccountResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *managedAccountResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan managedAccountResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := managedAccountInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateManagedAccount(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create managed account", err.Error())
		return
	}

	state, diags := managedAccountStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *managedAccountResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state managedAccountResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetManagedAccount(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read managed account", err.Error())
		return
	}

	refreshed, diags := managedAccountStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *managedAccountResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan managedAccountResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state managedAccountResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := managedAccountInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateManagedAccount(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Managed account no longer exists",
				"The customer was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update managed account", err.Error())
		return
	}

	next, diags := managedAccountStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the customer.
//
// The server refuses while invoices exist against them, and that failure is
// surfaced rather than worked around: an invoice is a financial record, and a
// `terraform destroy` is not the right instrument for discarding one.
func (r *managedAccountResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state managedAccountResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteManagedAccount(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete managed account", err.Error())
	}
}

func (r *managedAccountResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func managedAccountInputFrom(ctx context.Context, model managedAccountResourceModel) (iw.ManagedAccountInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	centres := []string{}
	if !model.CostCentreIDs.IsNull() && !model.CostCentreIDs.IsUnknown() {
		diags.Append(model.CostCentreIDs.ElementsAs(ctx, &centres, false)...)
	}
	accounts := []string{}
	if !model.AccountIDs.IsNull() && !model.AccountIDs.IsUnknown() {
		diags.Append(model.AccountIDs.ElementsAs(ctx, &accounts, false)...)
	}
	if diags.HasError() {
		return iw.ManagedAccountInput{}, diags
	}

	pricing := iw.ManagedAccountPricing{
		Rerate: iw.ManagedAccountRerate{
			Enabled:               model.RerateToListPrice.ValueBool(),
			Scope:                 []iw.PricingScopeEntry{},
			FallbackUpliftPercent: model.RerateFallbackUpliftPercent.ValueFloat64(),
			Uplifts:               []iw.PricingUplift{},
		},
		Discounts:          treatmentFrom(model.DiscountTreatment, model.DiscountPassThroughPercent),
		Credits:            treatmentFrom(model.CreditTreatment, model.CreditPassThroughPercent),
		CommitmentBenefits: treatmentFrom(model.CommitmentBenefitTreatment, model.CommitmentBenefitPassThroughPct),
	}
	if !model.RerateProviders.IsNull() && !model.RerateProviders.IsUnknown() {
		var scope []pricingScopeModel
		diags.Append(model.RerateProviders.ElementsAs(ctx, &scope, false)...)
		for _, s := range scope {
			pricing.Rerate.Scope = append(pricing.Rerate.Scope, iw.PricingScopeEntry{
				PluginID: s.PluginID.ValueString(),
				Service:  stringPtr(s.Service),
			})
		}
	}
	if !model.RerateUplifts.IsNull() && !model.RerateUplifts.IsUnknown() {
		var uplifts []pricingUpliftModel
		diags.Append(model.RerateUplifts.ElementsAs(ctx, &uplifts, false)...)
		for _, u := range uplifts {
			pricing.Rerate.Uplifts = append(pricing.Rerate.Uplifts, iw.PricingUplift{
				PluginID: u.PluginID.ValueString(),
				Service:  stringPtr(u.Service),
				Percent:  u.Percent.ValueFloat64(),
			})
		}
	}

	return iw.ManagedAccountInput{
		Pricing:           &pricing,
		Name:              model.Name.ValueString(),
		ContactName:       stringPtr(model.ContactName),
		ContactEmail:      stringPtr(model.ContactEmail),
		BillingAddress:    stringPtr(model.BillingAddress),
		BillingCurrency:   model.BillingCurrency.ValueString(),
		CostBasis:         stringPtr(model.CostBasis),
		ApplyBillingRules: boolPtr(model.ApplyBillingRules),
		Notes:             stringPtr(model.Notes),
		CostCentreIDs:     centres,
		AccountIDs:        accounts,
	}, diags
}

// managedAccountStateFrom maps a customer into state.
//
// Both id sets are mapped faithfully, `[]` included. They are Optional and
// Computed, so a configuration that omits one (a customer scoped by accounts
// only, say) leaves an unknown that the server's `[]` satisfies; folding `[]`
// to null instead would fail the consistency check for a configuration that
// writes the empty set out.
func managedAccountStateFrom(ctx context.Context, remote *iw.ManagedAccount) (managedAccountResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	centres, d := nilStringSet(ctx, remote.CostCentreIDs)
	diags.Append(d...)
	accounts, d := nilStringSet(ctx, remote.AccountIDs)
	diags.Append(d...)

	p := remote.Pricing
	if p.Discounts.Mode == "" {
		p.Discounts.Mode = "pass_through"
	}
	if p.Credits.Mode == "" {
		p.Credits.Mode = "pass_through"
	}
	if p.CommitmentBenefits.Mode == "" {
		p.CommitmentBenefits.Mode = "pass_through"
	}
	scopeModels := make([]pricingScopeModel, 0, len(p.Rerate.Scope))
	for _, s := range p.Rerate.Scope {
		scopeModels = append(scopeModels, pricingScopeModel{
			PluginID: types.StringValue(s.PluginID),
			Service:  stringValue(s.Service),
		})
	}
	scope, d := types.ListValueFrom(ctx, types.ObjectType{AttrTypes: pricingScopeAttrTypes}, scopeModels)
	diags.Append(d...)
	upliftModels := make([]pricingUpliftModel, 0, len(p.Rerate.Uplifts))
	for _, u := range p.Rerate.Uplifts {
		upliftModels = append(upliftModels, pricingUpliftModel{
			PluginID: types.StringValue(u.PluginID),
			Service:  stringValue(u.Service),
			Percent:  types.Float64Value(u.Percent),
		})
	}
	uplifts, d := types.ListValueFrom(ctx, types.ObjectType{AttrTypes: pricingUpliftAttrTypes}, upliftModels)
	diags.Append(d...)

	return managedAccountResourceModel{
		ID:                types.StringValue(remote.ID),
		Name:              types.StringValue(remote.Name),
		ContactName:       stringValue(remote.ContactName),
		ContactEmail:      stringValue(remote.ContactEmail),
		BillingAddress:    stringValue(remote.BillingAddress),
		BillingCurrency:   types.StringValue(remote.BillingCurrency),
		CostBasis:         types.StringValue(remote.CostBasis),
		ApplyBillingRules: types.BoolValue(remote.ApplyBillingRules),
		Notes:             stringValue(remote.Notes),
		CostCentreIDs:     centres,
		AccountIDs:        accounts,
		InvoiceCount:      types.Int64Value(remote.InvoiceCount),

		RerateToListPrice:               types.BoolValue(p.Rerate.Enabled),
		RerateProviders:                 scope,
		RerateFallbackUpliftPercent:     types.Float64Value(p.Rerate.FallbackUpliftPercent),
		RerateUplifts:                   uplifts,
		DiscountTreatment:               types.StringValue(p.Discounts.Mode),
		DiscountPassThroughPercent:      float64Value(p.Discounts.PassThroughPercent),
		CreditTreatment:                 types.StringValue(p.Credits.Mode),
		CreditPassThroughPercent:        float64Value(p.Credits.PassThroughPercent),
		CommitmentBenefitTreatment:      types.StringValue(p.CommitmentBenefits.Mode),
		CommitmentBenefitPassThroughPct: float64Value(p.CommitmentBenefits.PassThroughPercent),
	}, diags
}

// treatmentFrom builds one discount treatment. The percentage is only sent for
// `partial`; the API drops it otherwise, and sending it would read back as drift.
func treatmentFrom(mode types.String, percent types.Float64) iw.DiscountTreatment {
	m := mode.ValueString()
	if m == "" {
		m = "pass_through"
	}
	t := iw.DiscountTreatment{Mode: m}
	if m == "partial" {
		t.PassThroughPercent = float64Ptr(percent)
	}
	return t
}
