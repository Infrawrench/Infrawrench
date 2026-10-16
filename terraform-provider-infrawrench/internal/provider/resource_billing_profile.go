package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*billingProfileResource)(nil)
	_ resource.ResourceWithConfigure   = (*billingProfileResource)(nil)
	_ resource.ResourceWithImportState = (*billingProfileResource)(nil)
)

// NewBillingProfileResource constructs the infrawrench_billing_profile resource.
func NewBillingProfileResource() resource.Resource { return &billingProfileResource{} }

type billingProfileResource struct{ client *iw.Client }

type billingProfileResourceModel struct {
	ID                 types.String `tfsdk:"id"`
	Name               types.String `tfsdk:"name"`
	LegalName          types.String `tfsdk:"legal_name"`
	Address            types.String `tfsdk:"address"`
	TaxID              types.String `tfsdk:"tax_id"`
	PONumber           types.String `tfsdk:"po_number"`
	ToEmails           types.Set    `tfsdk:"to_emails"`
	CcEmails           types.Set    `tfsdk:"cc_emails"`
	Currency           types.String `tfsdk:"currency"`
	PaymentTermsDays   types.Int64  `tfsdk:"payment_terms_days"`
	NumberPrefix       types.String `tfsdk:"invoice_number_prefix"`
	NumberIncludesYear types.Bool   `tfsdk:"invoice_number_includes_year"`
	NumberStart        types.Int64  `tfsdk:"invoice_number_start"`
	TaxRates           types.List   `tfsdk:"tax_rates"`
	Footer             types.String `tfsdk:"footer"`
	Logo               types.String `tfsdk:"logo"`

	// Bank details, flattened like the managed account's pricing so each one
	// can be set on its own and an all-empty block reads back as all null.
	BankAccountName        types.String `tfsdk:"bank_account_name"`
	BankName               types.String `tfsdk:"bank_name"`
	IBAN                   types.String `tfsdk:"iban"`
	BIC                    types.String `tfsdk:"bic"`
	BankAccountNumber      types.String `tfsdk:"bank_account_number"`
	BankRoutingNumber      types.String `tfsdk:"bank_routing_number"`
	RemittanceInstructions types.String `tfsdk:"remittance_instructions"`
}

type billingTaxRateModel struct {
	Name types.String  `tfsdk:"name"`
	Rate types.Float64 `tfsdk:"rate"`
}

var billingTaxRateAttrTypes = map[string]attr.Type{
	"name": types.StringType,
	"rate": types.Float64Type,
}

