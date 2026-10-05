package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
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
	AutoRates       types.Bool   `tfsdk:"auto_rates"`
	RateBasis       types.String `tfsdk:"rate_basis"`
}

func (r *currencySettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_currency_settings"
}

func (r *currencySettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The currency the organization's converted totals are expressed in.\n\n" +
			"Setting it turns conversion on everywhere — graphs, budgets, the digest, the alerts that " +
			"page people. Which rate a given day converts at comes from `infrawrench_exchange_rate` and, " +
			"when `auto_rates` is on, from the European Central Bank's daily euro reference rates. A stated " +
			"rate always wins over the feed for the days it covers.\n\n" +
			"An organization **singleton**. `terraform destroy` clears the display currency and turns " +
			"automatic rates off, which restores the per-currency view; the stated rates survive, so " +
			"conversion can be turned back on without re-entering them.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("The currency setting"),
			"display_currency": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "ISO 4217 code, upper-case, e.g. `USD`. Cost data is stored per currency and " +
					"never merged unless this is set.",
			},
			"auto_rates": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "Fill every day no stated rate covers from the automatic daily ECB euro " +
					"reference rates (weekends and holidays carry the last publication; pairs without EUR are " +
					"crossed through it). Currencies the ECB does not publish stay manual-only. Defaults to " +
					"`false`.",
			},
			"rate_basis": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("daily"),
				MarkdownDescription: "Which automatic rate converts a day's spend: `daily` (that day's rate) or " +
					"`month_end` (the rate on the last day of that day's month, so a month converts at one " +
					"rate). Only affects feed rates. Defaults to `daily`.",
				Validators: []validator.String{oneOfValidator("daily", "month_end")},
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
		AutoRates:       types.BoolValue(config.AutoRates),
		RateBasis:       types.StringValue(rateBasisOrDefault(config.RateBasis)),
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
// is deliberately untouched: see the schema description.
func (r *currencySettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	off, daily := false, "daily"
	if _, err := r.client.PutCurrencySettings(ctx, iw.CurrencySettings{
		DisplayCurrency: nil,
		AutoRates:       &off,
		RateBasis:       &daily,
	}); err != nil {
		resp.Diagnostics.AddError("Unable to clear the display currency", err.Error())
	}
}

func (r *currencySettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *currencySettingsResource) write(ctx context.Context, plan currencySettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutCurrencySettings(ctx, iw.CurrencySettings{
		DisplayCurrency: stringPtr(plan.DisplayCurrency),
		AutoRates:       boolPtr(plan.AutoRates),
		RateBasis:       stringPtr(plan.RateBasis),
	})
	if err != nil {
		diags.AddError("Unable to write currency settings", err.Error())
		return
	}
	next := currencySettingsResourceModel{
		ID:              types.StringValue(r.client.OrgID()),
		DisplayCurrency: stringValue(saved.DisplayCurrency),
		AutoRates:       plan.AutoRates,
		RateBasis:       plan.RateBasis,
	}
	if saved.AutoRates != nil {
		next.AutoRates = types.BoolValue(*saved.AutoRates)
	}
	if saved.RateBasis != nil {
		next.RateBasis = types.StringValue(rateBasisOrDefault(*saved.RateBasis))
	}
	diags.Append(state.Set(ctx, &next)...)
}

// rateBasisOrDefault maps an empty basis (a server that predates automatic
// rates omits the field) to the server's own default.
func rateBasisOrDefault(basis string) string {
	if basis == "" {
		return "daily"
	}
	return basis
}
