package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ datasource.DataSource                   = (*serviceDataSource)(nil)
	_ datasource.DataSourceWithConfigure      = (*serviceDataSource)(nil)
	_ datasource.DataSourceWithValidateConfig = (*serviceDataSource)(nil)
)

// NewServiceDataSource constructs the infrawrench_service data source.
func NewServiceDataSource() datasource.DataSource { return &serviceDataSource{} }

type serviceDataSource struct{ client *iw.Client }

type serviceDataSourceModel struct {
	ID                 types.String  `tfsdk:"id"`
	Slug               types.String  `tfsdk:"slug"`
	Name               types.String  `tfsdk:"name"`
	Description        types.String  `tfsdk:"description"`
	Tier               types.Int64   `tfsdk:"tier"`
	OwnerTeam          types.String  `tfsdk:"owner_team"`
	OwnerUserIDs       types.Set     `tfsdk:"owner_user_ids"`
	Owners             types.List    `tfsdk:"owners"`
	OnCallScheduleID   types.String  `tfsdk:"on_call_schedule_id"`
	OnCallScheduleName types.String  `tfsdk:"on_call_schedule_name"`
	SloIDs             types.Set     `tfsdk:"slo_ids"`
	RunbookIDs         types.Set     `tfsdk:"runbook_ids"`
	MonthlyBudget      types.Float64 `tfsdk:"monthly_budget"`
	BudgetCurrency     types.String  `tfsdk:"budget_currency"`
	Links              types.List    `tfsdk:"links"`
	Rules              types.List    `tfsdk:"rules"`
	MemberCount        types.Int64   `tfsdk:"member_count"`
}

type serviceOwnerModel struct {
	UserID types.String `tfsdk:"user_id"`
	Name   types.String `tfsdk:"name"`
	Email  types.String `tfsdk:"email"`
}

var serviceOwnerObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"user_id": types.StringType,
	"name":    types.StringType,
	"email":   types.StringType,
}}

func (d *serviceDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_service"
}

func (d *serviceDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	computedString := func(description string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, MarkdownDescription: description}
	}
	computedStringSet := func(description string) schema.SetAttribute {
		return schema.SetAttribute{Computed: true, ElementType: types.StringType, MarkdownDescription: description}
	}

	resp.Schema = schema.Schema{
		MarkdownDescription: "One service, looked up by `id` or `slug`, including services created in the app " +
			"rather than by `infrawrench_service`.\n\n" +
			"Use it to refer to a service managed elsewhere, or to assert on one in a `precondition` (a " +
			"tier-1 service must have an on-call schedule, say). Unlike the resource it also reads the " +
			"resolved `member_count` and the owners' names and addresses, which change with the inventory " +
			"and the member list rather than with the service.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "The service id. Set exactly one of `id` and `slug`.",
			},
			"slug": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "The service's slug, e.g. `checkout-api`. Set exactly one of `id` and `slug`.",
			},
			"name":        computedString("The service's name."),
			"description": computedString("What the service is; null when unset."),
			"tier": schema.Int64Attribute{
				Computed:            true,
				MarkdownDescription: "Criticality, 1 being the most critical; null for an untiered service.",
			},
			"owner_team":     computedString("Free-text owning team; display only."),
			"owner_user_ids": computedStringSet("Owning organization members' user ids."),
			"owners": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "The owning members with their current names and login addresses.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"user_id": computedString("The member's user id."),
						"name":    computedString("Display name, when the member has one."),
						"email":   computedString("Login address, when known."),
					},
				},
			},
			"on_call_schedule_id":   computedString("The linked on-call schedule's id; null when none."),
			"on_call_schedule_name": computedString("The linked on-call schedule's name; null when none."),
			"slo_ids":               computedStringSet("Linked SLO ids."),
			"runbook_ids":           computedStringSet("Linked runbook ids."),
			"monthly_budget": schema.Float64Attribute{
				Computed:            true,
				MarkdownDescription: "Monthly budget in `budget_currency`; null when unset.",
			},
			"budget_currency": computedString("ISO 4217 code for `monthly_budget`; null without a budget."),
			"links": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Dashboards, repositories and documents, in display order.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"label": computedString("Link text."),
						"url":   computedString("The URL."),
					},
				},
			},
			"rules": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Membership rules, in the shape `infrawrench_service`'s `rule` blocks take.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"kind":       computedString("`tag`, `virtual_tag` or `name`."),
						"key":        computedString("The tag or virtual tag key; null for `name` rules."),
						"value":      computedString("The value or name pattern; null for a `tag` rule matching any value."),
						"name_match": computedString("`name` rules: `contains`, `prefix`, `suffix` or `exact`."),
						"plugin_id":  computedString("The provider the rule is narrowed to, if any."),
						"account_id": computedString("The account the rule is narrowed to, if any."),
					},
				},
			},
			"member_count": schema.Int64Attribute{
				Computed: true,
				MarkdownDescription: "Resources in the service right now: hand-picked members plus rule matches, " +
					"minus exclusions.",
			},
		},
	}
}