// The API normalises these on write; refusing the other spellings at plan time
// is what keeps an apply from reading back a value that differs from config.
var (
	billingCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
	billingPrefixPattern   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$|^[A-Za-z]$`)
	// Grouped in fours, upper case: how the API stores an IBAN.
	billingIBANPattern = regexp.MustCompile(`^[A-Z]{2}[0-9]{2}( [A-Z0-9]{4})*( [A-Z0-9]{1,3})?$`)
	billingBICPattern  = regexp.MustCompile(`^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$`)
	// Lower case: the API lowercases addresses.
	billingEmailPattern = regexp.MustCompile(`^[^\sA-Z@,;]+@[^\sA-Z@,;.]+(\.[^\sA-Z@,;.]+)+$`)
	billingLogoPattern  = regexp.MustCompile(`^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$`)
)

func (r *billingProfileResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_billing_profile"
}

func optionalText(description string, maxLength int) schema.StringAttribute {
	return schema.StringAttribute{
		Optional:            true,
		MarkdownDescription: description,
		Validators:          []validatorString{stringvalidator.LengthBetween(1, maxLength)},
	}
}

func (r *billingProfileResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	emailElements := []validator.String{stringvalidator.RegexMatches(billingEmailPattern,
		"must be an email address in lower case")}
	resp.Schema = schema.Schema{
		MarkdownDescription: "Reusable invoice settings that `infrawrench_managed_account` customers are " +
			"assigned to with `billing_profile_id`: who invoices are addressed to, who receives them, the " +
			"invoice currency, payment terms, tax lines, remittance details and numbering.\n\n" +
			"**The profile wins where it sets a field, and each customer fills the gaps**: leave " +
			"`legal_name` unset and every customer's own name heads its invoices. Recipients are the union " +
			"of the customer's contact email and `to_emails`.\n\n" +
			"Only draft invoices follow an edit. Approval writes a resolved copy of the profile onto the " +
			"invoice, so a new bank account or tax rate reaches the next invoice and never an issued one.\n\n" +
			"Deleting a profile is refused while live customers are assigned to it; Terraform destroys " +
			"dependent managed accounts first, which retires them.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned profile id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "What the profile is called in pickers, 1–120 characters, unique in the " +
					"organization. Not printed on invoices.",
				Validators: []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"legal_name": optionalText("The legal entity invoices are addressed to, 1–200 characters. "+
				"Unset leaves each customer's own name.", 200),
			"address": optionalText("Postal address printed under the legal name, 1–1000 characters. "+
				"Unset leaves each customer's billing address.", 1000),
			"tax_id": optionalText("The addressee's tax ID or VAT number, 1–64 characters.", 64),
			"po_number": optionalText("Purchase-order reference printed on every invoice, 1–64 "+
				"characters.", 64),
			"to_emails": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     setdefault.StaticValue(types.SetValueMust(types.StringType, []attr.Value{})),
				MarkdownDescription: "Addresses invoices are emailed to **in addition to** each customer's " +
					"contact email, in lower case. At most 20.",
				Validators: []validatorSet{setSizeAtMost(20), setvalidator.ValueStringsAre(emailElements...)},
			},
			"cc_emails": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     setdefault.StaticValue(types.SetValueMust(types.StringType, []attr.Value{})),
				MarkdownDescription: "Addresses that receive a copy of every invoice, in lower case. At most " +
					"20. Each address gets its own message, so nobody's address is shown to anyone else.",
				Validators: []validatorSet{setSizeAtMost(20), setvalidator.ValueStringsAre(emailElements...)},
			},
			"currency": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "ISO 4217 code in upper case, e.g. `EUR`. When set, invoices for every " +
					"assigned customer are issued in this currency instead of the customer's " +
					"`billing_currency`; spend in other currencies converts through " +
					"`infrawrench_exchange_rate`.",
				Validators: []validatorString{stringvalidator.RegexMatches(billingCurrencyPattern,
					"must be a three-letter ISO 4217 code in upper case")},
			},
			"payment_terms_days": schema.Int64Attribute{
				Optional: true,
				MarkdownDescription: "Net N days from the issue date, 0–365; the invoice prints the due date " +
					"it gives. 0 is due on receipt; unset prints no due date.",
				Validators: []validator.Int64{between(0, 365)},
			},
			"invoice_number_prefix": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("INV"),
				MarkdownDescription: "Invoice number prefix, 1–16 letters, digits and hyphens, starting with a " +
					"letter. Defaults to `INV`. Profiles sharing a prefix share a sequence.",
				Validators: []validatorString{
					stringvalidator.LengthBetween(1, 16),
					stringvalidator.RegexMatches(billingPrefixPattern,
						"must start with a letter, use letters, digits and hyphens, and not end with a hyphen"),
				},
			},
			"invoice_number_includes_year": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Defaults to `true`: `INV-2026-0001`, the sequence restarting each year " +
					"of the period end. `false` gives `INV-0001` and one sequence for ever.",
			},
			"invoice_number_start": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(1),
				MarkdownDescription: "The lowest sequence number issued, 1–999999999, for continuing a " +
					"sequence from another system. Defaults to 1.",
				Validators: []validator.Int64{between(1, 999999999)},
			},
			"tax_rates": schema.ListNestedAttribute{
				Optional: true,
				Computed: true,
				Default: listdefault.StaticValue(types.ListValueMust(
					types.ObjectType{AttrTypes: billingTaxRateAttrTypes}, []attr.Value{})),
				MarkdownDescription: "Taxes added to every invoice as their own lines, at most 5. Each is " +
					"charged on the same converted subtotal (they do not compound) and rounded to the " +
					"currency's minor unit.",
				Validators: []validator.List{sizeAtMost(5)},
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"name": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Printed on the line, e.g. `VAT`, 1–40 characters.",
							Validators:          []validatorString{stringvalidator.LengthBetween(1, 40)},
						},
						"rate": schema.Float64Attribute{
							Required:            true,
							MarkdownDescription: "Percent, 0–100, at most four decimal places.",
							Validators:          []validator.Float64{betweenFloat(0, 100)},
						},
					},
				},
			},
			"footer": optionalText("Printed at the bottom of every page of the PDF, 1–2000 characters: "+
				"terms, a registration number, a thank-you.", 2000),
			"logo": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "A PNG or JPEG `data:` URL of at most 100 KB, printed at the top of the " +
					"PDF, e.g. `\"data:image/png;base64,${filebase64(\"logo.png\")}\"`. Interlaced and 16-bit " +
					"PNGs and CMYK JPEGs are refused by the API.",
				Validators: []validatorString{
					stringvalidator.RegexMatches(billingLogoPattern, "must be a PNG or JPEG base64 data URL"),
					stringvalidator.LengthAtMost(140000),
				},
			},

			"bank_account_name": optionalText("Name on the bank account, 1–120 characters.", 120),
			"bank_name":         optionalText("Bank name, 1–120 characters.", 120),
			"iban": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "IBAN, upper case and grouped in fours as a bank prints it, e.g. " +
					"`GB82 WEST 1234 5698 7654 32`; its check digits are verified by the API. Masked to its " +
					"last four characters in the organization's audit log.",
				Validators: []validatorString{stringvalidator.RegexMatches(billingIBANPattern,
					"must be upper case and grouped in fours, like GB82 WEST 1234 5698 7654 32")},
			},
			"bic": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "SWIFT/BIC code, 8 or 11 upper-case letters and digits, e.g. `WESTGB2L`.",
				Validators: []validatorString{stringvalidator.RegexMatches(billingBICPattern,
					"must be 8 or 11 upper-case letters and digits")},
			},
			"bank_account_number": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "Account number for banking systems without IBANs, 1–64 characters. " +
					"Masked in the audit log.",
				Validators: []validatorString{stringvalidator.LengthBetween(1, 64)},
			},
			"bank_routing_number": optionalText("Sort code, ABA routing number or BSB, 1–64 characters.", 64),
			"remittance_instructions": optionalText("Free-text payment instructions printed under the bank "+
				"details, 1–2000 characters.", 2000),
		},
	}
}

