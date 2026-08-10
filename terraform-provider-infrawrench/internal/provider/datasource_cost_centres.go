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
	_ datasource.DataSource              = (*costCentresDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*costCentresDataSource)(nil)
)

// NewCostCentresDataSource constructs the infrawrench_cost_centres data source.
func NewCostCentresDataSource() datasource.DataSource { return &costCentresDataSource{} }

type costCentresDataSource struct{ client *iw.Client }

type costCentreItemModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	ParentID    types.String `tfsdk:"parent_id"`
	CreatedAt   types.String `tfsdk:"created_at"`
	UpdatedAt   types.String `tfsdk:"updated_at"`
}

var costCentreItemAttrTypes = map[string]attr.Type{
	"id":          types.StringType,
	"name":        types.StringType,
	"description": types.StringType,
	"parent_id":   types.StringType,
	"created_at":  types.StringType,
	"updated_at":  types.StringType,
}

var costCentreItemObjectType = types.ObjectType{AttrTypes: costCentreItemAttrTypes}

type costCentresDataSourceModel struct {
	ID          types.String `tfsdk:"id"`
	CostCentres types.List   `tfsdk:"cost_centres"`
}

func (r *costCentresDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_centres"
}

func (r *costCentresDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Every cost centre in the organization, whoever created it.\n\n" +
			"This is how a configuration references centres that exist outside Terraform — pointing " +
			"an `infrawrench_allocation_rule` at a hierarchy the finance team built in the UI, for " +
			"instance, without importing those centres and taking ownership of them.\n\n" +
			"The API returns a flat list with a `parent_id` on each row; the tree is implied rather " +
			"than nested, because a nested shape would be awkward to index into from HCL. Nesting is " +
			"capped at four levels deep, so walking the parent chain terminates quickly.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. A plural data source has no identity of its own; " +
					"this is the conventional placeholder.",
			},
			"cost_centres": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Cost centres, flat, in the order the API returned them.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Cost centre id, as used by `infrawrench_allocation_rule`'s `cost_centre_id`.",
						},
						"name": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Display name.",
						},
						"description": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Free-text description, null when none was set.",
						},
						"parent_id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Id of the parent centre, null for a root centre.",
						},
						"created_at": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "RFC 3339 creation timestamp.",
						},
						"updated_at": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "RFC 3339 timestamp of the last change.",
						},
					},
				},
			},
		},
	}
}

func (r *costCentresDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	r.client = clientFromDataSourceConfigure(req, resp)
}

func (r *costCentresDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config costCentresDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	centres, err := r.client.ListCostCentres(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to list Infrawrench cost centres", err.Error())
		return
	}

	rows := make([]costCentreItemModel, 0, len(centres))
	for _, c := range centres {
		rows = append(rows, costCentreItemModel{
			ID:          types.StringValue(c.ID),
			Name:        types.StringValue(c.Name),
			Description: stringValue(c.Description),
			ParentID:    stringValue(c.ParentID),
			CreatedAt:   types.StringValue(c.CreatedAt),
			UpdatedAt:   types.StringValue(c.UpdatedAt),
		})
	}

	list, diags := types.ListValueFrom(ctx, costCentreItemObjectType, rows)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config.ID = types.StringValue(r.client.OrgID())
	config.CostCentres = list
	resp.Diagnostics.Append(resp.State.Set(ctx, &config)...)
}
