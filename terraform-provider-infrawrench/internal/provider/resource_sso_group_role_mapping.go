package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*ssoGroupRoleMappingResource)(nil)
	_ resource.ResourceWithConfigure   = (*ssoGroupRoleMappingResource)(nil)
	_ resource.ResourceWithImportState = (*ssoGroupRoleMappingResource)(nil)
)

// NewSSOGroupRoleMappingResource constructs the
// infrawrench_sso_group_role_mapping resource.
func NewSSOGroupRoleMappingResource() resource.Resource { return &ssoGroupRoleMappingResource{} }

type ssoGroupRoleMappingResource struct{ client *iw.Client }

type ssoGroupRoleMappingResourceModel struct {
	ID               types.String `tfsdk:"id"`
	DirectoryGroupID types.String `tfsdk:"directory_group_id"`
	RoleID           types.String `tfsdk:"role_id"`
	Position         types.Int64  `tfsdk:"position"`
	GroupName        types.String `tfsdk:"group_name"`
}

func (r *ssoGroupRoleMappingResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_sso_group_role_mapping"
}

func (r *ssoGroupRoleMappingResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Members of one identity-provider directory group get one Infrawrench role.\n\n" +
			"Mappings are applied on every directory sync and at each sign-in, to members the directory " +
			"provisioned or linked. They are evaluated in `position` order and the first match wins; a " +
			"member in no mapped group gets `infrawrench_sso_settings.default_role_id`. Owners are never " +
			"changed by the directory.\n\n" +
			"Two server-side rules make a mapping safe to hand to whoever manages the directory: it can " +
			"never target the owner role, and the credential creating or changing it must itself hold " +
			"every permission the role grants. Look the group up by name with the " +
			"`infrawrench_sso_directory_groups` data source rather than copying its id.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned mapping id. Use it with `terraform import`."),
			"directory_group_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The WorkOS directory group id (`directory_group_…`). Changing it " +
					"replaces the mapping.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"role_id": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "The role members of the group get. Not the owner role.",
			},
			"position": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "Evaluation order, 0–10000, lowest first. Omit to append after the " +
					"existing mappings.",
				Validators:    []validatorInt64{between(0, 10000)},
				PlanModifiers: []planmodifier.Int64{int64planmodifier.UseStateForUnknown()},
			},
			"group_name": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The group's name in the directory, kept in step by Directory Sync.",
			},
		},
	}
}

func (r *ssoGroupRoleMappingResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func ssoGroupRoleMappingStateFrom(m *iw.SSOGroupRoleMapping) ssoGroupRoleMappingResourceModel {
	return ssoGroupRoleMappingResourceModel{
		ID:               types.StringValue(m.ID),
		DirectoryGroupID: types.StringValue(m.DirectoryGroupID),
		RoleID:           types.StringValue(m.RoleID),
		Position:         types.Int64Value(m.Position),
		GroupName:        types.StringValue(m.GroupName),
	}
}

func (r *ssoGroupRoleMappingResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan ssoGroupRoleMappingResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateSSOGroupRoleMapping(ctx, iw.SSOGroupRoleMappingInput{
		DirectoryGroupID: plan.DirectoryGroupID.ValueString(),
		RoleID:           plan.RoleID.ValueString(),
		Position:         int64Ptr(plan.Position),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to create group to role mapping", err.Error())
		return
	}
	state := ssoGroupRoleMappingStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *ssoGroupRoleMappingResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state ssoGroupRoleMappingResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetSSOGroupRoleMapping(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read group to role mapping", err.Error())
		return
	}
	refreshed := ssoGroupRoleMappingStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *ssoGroupRoleMappingResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state ssoGroupRoleMappingResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateSSOGroupRoleMapping(ctx, state.ID.ValueString(), iw.SSOGroupRoleMappingUpdate{
		RoleID:   stringPtr(plan.RoleID),
		Position: int64Ptr(plan.Position),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to update group to role mapping", err.Error())
		return
	}
	next := ssoGroupRoleMappingStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *ssoGroupRoleMappingResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state ssoGroupRoleMappingResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteSSOGroupRoleMapping(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete group to role mapping", err.Error())
	}
}

func (r *ssoGroupRoleMappingResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