func (r *billingProfileResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *billingProfileResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan billingProfileResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := billingProfileInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateBillingProfile(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create billing profile", err.Error())
		return
	}
	state, diags := billingProfileStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *billingProfileResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state billingProfileResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetBillingProfile(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read billing profile", err.Error())
		return
	}
	refreshed, diags := billingProfileStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *billingProfileResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan billingProfileResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state billingProfileResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := billingProfileInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateBillingProfile(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Billing profile no longer exists",
				"The profile was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update billing profile", err.Error())
		return
	}
	next, diags := billingProfileStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the profile. The API refuses while live customers are
// assigned to it, naming them; that is surfaced as is, because quietly
// unassigning them would change the address, tax and numbering of their next
// invoice.
func (r *billingProfileResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state billingProfileResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteBillingProfile(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete billing profile", err.Error())
	}
}

func (r *billingProfileResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func billingProfileInputFrom(ctx context.Context, model billingProfileResourceModel) (iw.BillingProfileInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	to := []string{}
	if !model.ToEmails.IsNull() && !model.ToEmails.IsUnknown() {
		diags.Append(model.ToEmails.ElementsAs(ctx, &to, false)...)
	}
	cc := []string{}
	if !model.CcEmails.IsNull() && !model.CcEmails.IsUnknown() {
		diags.Append(model.CcEmails.ElementsAs(ctx, &cc, false)...)
	}
	taxes := []iw.BillingProfileTaxRate{}
	if !model.TaxRates.IsNull() && !model.TaxRates.IsUnknown() {
		var rows []billingTaxRateModel
		diags.Append(model.TaxRates.ElementsAs(ctx, &rows, false)...)
		for _, row := range rows {
			taxes = append(taxes, iw.BillingProfileTaxRate{
				Name: row.Name.ValueString(),
				Rate: row.Rate.ValueFloat64(),
			})
		}
	}
	if diags.HasError() {
		return iw.BillingProfileInput{}, diags
	}

	bank := &iw.BillingProfileBank{
		AccountName:   stringPtr(model.BankAccountName),
		BankName:      stringPtr(model.BankName),
		IBAN:          stringPtr(model.IBAN),
		BIC:           stringPtr(model.BIC),
		AccountNumber: stringPtr(model.BankAccountNumber),
		RoutingNumber: stringPtr(model.BankRoutingNumber),
		Instructions:  stringPtr(model.RemittanceInstructions),
	}
	if *bank == (iw.BillingProfileBank{}) {
		bank = nil
	}

	prefix := model.NumberPrefix.ValueString()
	if prefix == "" {
		prefix = "INV"
	}
	start := model.NumberStart.ValueInt64()
	if start < 1 {
		start = 1
	}
	includeYear := true
	if !model.NumberIncludesYear.IsNull() && !model.NumberIncludesYear.IsUnknown() {
		includeYear = model.NumberIncludesYear.ValueBool()
	}

	return iw.BillingProfileInput{
		Name:               model.Name.ValueString(),
		LegalName:          stringPtr(model.LegalName),
		Address:            stringPtr(model.Address),
		TaxID:              stringPtr(model.TaxID),
		PONumber:           stringPtr(model.PONumber),
		ToEmails:           to,
		CcEmails:           cc,
		Currency:           stringPtr(model.Currency),
		PaymentTermsDays:   int64Ptr(model.PaymentTermsDays),
		NumberPrefix:       prefix,
		NumberIncludesYear: includeYear,
		NumberStart:        start,
		TaxRates:           taxes,
		Bank:               bank,
		Footer:             stringPtr(model.Footer),
		Logo:               stringPtr(model.Logo),
	}, diags
}

func billingProfileStateFrom(ctx context.Context, remote *iw.BillingProfile) (billingProfileResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	toValues := remote.ToEmails
	if toValues == nil {
		toValues = []string{}
	}
	to, d := types.SetValueFrom(ctx, types.StringType, toValues)
	diags.Append(d...)
	ccValues := remote.CcEmails
	if ccValues == nil {
		ccValues = []string{}
	}
	cc, d := types.SetValueFrom(ctx, types.StringType, ccValues)
	diags.Append(d...)

	taxModels := make([]billingTaxRateModel, 0, len(remote.TaxRates))
	for _, t := range remote.TaxRates {
		taxModels = append(taxModels, billingTaxRateModel{
			Name: types.StringValue(t.Name),
			Rate: types.Float64Value(t.Rate),
		})
	}
	taxes, d := types.ListValueFrom(ctx, types.ObjectType{AttrTypes: billingTaxRateAttrTypes}, taxModels)
	diags.Append(d...)

	bank := remote.Bank
	if bank == nil {
		bank = &iw.BillingProfileBank{}
	}

	return billingProfileResourceModel{
		ID:                 types.StringValue(remote.ID),
		Name:               types.StringValue(remote.Name),
		LegalName:          stringValue(remote.LegalName),
		Address:            stringValue(remote.Address),
		TaxID:              stringValue(remote.TaxID),
		PONumber:           stringValue(remote.PONumber),
		ToEmails:           to,
		CcEmails:           cc,
		Currency:           stringValue(remote.Currency),
		PaymentTermsDays:   int64Value(remote.PaymentTermsDays),
		NumberPrefix:       types.StringValue(remote.NumberPrefix),
		NumberIncludesYear: types.BoolValue(remote.NumberIncludesYear),
		NumberStart:        types.Int64Value(remote.NumberStart),
		TaxRates:           taxes,
		Footer:             stringValue(remote.Footer),
		Logo:               stringValue(remote.Logo),

		BankAccountName:        stringValue(bank.AccountName),
		BankName:               stringValue(bank.BankName),
		IBAN:                   stringValue(bank.IBAN),
		BIC:                    stringValue(bank.BIC),
		BankAccountNumber:      stringValue(bank.AccountNumber),
		BankRoutingNumber:      stringValue(bank.RoutingNumber),
		RemittanceInstructions: stringValue(bank.Instructions),
	}, diags
}
