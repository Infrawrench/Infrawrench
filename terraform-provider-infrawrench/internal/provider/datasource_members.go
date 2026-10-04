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
	_ datasource.DataSource              = (*membersDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*membersDataSource)(nil)
)

// NewMembersDataSource constructs the infrawrench_members data source.
func NewMembersDataSource() datasource.DataSource { return &membersDataSource{} }

type membersDataSource struct{ client *iw.Client }

type memberItemModel struct {
	ID    types.String `tfsdk:"id"`
	Name  types.String `tfsdk:"name"`
	Email types.String `tfsdk:"email"`
}

var memberItemAttrTypes = map[string]attr.Type{
	"id":    types.StringType,
	"name":  types.StringType,
	"email": types.StringType,
}

var memberItemObjectType = types.ObjectType{AttrTypes: memberItemAttrTypes}

type membersDataSourceModel struct {
	ID             types.String `tfsdk:"id"`
	Email          types.String `tfsdk:"email"`
	EmailAvailable types.Bool   `tfsdk:"email_available"`
	Members        types.List   `tfsdk:"members"`
}

func (r *membersDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_members"
}

func (r *membersDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The organization's current members, with their login addresses.\n\n" +
			"This is the picker for alert email: it turns an address a human knows into the user id that " +
			"`email_member_ids` (on `infrawrench_budget`, `infrawrench_cost_alert`, " +
			"`infrawrench_anomaly_settings` and `infrawrench_efficiency_alert_settings`) and " +
			"`email-member` destinations on `infrawrench_alert_routing` want. Naming a member by id rather " +
			"than by address means an address change follows them and a member who leaves stops " +
			"receiving.\n\n" +
			"Reads the alert email picker route, which needs only `costs:read`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. A plural data source has no identity of its own; " +
					"this is the conventional placeholder.",
			},
			"email": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Restricts the result to the member signing in with this address, " +
					"compared case-insensitively. Filtered client-side: the route has no server-side filter.",
			},
			"email_available": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether this deployment has a mail provider configured. `false` means " +
					"alert email is never sent, a useful thing to assert in a `precondition`.",
			},
			"members": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Matching members, in the order the API returned them.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "User id, the value `email_member_ids` and `user_id` take.",
						},
						"name": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Display name, null when the member never set one.",
						},
						"email": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Current login address.",
						},
					},
				},
			},
		},
	}
}

func (r *membersDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	r.client = clientFromDataSourceConfigure(req, resp)
}

func (r *membersDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config membersDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	options, err := r.client.GetAlertEmailOptions(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to list Infrawrench members", err.Error())
		return
	}

	want := strings.TrimSpace(config.Email.ValueString())

	rows := make([]memberItemModel, 0, len(options.Members))
	for _, m := range options.Members {
		if want != "" && !strings.EqualFold(m.Email, want) {
			continue
		}
		rows = append(rows, memberItemModel{
			ID:    types.StringValue(m.UserID),
			Name:  stringValue(m.Name),
			Email: types.StringValue(m.Email),
		})
	}

	list, diags := types.ListValueFrom(ctx, memberItemObjectType, rows)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config.ID = types.StringValue(r.client.OrgID())
	config.EmailAvailable = types.BoolValue(options.EmailAvailable)
	config.Members = list
	resp.Diagnostics.Append(resp.State.Set(ctx, &config)...)
}
