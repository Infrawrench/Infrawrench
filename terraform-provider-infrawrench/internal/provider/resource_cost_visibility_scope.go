package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costVisibilityScopeResource)(nil)
	_ resource.ResourceWithConfigure   = (*costVisibilityScopeResource)(nil)
	_ resource.ResourceWithImportState = (*costVisibilityScopeResource)(nil)
)

// NewCostVisibilityScopeResource constructs the infrawrench_cost_visibility_scope resource.
func NewCostVisibilityScopeResource() resource.Resource { return &costVisibilityScopeResource{} }

type costVisibilityScopeResource struct{ client *iw.Client }

type costVisibilityScopeModel struct {
	ID            types.String `tfsdk:"id"`
	PrincipalKind types.String `tfsdk:"principal_kind"`
	PrincipalID   types.String `tfsdk:"principal_id"`
	CostCentreIDs types.List   `tfsdk:"cost_centre_ids"`
	AccountIDs    types.List   `tfsdk:"account_ids"`
	SavedFilterID types.String `tfsdk:"saved_filter_id"`
}

func (r *costVisibilityScopeResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_visibility_scope"
}

func (r *costVisibilityScopeResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Restricts which costs a role, a member or an API key can see.\n\n" +
			"A scoped principal sees only matching cost rows on every surface: cost queries, reports, " +
			"dashboard cards, budgets, showback, unit costs, forecasts, the chat agent, MCP tools and the " +
			"CLI. The server applies the scope where cost queries are built, so no surface can forget it.\n\n" +
			"A row matches when it is on one of `account_ids` **or** allocates to one of `cost_centre_ids` " +
			"(or a sub-centre), and, when `saved_filter_id` is set, also matches that saved filter. With no " +
			"accounts and no centres the saved filter decides alone; a scope naming nothing hides every cost.\n\n" +
			"Every scope that applies to someone is **intersected**: a member scope can only narrow their " +
			"role's, and an API key's scope can only narrow its owner. Owners cannot be scoped. Scoped " +
			"principals are refused cost exports, invoices, the weekly digest, config as code and role or " +
			"invitation changes, because those cover the whole organization.\n\n" +
			"Needs `team:role:write` for roles and members. An API key's owner can also scope their own key " +
			"with `apikeys:write`.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned scope id. Import with `<principal_kind>/<principal_id>`."),
			"principal_kind": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "What the scope attaches to: `role`, `member` or `api_key`. Changing it replaces the scope.",
				Validators:          []validator.String{oneOfValidator("role", "member", "api_key")},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"principal_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The role id (`infrawrench_role.x.id`), the member's user id, or the API key id. " +
					"Changing it replaces the scope.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"cost_centre_ids": schema.ListAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     listdefault.StaticValue(types.ListValueMust(types.StringType, nil)),
				MarkdownDescription: "Cost centres whose allocated spend is visible, sub-centres included " +
					"(`infrawrench_cost_centre.x.id`). At most 50.",
				Validators: []validator.List{sizeAtMost(50)},
			},
			"account_ids": schema.ListAttribute{
				Optional:            true,
				Computed:            true,
				ElementType:         types.StringType,
				Default:             listdefault.StaticValue(types.ListValueMust(types.StringType, nil)),
				MarkdownDescription: "Connected accounts whose spend is visible (`infrawrench_account.x.id`). At most 200.",
				Validators:          []validator.List{sizeAtMost(200)},
			},
			"saved_filter_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "A saved filter ANDed onto the scope (`infrawrench_saved_filter.x.id`). " +
					"While a scope references it, the saved filter cannot be deleted.",
			},
		},
	}
}

func (r *costVisibilityScopeResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costVisibilityScopeResource) put(ctx context.Context, plan costVisibilityScopeModel) (*iw.CostVisibilityScope, diag.Diagnostics) {
	var diags diag.Diagnostics
	centres, d := stringSlice(ctx, plan.CostCentreIDs)
	diags.Append(d...)
	accounts, d := stringSlice(ctx, plan.AccountIDs)
	diags.Append(d...)
	if diags.HasError() {
		return nil, diags
	}
	if centres == nil {
		centres = []string{}
	}
	if accounts == nil {
		accounts = []string{}
	}
	out, err := r.client.PutCostVisibilityScope(ctx, iw.CostVisibilityScopeInput{
		PrincipalKind: plan.PrincipalKind.ValueString(),
		PrincipalID:   plan.PrincipalID.ValueString(),
		CostCentreIDs: centres,
		AccountIDs:    accounts,
		SavedFilterID: stringPtr(plan.SavedFilterID),
	})
	if err != nil {
		diags.AddError("Unable to save cost visibility scope", err.Error())
		return nil, diags
	}
	return out, diags
}

func (r *costVisibilityScopeResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costVisibilityScopeModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	out, diags := r.put(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	state, diags := costVisibilityScopeStateFrom(ctx, out)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *costVisibilityScopeResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costVisibilityScopeModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetCostVisibilityScope(ctx, state.PrincipalKind.ValueString(), state.PrincipalID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost visibility scope", err.Error())
		return
	}
	next, diags := costVisibilityScopeStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costVisibilityScopeResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costVisibilityScopeModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	out, diags := r.put(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	next, diags := costVisibilityScopeStateFrom(ctx, out)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete lifts the scope: the principal goes back to whatever any other
// scope (or none) allows.
func (r *costVisibilityScopeResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costVisibilityScopeModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteCostVisibilityScope(ctx, state.PrincipalKind.ValueString(), state.PrincipalID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete cost visibility scope", err.Error())
	}
}

// ImportState takes `<principal_kind>/<principal_id>`, the scope's natural key.
func (r *costVisibilityScopeResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, err := splitImportID(req.ID, 2, "<principal_kind>/<principal_id>")
	if err != nil {
		resp.Diagnostics.AddError("Invalid import ID", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("principal_kind"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("principal_id"), parts[1])...)
}

func costVisibilityScopeStateFrom(ctx context.Context, remote *iw.CostVisibilityScope) (costVisibilityScopeModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	centres, d := stringList(ctx, remote.CostCentreIDs)
	diags.Append(d...)
	accounts, d := stringList(ctx, remote.AccountIDs)
	diags.Append(d...)
	return costVisibilityScopeModel{
		ID:            types.StringValue(remote.ID),
		PrincipalKind: types.StringValue(remote.PrincipalKind),
		PrincipalID:   types.StringValue(remote.PrincipalID),
		CostCentreIDs: centres,
		AccountIDs:    accounts,
		SavedFilterID: stringValue(remote.SavedFilterID),
	}, diags
}
