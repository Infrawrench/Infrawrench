package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*currencySettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*currencySettingsResource)(nil)
	_ resource.ResourceWithImportState = (*currencySettingsResource)(nil)
)

// NewCurrencySettingsResource constructs the infrawrench_currency_settings
// resource.
func NewCurrencySettingsResource() resource.Resource { return &currencySettingsResource{} }

type currencySettingsResource struct{ client *iw.Client }

type currencySettingsResourceModel struct {
	ID              types.String `tfsdk:"id"`
	DisplayCurrency types.String `tfsdk:"display_currency"`
}

func (r *currencySettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_currency_settings"
}

func (r *currencySettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The currency the organization's converted totals are expressed in.\n\n" +
			"Setting it turns conversion on everywhere — graphs, budgets, the digest, the alerts that " +
			"page people. Which rate a given day converts at comes from `infrawrench_exchange_rate`, and " +
			"a day earlier than every stated rate has no rate at all, so state the rates before or " +
			"alongside the currency.\n\n" +
			"An organization **singleton**. `terraform destroy` clears the display currency, which " +
			"restores the per-currency view; the stated rates survive, so conversion can be turned back " +
			"on without re-entering them.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("The currency setting"),
			"display_currency": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "ISO 4217 code, upper-case, e.g. `USD`. Cost data is stored per currency and " +
					"never merged unless this is set.",
			},
		},
	}
}

func (r *currencySettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *currencySettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan currencySettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *currencySettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state currencySettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	config, err := r.client.GetCurrencyConfig(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read currency settings", err.Error())
		return
	}

	// A cleared display currency is the "no conversion" state, which is the same
	// thing as this resource not existing. Dropping it from state is what makes
	// a `terraform apply` after somebody turned conversion off in the UI plan a
	// create rather than an update to null.
	if config.DisplayCurrency == nil {
		resp.State.RemoveResource(ctx)
		return
	}

	refreshed := currencySettingsResourceModel{
		ID:              types.StringValue(r.client.OrgID()),
		DisplayCurrency: types.StringValue(*config.DisplayCurrency),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *currencySettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan currencySettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete clears the display currency rather than deleting a row. The rate table
// is deliberately untouched — see the schema description.
func (r *currencySettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutCurrencySettings(ctx, iw.CurrencySettings{DisplayCurrency: nil}); err != nil {
		resp.Diagnostics.AddError("Unable to clear the display currency", err.Error())
	}
}

func (r *currencySettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *currencySettingsResource) write(ctx context.Context, plan currencySettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutCurrencySettings(ctx, iw.CurrencySettings{
		DisplayCurrency: stringPtr(plan.DisplayCurrency),
	})
	if err != nil {
		diags.AddError("Unable to write currency settings", err.Error())
		return
	}
	next := currencySettingsResourceModel{
		ID:              types.StringValue(r.client.OrgID()),
		DisplayCurrency: stringValue(saved.DisplayCurrency),
	}
	diags.Append(state.Set(ctx, &next)...)
}
