package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*roleResource)(nil)
	_ resource.ResourceWithConfigure   = (*roleResource)(nil)
	_ resource.ResourceWithImportState = (*roleResource)(nil)
)

// NewRoleResource constructs the infrawrench_role resource.
func NewRoleResource() resource.Resource { return &roleResource{} }

type roleResource struct{ client *iw.Client }

type roleResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Permissions types.Set    `tfsdk:"permissions"`
}

func (r *roleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_role"
}

func (r *roleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A custom permission set members can be assigned.\n\n" +
			"Of everything this provider manages, this is the one where a plan is worth the most: " +
			"`permissions` is a list of grants, and a Terraform diff shows exactly which line was added " +
			"to whose access, in a pull request, with a reviewer. The same change made in a settings page " +
			"leaves only an audit entry saying somebody edited a role.\n\n" +
			"**Built-in roles cannot be managed.** They are readable but not editable, and importing one " +
			"fails with an explanation rather than planning an update the API would reject.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned role id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name shown when assigning the role.",
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "What the role is for.",
			},
			"permissions": schema.SetAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Permissions the role grants, e.g. `costs:read`, `budgets:write`.\n\n" +
					"A **set** rather than a list on purpose: order carries no meaning here, and a list would " +
					"plan a diff every time somebody sorted the block differently.\n\n" +
					"Wildcards are accepted — `resources:*:read`, or `*` for everything — and are not " +
					"expanded, so a wildcard role picks up permissions added by later releases. Read the " +
					"catalogue with `data.infrawrench_permissions`; an unknown permission string is rejected " +
					"by the server rather than silently ignored.",
			},
		},
	}
}

func (r *roleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *roleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan roleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := roleInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateRole(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create role", err.Error())
		return
	}

	state, diags := roleStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *roleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state roleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetRole(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read role", err.Error())
		return
	}
	if remote.IsSystem {
		resp.Diagnostics.AddError(
			"Role is a built-in role",
			"Role "+remote.ID+" ("+remote.Name+") is a built-in role and cannot be managed by Terraform. "+
				"Remove it from state with `terraform state rm`, and create a custom role instead if you need "+
				"a different permission set.")
		return
	}

	refreshed, diags := roleStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *roleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan roleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state roleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := roleInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateRole(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Role no longer exists",
				"The role was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update role", err.Error())
		return
	}

	next, diags := roleStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the role.
//
// The server refuses to delete a role that members still hold, and that 409
// surfaces here as a failed destroy rather than being retried or forced —
// silently reassigning people to a different permission set is not something a
// `terraform destroy` should decide.
func (r *roleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state roleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteRole(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete role", err.Error())
	}
}

func (r *roleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func roleInputFrom(ctx context.Context, model roleResourceModel) (iw.RoleInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	permissions := []string{}
	if !model.Permissions.IsNull() && !model.Permissions.IsUnknown() {
		diags.Append(model.Permissions.ElementsAs(ctx, &permissions, false)...)
		if diags.HasError() {
			return iw.RoleInput{}, diags
		}
	}

	return iw.RoleInput{
		Name:        model.Name.ValueString(),
		Description: stringPtr(model.Description),
		Permissions: permissions,
	}, diags
}

func roleStateFrom(ctx context.Context, remote *iw.Role) (roleResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	permissions := remote.Permissions
	if permissions == nil {
		permissions = []string{}
	}
	set, d := types.SetValueFrom(ctx, types.StringType, permissions)
	diags.Append(d...)

	return roleResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Description: stringValue(remote.Description),
		Permissions: set,
	}, diags
}
