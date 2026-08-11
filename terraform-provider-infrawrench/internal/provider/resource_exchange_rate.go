package provider

import (
	"context"
	"math/big"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*exchangeRateResource)(nil)
	_ resource.ResourceWithConfigure   = (*exchangeRateResource)(nil)
	_ resource.ResourceWithImportState = (*exchangeRateResource)(nil)
)

// NewExchangeRateResource constructs the infrawrench_exchange_rate resource.
func NewExchangeRateResource() resource.Resource { return &exchangeRateResource{} }

type exchangeRateResource struct{ client *iw.Client }

type exchangeRateResourceModel struct {
	ID            types.String `tfsdk:"id"`
	FromCurrency  types.String `tfsdk:"from_currency"`
	ToCurrency    types.String `tfsdk:"to_currency"`
	Rate          types.String `tfsdk:"rate"`
	EffectiveFrom types.String `tfsdk:"effective_from"`
}

func (r *exchangeRateResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_exchange_rate"
}

func (r *exchangeRateResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "One stated exchange rate, effective from a day.\n\n" +
			"A given day converts at the rate with the greatest `effective_from` on or before it, so " +
			"historical periods keep the rate that applied then and restating a rate today cannot restate " +
			"last quarter's totals. A day earlier than every stated rate has no rate at all.\n\n" +
			"This is exactly the kind of number that belongs in review: it restates every converted total " +
			"the organization reports, in the digest that goes to the whole team and in the budget alerts " +
			"that page people.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned rate id. Use it with `terraform import`."),
			"from_currency": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "ISO 4217 code, upper-case — the currency being converted **from**.",
			},
			"to_currency": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "ISO 4217 code, upper-case — the currency being converted **to**.",
			},
			"rate": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Multiply an amount in `from_currency` by this to get `to_currency`, e.g. " +
					"`\"1.0850000000\"`.\n\n" +
					"A decimal **string**, not a number: it is stored in a `numeric(20, 10)` column so the " +
					"digits your finance system used survive the round trip exactly, and a float could not " +
					"promise that.",
			},
			"effective_from": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Inclusive day this rate starts applying, as `YYYY-MM-DD`. Together with the " +
					"two currencies it is the rate's natural key: restating a rate for a day it already covers " +
					"replaces it rather than adding a second one the reader has to choose between.",
			},
		},
	}
}

func (r *exchangeRateResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// Create upserts. There is no POST — the route is a PUT keyed on
// (from, to, effective_from) — so creating a rate for a day another
// configuration already stated will adopt that row rather than fail. That is
// the server's model rather than a shortcut here, and it is why the resource
// records the returned id instead of assuming a fresh one.
func (r *exchangeRateResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan exchangeRateResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	saved, err := r.client.UpsertExchangeRate(ctx, exchangeRateInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to state exchange rate", err.Error())
		return
	}

	state := exchangeRateStateFrom(saved, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *exchangeRateResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state exchangeRateResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetExchangeRate(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read exchange rate", err.Error())
		return
	}

	refreshed := exchangeRateStateFrom(remote, state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update re-upserts.
//
// Changing any of the three key fields writes a *different* row and leaves the
// old one stated, which would be a silent extra rate in the table. The id
// returned by the upsert is compared against the one in state and the stale row
// is deleted, so the configuration and the rate table stay in step.
func (r *exchangeRateResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan exchangeRateResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state exchangeRateResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	saved, err := r.client.UpsertExchangeRate(ctx, exchangeRateInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to state exchange rate", err.Error())
		return
	}

	previous := state.ID.ValueString()
	if previous != "" && previous != saved.ID {
		if err := r.client.DeleteExchangeRate(ctx, previous); err != nil && !iw.IsNotFound(err) {
			resp.Diagnostics.AddWarning(
				"The previous exchange rate is still stated",
				"The new rate was written, but the row it replaced could not be removed: "+err.Error()+
					"\n\nDelete rate "+previous+" by hand, or the table will carry both.")
		}
	}

	next := exchangeRateStateFrom(saved, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *exchangeRateResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state exchangeRateResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteExchangeRate(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete exchange rate", err.Error())
	}
}

func (r *exchangeRateResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func exchangeRateInputFrom(model exchangeRateResourceModel) iw.ExchangeRateInput {
	return iw.ExchangeRateInput{
		FromCurrency:  model.FromCurrency.ValueString(),
		ToCurrency:    model.ToCurrency.ValueString(),
		Rate:          model.Rate.ValueString(),
		EffectiveFrom: model.EffectiveFrom.ValueString(),
	}
}

// exchangeRateStateFrom maps a stored rate into state, keeping the spelling the
// practitioner wrote whenever it is the same number.
//
// The column is numeric(20, 10), so a configuration saying "1.085" reads back
// as "1.0850000000". Both are the rate; writing the server's padding into state
// would show a diff on every plan and tempt somebody to pad their HCL to match.
// A differing *value* still lands in state as the server's, which is what makes
// an out-of-band edit show up as drift.
func exchangeRateStateFrom(remote *iw.ExchangeRate, prior exchangeRateResourceModel) exchangeRateResourceModel {
	rate := types.StringValue(remote.Rate)
	if !prior.Rate.IsNull() && !prior.Rate.IsUnknown() && sameDecimal(prior.Rate.ValueString(), remote.Rate) {
		rate = prior.Rate
	}

	return exchangeRateResourceModel{
		ID:            types.StringValue(remote.ID),
		FromCurrency:  types.StringValue(remote.FromCurrency),
		ToCurrency:    types.StringValue(remote.ToCurrency),
		Rate:          rate,
		EffectiveFrom: types.StringValue(remote.EffectiveFrom),
	}
}

// sameDecimal reports whether two decimal strings denote the same number,
// ignoring trailing-zero padding. Unparseable input compares false, which
// degrades to showing the server's spelling rather than hiding a real change.
func sameDecimal(a, b string) bool {
	left, ok := new(big.Rat).SetString(a)
	if !ok {
		return false
	}
	right, ok := new(big.Rat).SetString(b)
	if !ok {
		return false
	}
	return left.Cmp(right) == 0
}
