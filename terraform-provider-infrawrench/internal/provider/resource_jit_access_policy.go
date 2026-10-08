package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/defaults"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*jitAccessPolicyResource)(nil)
	_ resource.ResourceWithConfigure   = (*jitAccessPolicyResource)(nil)
	_ resource.ResourceWithImportState = (*jitAccessPolicyResource)(nil)
)

// NewJitAccessPolicyResource constructs the infrawrench_jit_access_policy resource.
func NewJitAccessPolicyResource() resource.Resource { return &jitAccessPolicyResource{} }

type jitAccessPolicyResource struct{ client *iw.Client }

type jitAccessPolicyTargetModel struct {
	ScopeID   types.String `tfsdk:"scope_id"`
	ScopeName types.String `tfsdk:"scope_name"`
	RoleID    types.String `tfsdk:"role_id"`
	RoleName  types.String `tfsdk:"role_name"`
}

type jitAccessPolicyResourceModel struct {
	ID                              types.String                 `tfsdk:"id"`
	Name                            types.String                 `tfsdk:"name"`
	Description                     types.String                 `tfsdk:"description"`
	Enabled                         types.Bool                   `tfsdk:"enabled"`
	AccountID                       types.String                 `tfsdk:"account_id"`
	Target                          []jitAccessPolicyTargetModel `tfsdk:"target"`
	MaxDurationMinutes              types.Int64                  `tfsdk:"max_duration_minutes"`
	DefaultDurationMinutes          types.Int64                  `tfsdk:"default_duration_minutes"`
	RequestTimeoutMinutes           types.Int64                  `tfsdk:"request_timeout_minutes"`
	RequesterUserIDs                types.List                   `tfsdk:"requester_user_ids"`
	RequesterRoleIDs                types.List                   `tfsdk:"requester_role_ids"`
	ApproverUserIDs                 types.List                   `tfsdk:"approver_user_ids"`
	ApproverRoleIDs                 types.List                   `tfsdk:"approver_role_ids"`
	ApproverOnCallScheduleIDs       types.List                   `tfsdk:"approver_on_call_schedule_ids"`
	AllowSelfApprovalDuringIncident types.Bool                   `tfsdk:"allow_self_approval_during_incident"`
	RequireReason                   types.Bool                   `tfsdk:"require_reason"`
	RequireTicket                   types.Bool                   `tfsdk:"require_ticket"`
}

func (r *jitAccessPolicyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_jit_access_policy"
}

// emptyIDList is the default for every member/role/rotation list: the API
// always answers `[]`, so an omitted list must plan as `[]` rather than null.
func emptyIDList() defaults.List {
	return listdefault.StaticValue(types.ListValueMust(types.StringType, []attr.Value{}))
}

func idListAttribute(description string) schema.ListAttribute {
	return schema.ListAttribute{
		Optional:            true,
		Computed:            true,
		ElementType:         types.StringType,
		Default:             emptyIDList(),
		MarkdownDescription: description,
		Validators:          []validator.List{sizeAtMost(200)},
	}
}

