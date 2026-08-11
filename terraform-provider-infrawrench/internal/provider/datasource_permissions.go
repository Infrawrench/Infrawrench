package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ datasource.DataSource              = (*permissionsDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*permissionsDataSource)(nil)
)

// NewPermissionsDataSource constructs the infrawrench_permissions data source.
func NewPermissionsDataSource() datasource.DataSource { return &permissionsDataSource{} }

type permissionsDataSource struct{ client *iw.Client }

type permissionsDataSourceModel struct {
	ID          types.String `tfsdk:"id"`
	Permissions types.List   `tfsdk:"permissions"`
}

func (r *permissionsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_permissions"
}

func (r *permissionsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Every permission string this installation understands — the catalogue " +
			"`infrawrench_role` and `infrawrench_api_key` grant from.\n\n" +
			"The list grows with each release, so reading it beats hard-coding one that will quietly go " +
			"stale. Note the direction of that staleness: a role written with an explicit list does **not** " +
			"pick up permissions added later, which is usually what you want for a least-privilege role " +
			"and is exactly what wildcards exist to opt out of.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. A plural data source has no identity of its own; " +
					"this is the conventional placeholder.",
			},
			"permissions": schema.ListAttribute{
				Computed:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Permission strings, e.g. `costs:read`, in the order the API returned them.",
			},
		},
	}
}

func (r *permissionsDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	r.client = clientFromDataSourceConfigure(req, resp)
}

func (r *permissionsDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config permissionsDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	permissions, err := r.client.ListPermissions(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to list permissions", err.Error())
		return
	}

	list, diags := stringList(ctx, permissions)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config.ID = types.StringValue(r.client.OrgID())
	config.Permissions = list
	resp.Diagnostics.Append(resp.State.Set(ctx, &config)...)
}
