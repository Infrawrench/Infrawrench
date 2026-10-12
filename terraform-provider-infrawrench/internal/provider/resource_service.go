package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*serviceResource)(nil)
	_ resource.ResourceWithConfigure      = (*serviceResource)(nil)
	_ resource.ResourceWithImportState    = (*serviceResource)(nil)
	_ resource.ResourceWithValidateConfig = (*serviceResource)(nil)
)

// NewServiceResource constructs the infrawrench_service resource.
func NewServiceResource() resource.Resource { return &serviceResource{} }

type serviceResource struct{ client *iw.Client }

// The API's limits (SERVICE_LIMITS in client-core), mirrored so a violation is
// a plan error rather than an HTTP 400 halfway through an apply.
const (
	serviceNameMaxLength        = 120
	serviceSlugMaxLength        = 64
	serviceDescriptionMaxLength = 1000
	serviceOwnerTeamMaxLength   = 120
	serviceMaxOwners            = 20
	serviceMaxLinks             = 20
	serviceLinkLabelMaxLength   = 80
	serviceLinkURLMaxLength     = 2000
	serviceMaxRules             = 20
	serviceRuleValueMaxLength   = 256
	serviceMaxSlos              = 50
	serviceMaxRunbooks          = 50
)

var (
	serviceRuleKinds   = []string{"tag", "virtual_tag", "name"}
	serviceNameMatches = []string{"contains", "prefix", "suffix", "exact"}

	serviceSlugPattern     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	serviceLinkURLPattern  = regexp.MustCompile(`^https?://\S+$`)
	serviceCurrencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
)

type serviceResourceModel struct {
	ID               types.String  `tfsdk:"id"`
	Name             types.String  `tfsdk:"name"`
	Slug             types.String  `tfsdk:"slug"`
	Description      types.String  `tfsdk:"description"`
	Tier             types.Int64   `tfsdk:"tier"`
	OwnerTeam        types.String  `tfsdk:"owner_team"`
	OwnerUserIDs     types.Set     `tfsdk:"owner_user_ids"`
	OnCallScheduleID types.String  `tfsdk:"on_call_schedule_id"`
	SloIDs           types.Set     `tfsdk:"slo_ids"`
	RunbookIDs       types.Set     `tfsdk:"runbook_ids"`
	MonthlyBudget    types.Float64 `tfsdk:"monthly_budget"`
	BudgetCurrency   types.String  `tfsdk:"budget_currency"`
	Link             types.List    `tfsdk:"link"`
	Rule             types.List    `tfsdk:"rule"`
}

type serviceLinkModel struct {
	Label types.String `tfsdk:"label"`
	URL   types.String `tfsdk:"url"`
}

var serviceLinkAttrTypes = map[string]attr.Type{
	"label": types.StringType,
	"url":   types.StringType,
}

var serviceLinkObjectType = types.ObjectType{AttrTypes: serviceLinkAttrTypes}

type serviceRuleModel struct {
	Kind      types.String `tfsdk:"kind"`
	Key       types.String `tfsdk:"key"`
	Value     types.String `tfsdk:"value"`
	NameMatch types.String `tfsdk:"name_match"`
	PluginID  types.String `tfsdk:"plugin_id"`
	AccountID types.String `tfsdk:"account_id"`
}

var serviceRuleAttrTypes = map[string]attr.Type{
	"kind":       types.StringType,
	"key":        types.StringType,
	"value":      types.StringType,
	"name_match": types.StringType,
	"plugin_id":  types.StringType,
	"account_id": types.StringType,
}

var serviceRuleObjectType = types.ObjectType{AttrTypes: serviceRuleAttrTypes}

func (r *serviceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_service"
}