func (r *jitAccessPolicyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A just-in-time access policy: which **cloud roles** members may request on a " +
			"connected account, for how long, who may ask, and who must approve. When a request under " +
			"the policy is approved, the account's provider grants the role (an IAM Identity Center " +
			"account assignment on AWS, a project IAM binding with a time-bound IAM Condition on Google " +
			"Cloud, a RoleBinding on Kubernetes) and Infrawrench removes it when the window ends.\n\n" +
			"Requests and grants are runtime objects and are deliberately not resources: they are " +
			"raised and decided by people, on a stated reason, and API keys cannot act on them at all. " +
			"This resource manages only the policy, which API keys may write.\n\n" +
			"Not to be confused with break-glass access, which elevates Infrawrench permissions and " +
			"never touches a cloud.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned policy id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "What the policy is called, 1–120 characters, e.g. `Production admin for on-call`.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text shown to requesters and approvers, up to 1000 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 1000)},
			},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "A disabled policy accepts no new requests and has no approvers, so its " +
					"pending requests time out. Grants it already made still end on time.",
			},
			"account_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Id of the connected account whose provider grants the roles (see the " +
					"`infrawrench_accounts` data source). Its plugin must support just-in-time access: AWS " +
					"(IAM Identity Center), Google Cloud or Kubernetes.",
			},
			"max_duration_minutes": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Longest window a request may ask for, and the ceiling on the whole " +
					"window after extensions, 5–720 minutes.",
				Validators: []validatorInt64{between(5, 720)},
			},
			"default_duration_minutes": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "Window the request form starts on, 5–720 minutes and no longer than " +
					"`max_duration_minutes`. Defaults to 60 minutes or the maximum, whichever is shorter.",
				Validators:    []validatorInt64{between(5, 720)},
				PlanModifiers: []planmodifier.Int64{int64planmodifier.UseStateForUnknown()},
			},
			"request_timeout_minutes": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(60),
				MarkdownDescription: "How long an undecided request stays decidable, 5–1440 minutes. No " +
					"decision counts as a denial.",
				Validators: []validatorInt64{between(5, 1440)},
			},
			"requester_user_ids": idListAttribute("Member ids who may request under this policy, up to " +
				"200. With `requester_role_ids` also empty, every member holding `access:request` may."),
			"requester_role_ids": idListAttribute("Team role ids whose members may request, up to 200."),
			"approver_user_ids": idListAttribute("Member ids who may approve, up to 200. The approver set " +
				"is the union of the three approver lists, evaluated at decision time; at least one " +
				"approver is required."),
			"approver_role_ids": idListAttribute("Team role ids whose members may approve, up to 200."),
			"approver_on_call_schedule_ids": idListAttribute("Ids of `infrawrench_on_call_schedule` " +
				"rotations, up to 200; whoever is on call on one of them at decision time may approve."),
			"allow_self_approval_during_incident": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "Let an approver approve their **own** request while a declared " +
					"incident is open, for their own principal only. Recorded as self-approved, with the " +
					"incident, in the request and the audit log.",
			},
			"require_reason": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Require a reason of at least 10 characters on every request.",
			},
			"require_ticket": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(false),
				MarkdownDescription: "Require a ticket or incident reference on every request.",
			},
		},
		Blocks: map[string]schema.Block{
			"target": schema.ListNestedBlock{
				MarkdownDescription: "One scope and role pair members may request, 1–50 of them. The ids " +
					"are the provider's own: an AWS account id and a permission set ARN, a GCP project id " +
					"and a role name such as `roles/storage.admin`, or a Kubernetes namespace (or " +
					"`*cluster*` for the whole cluster) and `ClusterRole:<name>` / `Role:<name>`. The " +
					"settings page offers all of them as pickers.",
				Validators: []validator.List{sizeBetween(1, 50)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"scope_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Provider id of the scope, 1–1224 characters.",
							Validators:          []validatorString{stringvalidator.LengthBetween(1, 1224)},
						},
						"scope_name": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Display name for the scope, up to 300 characters. Omit it " +
								"rather than repeating the id: the id is then shown.",
							Validators: []validatorString{stringvalidator.LengthBetween(1, 300)},
						},
						"role_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Provider id of the role, 1–1224 characters.",
							Validators:          []validatorString{stringvalidator.LengthBetween(1, 1224)},
						},
						"role_name": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Display name for the role, up to 300 characters. Omit it " +
								"rather than repeating the id.",
							Validators: []validatorString{stringvalidator.LengthBetween(1, 300)},
						},
					},
				},
			},
		},
	}
}

