package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*managedAccountResource)(nil)
	_ resource.ResourceWithConfigure   = (*managedAccountResource)(nil)
	_ resource.ResourceWithImportState = (*managedAccountResource)(nil)
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
}

var managedAccountCostBases = []string{"cash", "amortized"}

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

			"invoice_count": schema.Int64Attribute{
				Computed: true,
				MarkdownDescription: "How many invoices this customer has. Useful as a guard before a destroy: " +
					"it is the count of financial records that exist against them.",
			},
		},
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

	return iw.ManagedAccountInput{
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
// Computed, so a configuration that omits one — a customer scoped by accounts
// only, say — leaves an unknown that the server's `[]` satisfies; folding `[]`
// to null instead would fail the consistency check for a configuration that
// writes the empty set out.
func managedAccountStateFrom(ctx context.Context, remote *iw.ManagedAccount) (managedAccountResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	centres, d := nilStringSet(ctx, remote.CostCentreIDs)
	diags.Append(d...)
	accounts, d := nilStringSet(ctx, remote.AccountIDs)
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
	}, diags
}
