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
	_ datasource.DataSource              = (*ssoDirectoryGroupsDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*ssoDirectoryGroupsDataSource)(nil)
)

// NewSSODirectoryGroupsDataSource constructs the
// infrawrench_sso_directory_groups data source.
func NewSSODirectoryGroupsDataSource() datasource.DataSource {
	return &ssoDirectoryGroupsDataSource{}
}

type ssoDirectoryGroupsDataSource struct{ client *iw.Client }

type ssoDirectoryGroupItemModel struct {
	ID            types.String `tfsdk:"id"`
	Name          types.String `tfsdk:"name"`
	DirectoryID   types.String `tfsdk:"directory_id"`
	DirectoryName types.String `tfsdk:"directory_name"`
}

var ssoDirectoryGroupObjectType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"id":             types.StringType,
	"name":           types.StringType,
	"directory_id":   types.StringType,
	"directory_name": types.StringType,
}}

type ssoDirectoryGroupsDataSourceModel struct {
	ID     types.String `tfsdk:"id"`
	Groups types.List   `tfsdk:"groups"`
}

func (r *ssoDirectoryGroupsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_sso_directory_groups"
}

func (r *ssoDirectoryGroupsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Every group in the organization's SCIM directories, as Directory Sync reports " +
			"them. The way to find a group's id for `infrawrench_sso_group_role_mapping` by its name, " +
			"for example with a `for` expression over `groups`. Requires single sign-on to be set up.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. A plural data source has no identity of its own; " +
					"this is the conventional placeholder.",
			},
			"groups": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Directory groups, across every connected directory.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "The group id, `directory_group_…`.",
						},
						"name": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "The group's name in the identity provider.",
						},
						"directory_id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "The directory the group belongs to.",
						},
						"directory_name": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "That directory's name.",
						},
					},
				},
			},
		},
	}
}

func (r *ssoDirectoryGroupsDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	r.client = clientFromDataSourceConfigure(req, resp)
}

func (r *ssoDirectoryGroupsDataSource) Read(ctx context.Context, _ datasource.ReadRequest, resp *datasource.ReadResponse) {
	groups, err := r.client.ListSSOGroups(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to list directory groups", err.Error())
		return
	}
	rows := make([]ssoDirectoryGroupItemModel, 0, len(groups))
	for _, g := range groups {
		rows = append(rows, ssoDirectoryGroupItemModel{
			ID:            types.StringValue(g.ID),
			Name:          types.StringValue(g.Name),
			DirectoryID:   types.StringValue(g.DirectoryID),
			DirectoryName: types.StringValue(g.DirectoryName),
		})
	}
	list, diags := types.ListValueFrom(ctx, ssoDirectoryGroupObjectType, rows)
	resp.Diagnostics.Append(diags...)
	state := ssoDirectoryGroupsDataSourceModel{
		ID:     types.StringValue(r.client.OrgID()),
		Groups: list,
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}
