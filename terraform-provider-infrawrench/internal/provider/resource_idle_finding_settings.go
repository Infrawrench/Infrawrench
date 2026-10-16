package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*idleFindingSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*idleFindingSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*idleFindingSettingsResource)(nil)
)

// NewIdleFindingSettingsResource constructs the
// infrawrench_idle_finding_settings resource.
func NewIdleFindingSettingsResource() resource.Resource {
	return &idleFindingSettingsResource{}
}

type idleFindingSettingsResource struct{ client *iw.Client }

type idleFindingSettingsModel struct {
	ID           types.String `tfsdk:"id"`
	Enabled      types.Bool   `tfsdk:"enabled"`
	LookbackDays types.Int64  `tfsdk:"lookback_days"`
	Rules        types.Map    `tfsdk:"rules"`
}

type idleRuleOverrideModel struct {
	Enabled    types.Bool `tfsdk:"enabled"`
	Thresholds types.Map  `tfsdk:"thresholds"`
}

var idleRuleOverrideAttrTypes = map[string]attr.Type{
	"enabled":    types.BoolType,
	"thresholds": types.MapType{ElemType: types.Float64Type},
}

func (r *idleFindingSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_idle_finding_settings"
}

func (r *idleFindingSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Tuning for the metric-based idle rules behind Potential savings: idle NAT gateways, " +
			"load balancers, caches, provisioned tables, databases, clusters and unused custom metrics. " +
			"Each rule reads the provider's metrics over the lookback window once a day; the rules and " +
			"their thresholds are declared by the provider plugins and listed by `GET /idle-findings`.\n\n" +
			"An organization **singleton**, with no DELETE on the route: `terraform destroy` leaves the " +
			"stored settings alone. Any change makes every account due for a fresh collection.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Idle rules"),
			"enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Whether idle rules run for this organization. Off stops collection and hides every idle finding.",
			},
			"lookback_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Days of metrics each rule judges over, 7–42. Ships as 14. Datadog's " +
					"unused custom metric rule has its own `notQueriedDays` threshold instead.",
				Validators: []validatorInt64{between(7, 42)},
			},
			"rules": schema.MapNestedAttribute{
				Optional: true,
				MarkdownDescription: "Overrides keyed by `pluginId:ruleId` (`aws:nat-gateway`, " +
					"`gcp:gke-cluster`, `datadog:unused-custom-metric`). A rule left out runs enabled with " +
					"its declared defaults. Unknown rule or threshold keys, and thresholds outside the " +
					"range the rule declares, are rejected by the API.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"enabled": schema.BoolAttribute{
							Optional:            true,
							MarkdownDescription: "False switches the rule off; leave unset to keep it on.",
						},
						"thresholds": schema.MapAttribute{
							Optional:            true,
							ElementType:         types.Float64Type,
							MarkdownDescription: "Threshold overrides by key, in the rule's own unit (bytes, counts, percent or days).",
						},
					},
				},
			},
		},
	}
}

func (r *idleFindingSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *idleFindingSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan idleFindingSettingsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *idleFindingSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state idleFindingSettingsModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetIdleFindingSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read idle finding settings", err.Error())
		return
	}
	next, diags := idleSettingsToModel(ctx, r.client.OrgID(), remote, state.Rules.IsNull())
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *idleFindingSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan idleFindingSettingsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op: the settings row has no DELETE and no documented reset.
func (r *idleFindingSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *idleFindingSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *idleFindingSettingsResource) write(ctx context.Context, plan idleFindingSettingsModel, diags *diagnostics, state *tfState) {
	// An unset `rules` replaces the overrides with none, so removing the
	// attribute from configuration really does return every rule to its
	// defaults rather than leaving the old overrides behind.
	rules := map[string]iw.IdleRuleOverride{}
	if !plan.Rules.IsNull() && !plan.Rules.IsUnknown() {
		var models map[string]idleRuleOverrideModel
		diags.Append(plan.Rules.ElementsAs(ctx, &models, false)...)
		if diags.HasError() {
			return
		}
		for key, m := range models {
			override := iw.IdleRuleOverride{Enabled: boolPtr(m.Enabled)}
			if !m.Thresholds.IsNull() && !m.Thresholds.IsUnknown() {
				thresholds := map[string]float64{}
				diags.Append(m.Thresholds.ElementsAs(ctx, &thresholds, false)...)
				if diags.HasError() {
					return
				}
				override.Thresholds = thresholds
			}
			rules[key] = override
		}
	}
	saved, err := r.client.PutIdleFindingSettings(ctx, iw.IdleFindingSettingsUpdate{
		Enabled:      boolPtr(plan.Enabled),
		LookbackDays: int64Ptr(plan.LookbackDays),
		Rules:        rules,
	})
	if err != nil {
		diags.AddError("Unable to write idle finding settings", err.Error())
		return
	}
	next, d := idleSettingsToModel(ctx, r.client.OrgID(), saved, plan.Rules.IsNull())
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

// idleSettingsToModel maps the API's settings onto state. An empty overrides
// map reads back as null when the configuration never set `rules`, so a
// configuration without the attribute does not plan a diff forever.
func idleSettingsToModel(ctx context.Context, orgID string, in *iw.IdleFindingSettings, rulesUnset bool) (idleFindingSettingsModel, diagnostics) {
	var diags diagnostics
	out := idleFindingSettingsModel{
		ID:           types.StringValue(orgID),
		Enabled:      types.BoolValue(in.Enabled),
		LookbackDays: types.Int64Value(in.LookbackDays),
		Rules:        types.MapNull(types.ObjectType{AttrTypes: idleRuleOverrideAttrTypes}),
	}
	if len(in.Rules) == 0 && rulesUnset {
		return out, diags
	}
	models := map[string]idleRuleOverrideModel{}
	for key, rule := range in.Rules {
		m := idleRuleOverrideModel{
			Enabled:    types.BoolNull(),
			Thresholds: types.MapNull(types.Float64Type),
		}
		if rule.Enabled != nil {
			m.Enabled = types.BoolValue(*rule.Enabled)
		}
		if len(rule.Thresholds) > 0 {
			value, d := types.MapValueFrom(ctx, types.Float64Type, rule.Thresholds)
			diags.Append(d...)
			m.Thresholds = value
		}
		models[key] = m
	}
	value, d := types.MapValueFrom(ctx, types.ObjectType{AttrTypes: idleRuleOverrideAttrTypes}, models)
	diags.Append(d...)
	out.Rules = value
	return out, diags
}
