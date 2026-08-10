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
	_ datasource.DataSource              = (*pluginsDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*pluginsDataSource)(nil)
)

// NewPluginsDataSource constructs the infrawrench_plugins data source.
func NewPluginsDataSource() datasource.DataSource { return &pluginsDataSource{} }

type pluginsDataSource struct{ client *iw.Client }

type pluginItemModel struct {
	ID          types.String `tfsdk:"id"`
	DisplayName types.String `tfsdk:"display_name"`
}

var pluginItemAttrTypes = map[string]attr.Type{
	"id":           types.StringType,
	"display_name": types.StringType,
}

var pluginItemObjectType = types.ObjectType{AttrTypes: pluginItemAttrTypes}

type pluginsDataSourceModel struct {
	ID      types.String `tfsdk:"id"`
	Plugins types.List   `tfsdk:"plugins"`
}

func (r *pluginsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_plugins"
}

func (r *pluginsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Provider plugins this Infrawrench installation knows about.\n\n" +
			"Use it to discover the valid `plugin_id` values for `infrawrench_allocation_rule` and " +
			"`infrawrench_billing_rule` matches, and for a `provider`-dimension clause in any cost " +
			"`filter` block. The set grows with each release, so reading it beats hard-coding a list " +
			"that will quietly go stale.\n\n" +
			"Only the id and display name are exposed. The underlying route also returns each " +
			"plugin's logo as inline SVG — frequently several kilobytes of markup — along with the " +
			"credential-field metadata the connect form is built from. Neither is useful in a " +
			"configuration, and putting the SVG into state would inflate every state file that " +
			"reads this data source for no benefit, so the wire struct decodes neither.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. A plural data source has no identity of its own; " +
					"this is the conventional placeholder.",
			},
			"plugins": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Available plugins, in the order the API returned them.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Plugin id, e.g. `aws`. This is the value a `plugin_id` match takes.",
						},
						"display_name": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Human-readable plugin name, e.g. `Amazon Web Services`.",
						},
					},
				},
			},
		},
	}
}

func (r *pluginsDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	r.client = clientFromDataSourceConfigure(req, resp)
}

func (r *pluginsDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config pluginsDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	plugins, err := r.client.ListPlugins(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to list Infrawrench plugins", err.Error())
		return
	}

	rows := make([]pluginItemModel, 0, len(plugins))
	for _, p := range plugins {
		rows = append(rows, pluginItemModel{
			ID:          types.StringValue(p.ID),
			DisplayName: types.StringValue(p.DisplayName),
		})
	}

	list, diags := types.ListValueFrom(ctx, pluginItemObjectType, rows)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config.ID = types.StringValue(r.client.OrgID())
	config.Plugins = list
	resp.Diagnostics.Append(resp.State.Set(ctx, &config)...)
}
