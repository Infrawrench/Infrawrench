package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*anomalySettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*anomalySettingsResource)(nil)
	_ resource.ResourceWithImportState = (*anomalySettingsResource)(nil)
)

// NewAnomalySettingsResource constructs the infrawrench_anomaly_settings
// resource.
func NewAnomalySettingsResource() resource.Resource { return &anomalySettingsResource{} }

type anomalySettingsResource struct{ client *iw.Client }

type anomalySettingsResourceModel struct {
	ID                types.String  `tfsdk:"id"`
	Sigmas            types.Float64 `tfsdk:"sigmas"`
	MinDeltaCents     types.Int64   `tfsdk:"min_delta_cents"`
	NewSourceMinCents types.Int64   `tfsdk:"new_source_min_cents"`
	SMSAlerts         types.String  `tfsdk:"sms_alerts"`
	SMSConfigured     types.Bool    `tfsdk:"sms_configured"`
}

// anomalyDefaults are the server's documented defaults, and what destroy
// restores. There is no DELETE on this route — the settings row always exists —
// so "remove it from Terraform" has to mean "put it back the way it shipped".
var anomalyDefaults = iw.CostAnomalySettings{
	Sigmas:            3,
	MinDeltaCents:     1000,
	NewSourceMinCents: 2500,
	SMSAlerts:         "off",
}

var smsAlertModes = []string{"off", "new_source", "all"}

func (r *anomalySettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_anomaly_settings"
}

func (r *anomalySettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Organization-wide tuning for cost anomaly detection: how far above its own trailing " +
			"mean a spend line has to go before it is called a spike, and how much money has to be involved " +
			"before anyone is told.\n\n" +
			"This is an organization **singleton** — one row that always exists. `terraform destroy` " +
			"therefore restores the shipped defaults rather than deleting anything, because an " +
			"organization with no anomaly settings is not a state the API can be in.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Anomaly detection"),
			"sigmas": schema.Float64Attribute{
				Required: true,
				MarkdownDescription: "Standard deviations above a key's own trailing mean that count as a spike, " +
					"1–10. Lower is more sensitive. Bounded at 1 — below that roughly a third of ordinary days " +
					"clear the bar — and at 10, above which nothing short of a 10× jump fires. The default is 3.",
			},
			"min_delta_cents": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Minimum rise over the baseline mean before a spike alerts, in USD cents " +
					"(converted per series, so it means the same real amount in every currency). 100–10000000; " +
					"the default is 1000 ($10).",
			},
			"new_source_min_cents": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Minimum first-day spend before a **new** spend source alerts, in USD cents. " +
					"A key with no prior spend has no statistical bar to clear, so this absolute floor is the " +
					"only thing keeping a new $0.02/day service quiet. 100–10000000; the default is 2500 ($25).",
			},
			"sms_alerts": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Which anomalies also text the organization's Twilio recipients. One of `" +
					joinBackticked(smsAlertModes) + "`.\n\n" +
					"`off` is the default: an organization with Twilio configured for budgets does not start " +
					"receiving anomaly texts until it asks to. `new_source` texts only about spend appearing " +
					"from nothing, which is what a leaked key looks like on a bill. Delivery is batched — one " +
					"SMS per detection pass, at most one every six hours — and never places a voice call. " +
					"Push, Slack and Teams delivery is unaffected by this setting.",
				Validators: []validatorString{oneOfValidator(smsAlertModes...)},
			},
			"sms_configured": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether an SMS raised right now could actually be delivered: paging enabled, " +
					"Twilio credentials and a from-number stored, and at least one recipient opted in. Derived " +
					"server-side — setting `sms_alerts` on an organization where this is `false` configures " +
					"something that cannot fire.",
			},
		},
	}
}

func (r *anomalySettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// Create is an update in disguise: the row already exists, so the first apply
// writes over whatever the organization had.
func (r *anomalySettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan anomalySettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *anomalySettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state anomalySettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAnomalySettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read anomaly settings", err.Error())
		return
	}

	refreshed := anomalySettingsStateFrom(r.client.OrgID(), remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *anomalySettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan anomalySettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete restores the defaults. See the schema description for why it cannot
// remove anything.
func (r *anomalySettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutAnomalySettings(ctx, anomalyDefaults); err != nil {
		resp.Diagnostics.AddError("Unable to reset anomaly settings", err.Error())
	}
}

func (r *anomalySettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *anomalySettingsResource) write(ctx context.Context, plan anomalySettingsResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutAnomalySettings(ctx, iw.CostAnomalySettings{
		Sigmas:            plan.Sigmas.ValueFloat64(),
		MinDeltaCents:     plan.MinDeltaCents.ValueInt64(),
		NewSourceMinCents: plan.NewSourceMinCents.ValueInt64(),
		SMSAlerts:         plan.SMSAlerts.ValueString(),
	})
	if err != nil {
		diags.AddError("Unable to write anomaly settings", err.Error())
		return
	}
	next := anomalySettingsStateFrom(r.client.OrgID(), saved)
	diags.Append(state.Set(ctx, &next)...)
}

func anomalySettingsStateFrom(orgID string, remote *iw.CostAnomalySettings) anomalySettingsResourceModel {
	return anomalySettingsResourceModel{
		ID:                types.StringValue(orgID),
		Sigmas:            types.Float64Value(remote.Sigmas),
		MinDeltaCents:     types.Int64Value(remote.MinDeltaCents),
		NewSourceMinCents: types.Int64Value(remote.NewSourceMinCents),
		SMSAlerts:         types.StringValue(remote.SMSAlerts),
		SMSConfigured:     boolValueOrDefault(remote.SMSConfigured, false),
	}
}
