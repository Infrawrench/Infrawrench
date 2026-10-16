package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*roleDefaultDashboardResource)(nil)
	_ resource.ResourceWithConfigure   = (*roleDefaultDashboardResource)(nil)
	_ resource.ResourceWithImportState = (*roleDefaultDashboardResource)(nil)
)

// systemRoleKeys are the built-in roles every organization has.
var systemRoleKeys = []string{"owner", "admin", "member"}

// NewRoleDefaultDashboardResource constructs the infrawrench_role_default_dashboard resource.
func NewRoleDefaultDashboardResource() resource.Resource { return &roleDefaultDashboardResource{} }

type roleDefaultDashboardResource struct{ client *iw.Client }

type roleDefaultDashboardModel struct {
	ID          types.String `tfsdk:"id"`
	RoleID      types.String `tfsdk:"role_id"`
	SystemRole  types.String `tfsdk:"system_role"`
	DashboardID types.String `tfsdk:"dashboard_id"`
	RoleName    types.String `tfsdk:"role_name"`
}

func (r *roleDefaultDashboardResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_role_default_dashboard"
}

func (r *roleDefaultDashboardResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The dashboard members holding a role land on when they open the app.\n\n" +
			"Precedence is a member's own \"My default dashboard\" first, then their role's default, then " +
			"the organization default. This resource sets the middle layer; members keep the ability to " +
			"choose their own.\n\n" +
			"Works for built-in roles (`system_role = \"member\"`) as well as custom ones (`role_id = " +
			"infrawrench_role.x.id`), which is why it is a resource of its own rather than an attribute on " +
			"`infrawrench_role`: that resource refuses built-in roles.\n\n" +
			"The server refuses a dashboard the role cannot open: the role needs `dashboards:read`, and the " +
			"dashboard has to be shared with the role or with the whole organization (see " +
			"`infrawrench_object_sharing`). If sharing is narrowed later, members skip the role default and " +
			"land on the organization default instead of a dashboard they cannot see.\n\n" +
			"Needs `org:settings:write` to change and `team:read` to refresh. Unlike `infrawrench_role`, " +
			"whose writes are closed to API keys, this resource is **open to API keys**: the route lives " +
			"under `/dashboards`, not `/team`, and choosing a landing page manufactures no authority, since " +
			"the dashboard must already be visible to the role. Destroying the resource clears the role's " +
			"default; the role and the dashboard are untouched.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The role id. Use it (or `owner`, `admin`, `member`) with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"role_id": schema.StringAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "A custom role, e.g. `infrawrench_role.finance.id`. Exactly one of `role_id` " +
					"and `system_role`. Changing it replaces the resource.",
				Validators: []validator.String{
					stringvalidator.ExactlyOneOf(path.MatchRoot("role_id"), path.MatchRoot("system_role")),
				},
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
					stringplanmodifier.RequiresReplaceIfConfigured(),
				},
			},
			"system_role": schema.StringAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "A built-in role: `owner`, `admin` or `member`. Exactly one of `role_id` and " +
					"`system_role`. Changing it replaces the resource.",
				Validators: []validator.String{oneOfValidator(systemRoleKeys...)},
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
					stringplanmodifier.RequiresReplaceIfConfigured(),
				},
			},
			"dashboard_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The dashboard's id, as it appears in the dashboard's URL. It must be " +
					"shared with the role.",
			},
			"role_name": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The role's display name, for reference.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *roleDefaultDashboardResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// roleID resolves the configured role to an id: `role_id` as given, or the
// built-in role's id looked up by its key.
func (r *roleDefaultDashboardResource) roleID(ctx context.Context, plan roleDefaultDashboardModel) (string, error) {
	if !plan.RoleID.IsNull() && !plan.RoleID.IsUnknown() && plan.RoleID.ValueString() != "" {
		return plan.RoleID.ValueString(), nil
	}
	key := plan.SystemRole.ValueString()
	roles, err := r.client.ListRoles(ctx)
	if err != nil {
		return "", err
	}
	for _, role := range roles {
		if role.IsSystem && role.SystemKey != nil && *role.SystemKey == key {
			return role.ID, nil
		}
	}
	return "", fmt.Errorf("no built-in %q role in this organization", key)
}

func roleDefaultDashboardStateFrom(remote *iw.RoleDefaultDashboard) roleDefaultDashboardModel {
	state := roleDefaultDashboardModel{
		ID:         types.StringValue(remote.RoleID),
		RoleID:     types.StringValue(remote.RoleID),
		SystemRole: types.StringNull(),
		RoleName:   types.StringValue(remote.RoleName),
	}
	if remote.IsSystem && remote.SystemKey != nil {
		state.SystemRole = types.StringValue(*remote.SystemKey)
	}
	if remote.DashboardID != nil {
		state.DashboardID = types.StringValue(*remote.DashboardID)
	} else {
		state.DashboardID = types.StringNull()
	}
	return state
}

func (r *roleDefaultDashboardResource) put(ctx context.Context, plan roleDefaultDashboardModel) (roleDefaultDashboardModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	roleID, err := r.roleID(ctx, plan)
	if err != nil {
		diags.AddError("Unable to resolve the role", err.Error())
		return plan, diags
	}
	out, err := r.client.SetRoleDefaultDashboard(ctx, roleID, plan.DashboardID.ValueString())
	if err != nil {
		diags.AddError("Unable to set the role's default dashboard", err.Error())
		return plan, diags
	}
	return roleDefaultDashboardStateFrom(out), diags
}

func (r *roleDefaultDashboardResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan roleDefaultDashboardModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	state, diags := r.put(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *roleDefaultDashboardResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state roleDefaultDashboardModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	roleID := state.RoleID.ValueString()
	if roleID == "" {
		// Imported by built-in role key: resolve it once.
		id, err := r.roleID(ctx, state)
		if err != nil {
			resp.Diagnostics.AddError("Unable to resolve the role", err.Error())
			return
		}
		roleID = id
	}
	remote, err := r.client.GetRoleDefaultDashboard(ctx, roleID)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read the role's default dashboard", err.Error())
		return
	}
	next := roleDefaultDashboardStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *roleDefaultDashboardResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan roleDefaultDashboardModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	state, diags := r.put(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Delete clears the role's default: its members fall back to the
// organization default. The role and the dashboard are not touched.
func (r *roleDefaultDashboardResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state roleDefaultDashboardModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.ClearRoleDefaultDashboard(ctx, state.RoleID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to clear the role's default dashboard", err.Error())
	}
}

// ImportState takes a role id, or a built-in role's key (`owner`, `admin`,
// `member`).
func (r *roleDefaultDashboardResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	for _, key := range systemRoleKeys {
		if req.ID == key {
			resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("system_role"), key)...)
			resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("role_id"), "")...)
			return
		}
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("role_id"), req.ID)...)
}