func (r *jitAccessPolicyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func jitPolicyInputFrom(ctx context.Context, plan jitAccessPolicyResourceModel) (iw.JitPolicyInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	lists := make([][]string, 5)
	for i, l := range []types.List{
		plan.RequesterUserIDs, plan.RequesterRoleIDs,
		plan.ApproverUserIDs, plan.ApproverRoleIDs, plan.ApproverOnCallScheduleIDs,
	} {
		values, d := stringSlice(ctx, l)
		diags.Append(d...)
		lists[i] = values
	}
	targets := make([]iw.JitPolicyTarget, 0, len(plan.Target))
	for _, t := range plan.Target {
		scopeName := t.ScopeID.ValueString()
		if !t.ScopeName.IsNull() && !t.ScopeName.IsUnknown() {
			scopeName = t.ScopeName.ValueString()
		}
		roleName := t.RoleID.ValueString()
		if !t.RoleName.IsNull() && !t.RoleName.IsUnknown() {
			roleName = t.RoleName.ValueString()
		}
		targets = append(targets, iw.JitPolicyTarget{
			ScopeID:   t.ScopeID.ValueString(),
			ScopeName: scopeName,
			RoleID:    t.RoleID.ValueString(),
			RoleName:  roleName,
		})
	}
	return iw.JitPolicyInput{
		Name:                            plan.Name.ValueString(),
		Description:                     stringPtr(plan.Description),
		Enabled:                         plan.Enabled.ValueBool(),
		AccountID:                       plan.AccountID.ValueString(),
		Targets:                         targets,
		MaxDurationMinutes:              plan.MaxDurationMinutes.ValueInt64(),
		DefaultDurationMinutes:          int64Ptr(plan.DefaultDurationMinutes),
		RequestTimeoutMinutes:           plan.RequestTimeoutMinutes.ValueInt64(),
		RequesterUserIDs:                lists[0],
		RequesterRoleIDs:                lists[1],
		ApproverUserIDs:                 lists[2],
		ApproverRoleIDs:                 lists[3],
		ApproverOnCallScheduleIDs:       lists[4],
		AllowSelfApprovalDuringIncident: plan.AllowSelfApprovalDuringIncident.ValueBool(),
		RequireReason:                   plan.RequireReason.ValueBool(),
		RequireTicket:                   plan.RequireTicket.ValueBool(),
	}, diags
}

func (r *jitAccessPolicyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan jitAccessPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := jitPolicyInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateJitPolicy(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create just-in-time access policy", err.Error())
		return
	}
	state, diags := jitPolicyStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *jitAccessPolicyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state jitAccessPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetJitPolicy(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read just-in-time access policy", err.Error())
		return
	}
	refreshed, diags := jitPolicyStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *jitAccessPolicyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan jitAccessPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state jitAccessPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := jitPolicyInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateJitPolicy(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Just-in-time access policy no longer exists",
				"The policy was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update just-in-time access policy", err.Error())
		return
	}
	next, diags := jitPolicyStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the policy. Grants it already made keep running to their end
// and are revoked on time; the sweep that ends them needs nothing from the
// policy.
func (r *jitAccessPolicyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state jitAccessPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteJitPolicy(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete just-in-time access policy", err.Error())
	}
}

func (r *jitAccessPolicyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// displayNameOrNull maps a target name back to state. The API stores the id
// when no name was given, so a name equal to its id reads as "not set": that is
// what keeps a configuration that omits names from diffing forever.
func displayNameOrNull(name, id string) types.String {
	if name == "" || name == id {
		return types.StringNull()
	}
	return types.StringValue(name)
}

// jitPolicyStateFrom maps a policy into state. accountName, labels and
// canRequest are presentation and are not written into state: a renamed
// account would otherwise show as drift on a plan that changes nothing.
func jitPolicyStateFrom(ctx context.Context, remote *iw.JitPolicy) (jitAccessPolicyResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	list := func(values []string) types.List {
		l, d := stringList(ctx, values)
		diags.Append(d...)
		return l
	}
	targets := make([]jitAccessPolicyTargetModel, 0, len(remote.Targets))
	for _, t := range remote.Targets {
		targets = append(targets, jitAccessPolicyTargetModel{
			ScopeID:   types.StringValue(t.ScopeID),
			ScopeName: displayNameOrNull(t.ScopeName, t.ScopeID),
			RoleID:    types.StringValue(t.RoleID),
			RoleName:  displayNameOrNull(t.RoleName, t.RoleID),
		})
	}
	description := types.StringNull()
	if remote.Description != nil && *remote.Description != "" {
		description = types.StringValue(*remote.Description)
	}
	return jitAccessPolicyResourceModel{
		ID:                              types.StringValue(remote.ID),
		Name:                            types.StringValue(remote.Name),
		Description:                     description,
		Enabled:                         types.BoolValue(remote.Enabled),
		AccountID:                       types.StringValue(remote.AccountID),
		Target:                          targets,
		MaxDurationMinutes:              types.Int64Value(remote.MaxDurationMinutes),
		DefaultDurationMinutes:          types.Int64Value(remote.DefaultDurationMinutes),
		RequestTimeoutMinutes:           types.Int64Value(remote.RequestTimeoutMinutes),
		RequesterUserIDs:                list(remote.RequesterUserIDs),
		RequesterRoleIDs:                list(remote.RequesterRoleIDs),
		ApproverUserIDs:                 list(remote.ApproverUserIDs),
		ApproverRoleIDs:                 list(remote.ApproverRoleIDs),
		ApproverOnCallScheduleIDs:       list(remote.ApproverOnCallScheduleIDs),
		AllowSelfApprovalDuringIncident: types.BoolValue(remote.AllowSelfApprovalDuringIncident),
		RequireReason:                   types.BoolValue(remote.RequireReason),
		RequireTicket:                   types.BoolValue(remote.RequireTicket),
	}, diags
}