func (d *serviceDataSource) ValidateConfig(ctx context.Context, req datasource.ValidateConfigRequest, resp *datasource.ValidateConfigResponse) {
	var cfg serviceDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() || cfg.ID.IsUnknown() || cfg.Slug.IsUnknown() {
		return
	}
	if cfg.ID.IsNull() == cfg.Slug.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("id"), "Exactly one lookup key",
			"Set exactly one of `id` and `slug`.")
	}
}

func (d *serviceDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = clientFromDataSourceConfigure(req, resp)
}

func (d *serviceDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var cfg serviceDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	key := cfg.ID.ValueString()
	if cfg.ID.IsNull() {
		key = cfg.Slug.ValueString()
	}
	remote, err := d.client.GetService(ctx, key)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.Diagnostics.AddError("Service not found", "No service has the id or slug "+key+".")
			return
		}
		resp.Diagnostics.AddError("Unable to read service", err.Error())
		return
	}

	owners := make([]serviceOwnerModel, 0, len(remote.Owners))
	for _, o := range remote.Owners {
		owners = append(owners, serviceOwnerModel{
			UserID: types.StringValue(o.UserID),
			Name:   stringValue(o.Name),
			Email:  stringValue(o.Email),
		})
	}
	ownerList, diags := types.ListValueFrom(ctx, serviceOwnerObjectType, owners)
	resp.Diagnostics.Append(diags...)
	ownerIDs, diags := stringSetOf(ctx, remote.OwnerUserIDs)
	resp.Diagnostics.Append(diags...)
	slos, diags := stringSetOf(ctx, remote.SloIDs)
	resp.Diagnostics.Append(diags...)
	runbooks, diags := stringSetOf(ctx, remote.RunbookIDs)
	resp.Diagnostics.Append(diags...)
	links, rules, diags := serviceLinksAndRules(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	state := serviceDataSourceModel{
		ID:                 types.StringValue(remote.ID),
		Slug:               types.StringValue(remote.Slug),
		Name:               types.StringValue(remote.Name),
		Description:        stringValue(remote.Description),
		Tier:               int64Value(remote.Tier),
		OwnerTeam:          stringValue(remote.OwnerTeam),
		OwnerUserIDs:       ownerIDs,
		Owners:             ownerList,
		OnCallScheduleID:   stringValue(remote.OnCallScheduleID),
		OnCallScheduleName: stringValue(remote.OnCallScheduleName),
		SloIDs:             slos,
		RunbookIDs:         runbooks,
		MonthlyBudget:      float64Value(remote.MonthlyBudget),
		BudgetCurrency:     stringValue(remote.BudgetCurrency),
		Links:              links,
		Rules:              rules,
		MemberCount:        types.Int64Value(remote.MemberCount),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}
