package provider

import (
	"context"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ datasource.DataSource              = (*resourcesDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*resourcesDataSource)(nil)
)

// NewResourcesDataSource constructs the infrawrench_resources data source.
func NewResourcesDataSource() datasource.DataSource { return &resourcesDataSource{} }

type resourcesDataSource struct{ client *iw.Client }

type resourceItemModel struct {
	ID             types.String `tfsdk:"id"`
	AccountID      types.String `tfsdk:"account_id"`
	PluginID       types.String `tfsdk:"plugin_id"`
	ResourceTypeID types.String `tfsdk:"resource_type_id"`
	DisplayName    types.String `tfsdk:"display_name"`
	ExternalID     types.String `tfsdk:"external_id"`
}

var resourceItemAttrTypes = map[string]attr.Type{
	"id":               types.StringType,
	"account_id":       types.StringType,
	"plugin_id":        types.StringType,
	"resource_type_id": types.StringType,
	"display_name":     types.StringType,
	"external_id":      types.StringType,
}

var resourceItemObjectType = types.ObjectType{AttrTypes: resourceItemAttrTypes}

type resourcesDataSourceModel struct {
	ID             types.String `tfsdk:"id"`
	AccountID      types.String `tfsdk:"account_id"`
	ResourceTypeID types.String `tfsdk:"resource_type_id"`
	NameContains   types.String `tfsdk:"name_contains"`
	Resources      types.List   `tfsdk:"resources"`
}

func (r *resourcesDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_resources"
}

func (r *resourcesDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The cloud resources synced from one account.\n\n" +
			"This provider never *writes* cloud resources — ejecting them to HCL is what Terraform export " +
			"is for, and creating them is your cloud provider's job. Reading them matters because " +
			"`infrawrench_probe`, `infrawrench_schedule` and `infrawrench_log_query` all address a " +
			"resource by its Infrawrench id, and hard-coding one of those in HCL is exactly what this data " +
			"source exists to avoid.\n\n" +
			"The listing is what the last sync found. A resource created five minutes ago may not be here " +
			"yet, which makes this a poor thing to depend on inside the same apply that created it.\n\n" +
			"Each resource's fields and outputs are deliberately **not** exposed: they are unbounded " +
			"provider-shaped blobs, and putting them in state would write a resource's entire " +
			"configuration — including anything sensitive in it — into every state file that reads this.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The account id the listing was read from. A plural data source has no " +
					"identity of its own.",
			},
			"account_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Account to list. Required rather than optional because the API has no " +
					"org-wide resource listing — resources are read per account.",
			},
			"resource_type_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Keep only resources of this type, e.g. `ec2_instance`. Filtered " +
					"client-side after the listing.",
			},
			"name_contains": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Keep only resources whose display name contains this substring, matched " +
					"case-insensitively. Filtered client-side.\n\n" +
					"A filter that matches several resources is not an error here — the data source returns " +
					"them all, and it is the configuration's job to pick one. Narrow it until " +
					"`length(...) == 1` if you are going to index into it.",
			},
			"resources": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Matching resources, in the order the API returned them.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed: true,
							MarkdownDescription: "Infrawrench resource id — the value `resource_id` takes on a " +
								"probe, a schedule or a log stream.",
						},
						"account_id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Account the resource belongs to.",
						},
						"plugin_id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Plugin the resource belongs to.",
						},
						"resource_type_id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Resource type within the plugin.",
						},
						"display_name": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Name as the provider reports it.",
						},
						"external_id": schema.StringAttribute{
							Computed: true,
							MarkdownDescription: "The provider's own identifier — an instance id, an ARN — or " +
								"null when the plugin does not carry one.",
						},
					},
				},
			},
		},
	}
}

func (r *resourcesDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	r.client = clientFromDataSourceConfigure(req, resp)
}

func (r *resourcesDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config resourcesDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	accountID := config.AccountID.ValueString()
	resources, err := r.client.ListAccountResources(ctx, accountID)
	if err != nil {
		resp.Diagnostics.AddError("Unable to list resources", err.Error())
		return
	}

	wantType := config.ResourceTypeID.ValueString()
	wantName := strings.ToLower(config.NameContains.ValueString())

	rows := make([]resourceItemModel, 0, len(resources))
	for _, res := range resources {
		if wantType != "" && res.ResourceTypeID != wantType {
			continue
		}
		if wantName != "" && !strings.Contains(strings.ToLower(res.DisplayName), wantName) {
			continue
		}
		rows = append(rows, resourceItemModel{
			ID:             types.StringValue(res.ID),
			AccountID:      types.StringValue(res.AccountID),
			PluginID:       types.StringValue(res.PluginID),
			ResourceTypeID: types.StringValue(res.ResourceTypeID),
			DisplayName:    types.StringValue(res.DisplayName),
			ExternalID:     stringValue(res.ExternalID),
		})
	}

	list, diags := types.ListValueFrom(ctx, resourceItemObjectType, rows)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config.ID = types.StringValue(accountID)
	config.Resources = list
	resp.Diagnostics.Append(resp.State.Set(ctx, &config)...)
}