func (r *serviceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	trimmed := stringvalidator.RegexMatches(trimmedPattern,
		"must not be empty or start or end with whitespace (the server trims it, which would diff forever)")
	emptySet := setdefault.StaticValue(types.SetValueMust(types.StringType, []attr.Value{}))

	resp.Schema = schema.Schema{
		MarkdownDescription: "A service: a named set of resources across providers and accounts (\"Checkout API\" " +
			"is fourteen resources on three providers), with who owns it, how critical it is, and the " +
			"reliability objects that already exist on their own (SLOs, runbooks, an on-call schedule) linked " +
			"to it. Scorecards (`infrawrench_scorecard`) grade every service against the organization's " +
			"operational bar.\n\n" +
			"**Membership is managed by `rule` blocks.** A rule matches resources by provider tag, virtual " +
			"tag or name, so a new resource tagged `service=checkout` joins without anybody editing the " +
			"service; that is the Terraform-native way to say what belongs. Resources picked by hand and " +
			"rule-matched resources excluded by hand are managed in the app, not here: this resource never " +
			"sends them, so an apply leaves them as they are.\n\n" +
			"Every list here is authoritative: a write replaces the stored list with the configured one.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned service id. Use it, or the slug, with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Unique in the organization; 1–120 characters.",
				Validators: []validatorString{
					stringvalidator.LengthBetween(1, serviceNameMaxLength), trimmed,
				},
			},
			"slug": schema.StringAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "The short name the CLI and URLs use, 1–64 lower-case letters, digits and " +
					"dashes, not starting or ending with a dash; unique in the organization. Derived from the " +
					"name when omitted (`Checkout API` becomes `checkout-api`) and then kept: renaming the " +
					"service does not change it.",
				Validators: []validatorString{
					stringvalidator.LengthBetween(1, serviceSlugMaxLength),
					stringvalidator.RegexMatches(serviceSlugPattern,
						"must be lower-case letters, digits and dashes, not starting or ending with a dash"),
				},
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "What the service is; 1–1000 characters.",
				Validators: []validatorString{
					stringvalidator.LengthBetween(1, serviceDescriptionMaxLength), trimmed,
				},
			},
			"tier": schema.Int64Attribute{
				Optional: true,
				MarkdownDescription: "Criticality, 1–4, 1 being the most critical: `1` customer-facing (an outage " +
					"is an incident), `2` important, `3` internal tools, `4` experimental. Omit it for an " +
					"untiered service. A scorecard's `applicable_tiers` selects services by this value.",
				Validators: []validatorInt64{between(1, 4)},
			},
			"owner_team": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Free-text owning team, 1–120 characters. Display only: alerts are never " +
					"routed by it. Use `owner_user_ids` for owners that can be notified.",
				Validators: []validatorString{
					stringvalidator.LengthBetween(1, serviceOwnerTeamMaxLength), trimmed,
				},
			},
			"owner_user_ids": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     emptySet,
				MarkdownDescription: "Owning organization members, by user id from the `infrawrench_members` " +
					"data source. At most 20. Each must be a current member when the service is written.",
				Validators: []validatorSet{setSizeAtMost(serviceMaxOwners)},
			},
			"on_call_schedule_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The `infrawrench_on_call_schedule` that answers for this service. The " +
					"service page shows who is on call now, and the `has_on_call` scorecard check reads it.",
			},
			"slo_ids": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     emptySet,
				MarkdownDescription: "Linked `infrawrench_slo` ids, at most 50. The `slo_within_budget` " +
					"scorecard check reads their error budgets.",
				Validators: []validatorSet{setSizeAtMost(serviceMaxSlos)},
			},
			"runbook_ids": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     emptySet,
				MarkdownDescription: "Linked runbook ids, at most 50. Runbooks are written in the app; the " +
					"`has_runbook` scorecard check reads them.",
				Validators: []validatorSet{setSizeAtMost(serviceMaxRunbooks)},
			},
			"monthly_budget": schema.Float64Attribute{
				Optional: true,
				MarkdownDescription: "Monthly budget in `budget_currency`, zero or more. The " +
					"`cost_within_budget` scorecard check compares the last 30 days of member spend against " +
					"it. Requires `budget_currency`.",
				Validators: []validatorFloat64{float64validator.AtLeast(0)},
			},
			"budget_currency": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "ISO 4217 code for `monthly_budget`, upper case (`USD`, `EUR`). Required " +
					"with a budget and rejected without one, since the server discards it.",
				Validators: []validatorString{stringvalidator.RegexMatches(serviceCurrencyPattern,
					"must be a three-letter upper-case ISO 4217 code, e.g. USD")},
			},
		},
		Blocks: map[string]schema.Block{
			"link": schema.ListNestedBlock{
				MarkdownDescription: "A dashboard, repository or document shown on the service page, in order. " +
					"At most 20.",
				Validators: []validatorList{sizeAtMost(serviceMaxLinks)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"label": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Link text; 1–80 characters.",
							Validators: []validatorString{
								stringvalidator.LengthBetween(1, serviceLinkLabelMaxLength), trimmed,
							},
						},
						"url": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "An `http` or `https` URL; 1–2000 characters.",
							Validators: []validatorString{
								stringvalidator.LengthBetween(1, serviceLinkURLMaxLength),
								stringvalidator.RegexMatches(serviceLinkURLPattern, "must be an http or https URL"),
							},
						},
					},
				},
			},
			"rule": schema.ListNestedBlock{
				MarkdownDescription: "A membership rule. A resource belongs when any rule matches it (or it was " +
					"added by hand in the app). At most 20.",
				Validators: []validatorList{sizeAtMost(serviceMaxRules)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"kind": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "One of `" + joinBackticked(serviceRuleKinds) + "`. `tag`: the " +
								"resource carries provider tag `key` (with `value`, or any value when `value` " +
								"is omitted); keys match case-insensitively, values exactly. `virtual_tag`: the " +
								"organization's virtual tag `key` resolves to `value` on the resource's cost " +
								"rows over the last 30 days, so it only matches resources with per-resource " +
								"cost. `name`: the resource's display name matches `value` per `name_match`, " +
								"case-insensitively.",
							Validators: []validatorString{oneOfValidator(serviceRuleKinds...)},
						},
						"key": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "`tag` and `virtual_tag` only, and required there: the tag key " +
								"(see `infrawrench_virtual_tag` for virtual tag keys); 1–256 characters.",
							Validators: []validatorString{
								stringvalidator.LengthBetween(1, serviceRuleValueMaxLength), trimmed,
							},
						},
						"value": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "`tag`: the exact value, or omit it for any value. " +
								"`virtual_tag`: the value, required. `name`: the pattern, required. " +
								"1–256 characters.",
							Validators: []validatorString{
								stringvalidator.LengthBetween(1, serviceRuleValueMaxLength), trimmed,
							},
						},
						"name_match": schema.StringAttribute{
							Optional: true,
							Computed: true,
							MarkdownDescription: "`name` only: one of `" + joinBackticked(serviceNameMatches) +
								"`. Defaults to `contains`.",
							Validators: []validatorString{oneOfValidator(serviceNameMatches...)},
						},
						"plugin_id": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Narrow the rule to one provider, by id from the " +
								"`infrawrench_plugins` data source.",
							Validators: []validatorString{trimmed},
						},
						"account_id": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Narrow the rule to one connected account, by id from the " +
								"`infrawrench_accounts` data source.",
							Validators: []validatorString{trimmed},
						},
					},
				},
			},
		},
	}
}

