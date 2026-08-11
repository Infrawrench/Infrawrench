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
	_ datasource.DataSource              = (*slackInstallationsDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*slackInstallationsDataSource)(nil)
)

// NewSlackInstallationsDataSource constructs the
// infrawrench_slack_installations data source.
func NewSlackInstallationsDataSource() datasource.DataSource {
	return &slackInstallationsDataSource{}
}

type slackInstallationsDataSource struct{ client *iw.Client }

type slackInstallationItemModel struct {
	ID       types.String `tfsdk:"id"`
	TeamID   types.String `tfsdk:"team_id"`
	TeamName types.String `tfsdk:"team_name"`
}

var slackInstallationItemAttrTypes = map[string]attr.Type{
	"id":        types.StringType,
	"team_id":   types.StringType,
	"team_name": types.StringType,
}

var slackInstallationItemObjectType = types.ObjectType{AttrTypes: slackInstallationItemAttrTypes}

type slackInstallationsDataSourceModel struct {
	ID            types.String `tfsdk:"id"`
	Configured    types.Bool   `tfsdk:"configured"`
	Installations types.List   `tfsdk:"installations"`
}

func (r *slackInstallationsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_slack_installations"
}

func (r *slackInstallationsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The Slack workspaces connected to this organization.\n\n" +
			"Connecting one is an OAuth flow a Terraform provider cannot perform, so this is read-only by " +
			"necessity: install the app once in the settings page, then use the `id` here as " +
			"`installation_id` on `infrawrench_slack_channel`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. A plural data source has no identity of its own; " +
					"this is the conventional placeholder.",
			},
			"configured": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether this **deployment** has a Slack app registered at all. `false` " +
					"means no workspace can be connected, however the organization is set up — a useful thing " +
					"to assert in a `precondition` before planning channels that could never work.",
			},
			"installations": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Connected workspaces, in the order the API returned them.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed: true,
							MarkdownDescription: "Infrawrench's id for the connection — the value " +
								"`infrawrench_slack_channel.installation_id` takes.",
						},
						"team_id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Slack's own workspace id, `T…`.",
						},
						"team_name": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Workspace name, when Slack reported one.",
						},
					},
				},
			},
		},
	}
}

func (r *slackInstallationsDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	r.client = clientFromDataSourceConfigure(req, resp)
}

func (r *slackInstallationsDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config slackInstallationsDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	status, err := r.client.GetSlackStatus(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read Slack status", err.Error())
		return
	}

	rows := make([]slackInstallationItemModel, 0, len(status.Installations))
	for _, i := range status.Installations {
		rows = append(rows, slackInstallationItemModel{
			ID:       types.StringValue(i.ID),
			TeamID:   types.StringValue(i.TeamID),
			TeamName: stringValue(i.TeamName),
		})
	}

	list, diags := types.ListValueFrom(ctx, slackInstallationItemObjectType, rows)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config.ID = types.StringValue(r.client.OrgID())
	config.Configured = types.BoolValue(status.Configured)
	config.Installations = list
	resp.Diagnostics.Append(resp.State.Set(ctx, &config)...)
}
