package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ datasource.DataSource              = (*accountsDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*accountsDataSource)(nil)
)

// NewAccountsDataSource constructs the infrawrench_accounts data source.
func NewAccountsDataSource() datasource.DataSource { return &accountsDataSource{} }

type accountsDataSource struct{ client *iw.Client }

type accountItemModel struct {
	ID          types.String `tfsdk:"id"`
	PluginID    types.String `tfsdk:"plugin_id"`
	DisplayName types.String `tfsdk:"display_name"`
	BastionID   types.String `tfsdk:"bastion_id"`
	CreatedAt   types.String `tfsdk:"created_at"`
}

var accountItemAttrTypes = map[string]attr.Type{
	"id":           types.StringType,
	"plugin_id":    types.StringType,
	"display_name": types.StringType,
	"bastion_id":   types.StringType,
	"created_at":   types.StringType,
}

var accountItemObjectType = types.ObjectType{AttrTypes: accountItemAttrTypes}

type accountsDataSourceModel struct {
	ID       types.String `tfsdk:"id"`
	PluginID types.String `tfsdk:"plugin_id"`
	Accounts types.List   `tfsdk:"accounts"`
}

func (r *accountsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_accounts"
}

func (r *accountsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Cloud accounts connected to the organization.\n\n" +
			"The reason to reach for this is to turn an account's display name — the thing a human " +
			"knows — into the account id that `infrawrench_allocation_rule`'s `match.account_id` and " +
			"`infrawrench_billing_rule`'s `match.account_id` want, without pasting an opaque id into " +
			"the configuration.\n\n" +
			"The listing carries no credential material. An account's credentials sit behind a " +
			"separate `secrets:read` route that this data source deliberately never calls, so no " +
			"secret can reach the state file through it.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. A plural data source has no identity of its own; " +
					"this is the conventional placeholder.",
			},
			"plugin_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Restricts the result to accounts belonging to one plugin, e.g. `aws`. " +
					"The API has no server-side filter on this route, so the provider fetches the whole " +
					"listing and filters client-side — it saves configuration noise, not a round trip.",
			},
			"accounts": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Matching accounts, in the order the API returned them.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Account id, as used by rule `match.account_id`.",
						},
						"plugin_id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Id of the plugin the account belongs to.",
						},
						"display_name": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Name the account was given when it was connected.",
						},
						"bastion_id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Id of the bastion the account is reached through, null when it is reached directly.",
						},
						"created_at": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "RFC 3339 timestamp of when the account was connected.",
						},
					},
				},
			},
		},
	}
}

func (r *accountsDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	r.client = clientFromDataSourceConfigure(req, resp)
}

func (r *accountsDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config accountsDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	accounts, err := r.client.ListAccounts(ctx)
	if err != nil {
		// A data source has nowhere to fall back to: there is no prior state to
		// keep and nothing to remove, so a failed listing is a hard error.
		resp.Diagnostics.AddError("Unable to list Infrawrench accounts", err.Error())
		return
	}

	// A null filter and an unset filter both read as the empty string, which is
	// exactly the "keep everything" case.
	wantPlugin := config.PluginID.ValueString()

	rows := make([]accountItemModel, 0, len(accounts))
	for _, a := range accounts {
		if wantPlugin != "" && a.PluginID != wantPlugin {
			continue
		}
		rows = append(rows, accountItemModel{
			ID:          types.StringValue(a.ID),
			PluginID:    types.StringValue(a.PluginID),
			DisplayName: types.StringValue(a.DisplayName),
			BastionID:   stringValue(a.BastionID),
			CreatedAt:   types.StringValue(a.CreatedAt),
		})
	}

	list, diags := types.ListValueFrom(ctx, accountItemObjectType, rows)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config.ID = types.StringValue(r.client.OrgID())
	config.Accounts = list
	resp.Diagnostics.Append(resp.State.Set(ctx, &config)...)
}