// ValidateConfig enforces the rule shapes and the budget pairing. The server
// nulls a field the rule's kind does not use, and drops the currency when
// there is no budget, rather than rejecting either; both would read back
// different from the configuration and fail the apply as an inconsistent
// result.
func (r *serviceResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var cfg serviceResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if !cfg.MonthlyBudget.IsUnknown() && !cfg.BudgetCurrency.IsUnknown() {
		if !cfg.MonthlyBudget.IsNull() && cfg.BudgetCurrency.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("budget_currency"), "Currency required",
				"`monthly_budget` needs `budget_currency`.")
		}
		if cfg.MonthlyBudget.IsNull() && !cfg.BudgetCurrency.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("budget_currency"), "Budget required",
				"`budget_currency` only applies with a `monthly_budget`; the server discards it otherwise.")
		}
	}

	if cfg.Rule.IsNull() || cfg.Rule.IsUnknown() {
		return
	}
	var rules []serviceRuleModel
	resp.Diagnostics.Append(cfg.Rule.ElementsAs(ctx, &rules, false)...)
	if resp.Diagnostics.HasError() {
		return
	}
	for i, rule := range rules {
		if rule.Kind.IsUnknown() || rule.Kind.IsNull() {
			continue
		}
		kind := rule.Kind.ValueString()
		at := func(attribute string) path.Path {
			return path.Root("rule").AtListIndex(i).AtName(attribute)
		}
		switch kind {
		case "name":
			if !rule.Key.IsNull() && !rule.Key.IsUnknown() {
				resp.Diagnostics.AddAttributeError(at("key"), "Not used by name rules",
					"A `name` rule matches on `value`; remove `key`.")
			}
			if rule.Value.IsNull() {
				resp.Diagnostics.AddAttributeError(at("value"), "Pattern required",
					"A `name` rule needs `value`, the name pattern to match.")
			}
		default:
			if rule.Key.IsNull() {
				resp.Diagnostics.AddAttributeError(at("key"), "Key required",
					"A `"+kind+"` rule needs `key`.")
			}
			if !rule.NameMatch.IsNull() && !rule.NameMatch.IsUnknown() {
				resp.Diagnostics.AddAttributeError(at("name_match"), "Only for name rules",
					"`name_match` applies to `name` rules; remove it.")
			}
			if kind == "virtual_tag" && rule.Value.IsNull() {
				resp.Diagnostics.AddAttributeError(at("value"), "Value required",
					"A `virtual_tag` rule needs `value`.")
			}
		}
	}
}

func (r *serviceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *serviceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan serviceResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := serviceInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateService(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create service", err.Error())
		return
	}
	state, diags := serviceStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *serviceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state serviceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetService(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read service", err.Error())
		return
	}
	refreshed, diags := serviceStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update sends every field. The route is a PATCH, but an omitted key there
// means "leave it", which would make removing an attribute from configuration
// a no-op; sending the whole object makes the configuration authoritative.
func (r *serviceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan serviceResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state serviceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := serviceInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateService(ctx, state.ID.ValueString(), input)
	if err != nil {
		// The route also answers 404 for a linked SLO, runbook or on-call
		// schedule that does not exist, so a 404 alone does not mean the
		// service is gone. Only drop it from state when a read agrees.
		if iw.IsNotFound(err) && r.serviceIsGone(ctx, state.ID.ValueString()) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Service no longer exists",
				"The service was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update service", err.Error())
		return
	}
	next, diags := serviceStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// serviceIsGone reports whether the service itself no longer exists.
func (r *serviceResource) serviceIsGone(ctx context.Context, id string) bool {
	_, err := r.client.GetService(ctx, id)
	return iw.IsNotFound(err)
}

// Delete removes the service. Its member resources, linked SLOs, runbooks and
// on-call schedule are untouched.
func (r *serviceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state serviceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteService(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete service", err.Error())
	}
}

// ImportState takes the id or the slug. The single-GET route resolves either,
// and Read then records the real id from the response.
func (r *serviceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// setStrings reads a string set into a slice, `[]` for null or unknown.
func setStrings(ctx context.Context, set types.Set) ([]string, diag.Diagnostics) {
	out := []string{}
	if set.IsNull() || set.IsUnknown() {
		return out, nil
	}
	diags := set.ElementsAs(ctx, &out, false)
	if out == nil {
		out = []string{}
	}
	return out, diags
}

// stringSetOf renders a slice into a set, an empty set for nil.
func stringSetOf(ctx context.Context, values []string) (types.Set, diag.Diagnostics) {
	if values == nil {
		values = []string{}
	}
	return types.SetValueFrom(ctx, types.StringType, values)
}

func serviceInputFrom(ctx context.Context, plan serviceResourceModel) (iw.ServiceInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	in := iw.ServiceInput{
		Name:             plan.Name.ValueString(),
		Slug:             stringPtr(plan.Slug),
		Description:      stringPtr(plan.Description),
		Tier:             int64Ptr(plan.Tier),
		OwnerTeam:        stringPtr(plan.OwnerTeam),
		OnCallScheduleID: stringPtr(plan.OnCallScheduleID),
		MonthlyBudget:    float64Ptr(plan.MonthlyBudget),
		BudgetCurrency:   stringPtr(plan.BudgetCurrency),
		Links:            []iw.ServiceLink{},
		Rules:            []iw.ServiceMembershipRule{},
	}

	var d diag.Diagnostics
	in.OwnerUserIDs, d = setStrings(ctx, plan.OwnerUserIDs)
	diags.Append(d...)
	in.SloIDs, d = setStrings(ctx, plan.SloIDs)
	diags.Append(d...)
	in.RunbookIDs, d = setStrings(ctx, plan.RunbookIDs)
	diags.Append(d...)

	if !plan.Link.IsNull() && !plan.Link.IsUnknown() {
		var links []serviceLinkModel
		diags.Append(plan.Link.ElementsAs(ctx, &links, false)...)
		for _, l := range links {
			in.Links = append(in.Links, iw.ServiceLink{Label: l.Label.ValueString(), URL: l.URL.ValueString()})
		}
	}
	if !plan.Rule.IsNull() && !plan.Rule.IsUnknown() {
		var rules []serviceRuleModel
		diags.Append(plan.Rule.ElementsAs(ctx, &rules, false)...)
		for _, rule := range rules {
			in.Rules = append(in.Rules, iw.ServiceMembershipRule{
				Kind:      rule.Kind.ValueString(),
				Key:       stringPtr(rule.Key),
				Value:     stringPtr(rule.Value),
				NameMatch: stringPtr(rule.NameMatch),
				PluginID:  stringPtr(rule.PluginID),
				AccountID: stringPtr(rule.AccountID),
			})
		}
	}
	return in, diags
}

// serviceLinksAndRules renders the two nested lists, shared with the data
// source.
func serviceLinksAndRules(ctx context.Context, remote *iw.Service) (types.List, types.List, diag.Diagnostics) {
	var diags diag.Diagnostics

	links := make([]serviceLinkModel, 0, len(remote.Links))
	for _, l := range remote.Links {
		links = append(links, serviceLinkModel{Label: types.StringValue(l.Label), URL: types.StringValue(l.URL)})
	}
	linkList, d := types.ListValueFrom(ctx, serviceLinkObjectType, links)
	diags.Append(d...)

	rules := make([]serviceRuleModel, 0, len(remote.Rules))
	for _, rule := range remote.Rules {
		rules = append(rules, serviceRuleModel{
			Kind:      types.StringValue(rule.Kind),
			Key:       stringValue(rule.Key),
			Value:     stringValue(rule.Value),
			NameMatch: stringValue(rule.NameMatch),
			PluginID:  stringValue(rule.PluginID),
			AccountID: stringValue(rule.AccountID),
		})
	}
	ruleList, d := types.ListValueFrom(ctx, serviceRuleObjectType, rules)
	diags.Append(d...)

	return linkList, ruleList, diags
}

// serviceStateFrom maps a service into state. The resolved member count,
// owners' names and the on-call schedule's name are deliberately left out:
// they change without the service changing, so storing them would show a
// diff on a service nobody edited. The data source exposes them.
func serviceStateFrom(ctx context.Context, remote *iw.Service) (serviceResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	owners, d := stringSetOf(ctx, remote.OwnerUserIDs)
	diags.Append(d...)
	slos, d := stringSetOf(ctx, remote.SloIDs)
	diags.Append(d...)
	runbooks, d := stringSetOf(ctx, remote.RunbookIDs)
	diags.Append(d...)
	links, rules, d := serviceLinksAndRules(ctx, remote)
	diags.Append(d...)

	return serviceResourceModel{
		ID:               types.StringValue(remote.ID),
		Name:             types.StringValue(remote.Name),
		Slug:             types.StringValue(remote.Slug),
		Description:      stringValue(remote.Description),
		Tier:             int64Value(remote.Tier),
		OwnerTeam:        stringValue(remote.OwnerTeam),
		OwnerUserIDs:     owners,
		OnCallScheduleID: stringValue(remote.OnCallScheduleID),
		SloIDs:           slos,
		RunbookIDs:       runbooks,
		MonthlyBudget:    float64Value(remote.MonthlyBudget),
		BudgetCurrency:   stringValue(remote.BudgetCurrency),
		Link:             links,
		Rule:             rules,
	}, diags
}
