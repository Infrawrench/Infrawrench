package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
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
	_ resource.Resource                = (*objectSharingResource)(nil)
	_ resource.ResourceWithConfigure   = (*objectSharingResource)(nil)
	_ resource.ResourceWithImportState = (*objectSharingResource)(nil)
)

// NewObjectSharingResource constructs the infrawrench_object_sharing resource.
func NewObjectSharingResource() resource.Resource { return &objectSharingResource{} }

type objectSharingResource struct{ client *iw.Client }

type objectSharingModel struct {
	ID         types.String `tfsdk:"id"`
	ObjectType types.String `tfsdk:"object_type"`
	ObjectID   types.String `tfsdk:"object_id"`
	OrgAccess  types.String `tfsdk:"org_access"`
	Grant      types.Set    `tfsdk:"grant"`
}

type objectSharingGrantModel struct {
	PrincipalKind types.String `tfsdk:"principal_kind"`
	PrincipalID   types.String `tfsdk:"principal_id"`
	Level         types.String `tfsdk:"level"`
}

var objectSharingGrantAttrTypes = map[string]attr.Type{
	"principal_kind": types.StringType,
	"principal_id":   types.StringType,
	"level":          types.StringType,
}

func (r *objectSharingResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_object_sharing"
}

func (r *objectSharingResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Who can open or edit one cost report, report folder or dashboard.\n\n" +
			"Authoritative for the object: the org-wide default and every `grant` block are the whole " +
			"sharing document, and anything added in the Share dialog outside Terraform shows up as a diff. " +
			"Destroying the resource resets the object to the default, where everyone in the organization " +
			"can edit.\n\n" +
			"Sharing never goes beyond a role: opening still needs `costs:read` or `dashboards:read` and " +
			"editing `costs:write` or `dashboards:write`. Explicit sharing on a report folder also reaches " +
			"every report and subfolder inside it. Members holding `sharing:override` (admins and owners) " +
			"see and manage every object regardless.\n\n" +
			"Changing sharing needs owner access on the object. A report's creator is always its owner and " +
			"is not listed here; a dashboard or folder must keep at least one `owner` grant.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "`<object_type>/<object_id>`. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"object_type": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "`cost_report`, `cost_report_folder` or `dashboard`. Changing it replaces the resource.",
				Validators:          []validator.String{oneOfValidator("cost_report", "cost_report_folder", "dashboard")},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"object_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The object's id, e.g. `infrawrench_cost_report.x.id`. Changing it replaces " +
					"the resource.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"org_access": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "What everyone in the organization can do: `editor`, `viewer` or `none`. " +
					"`editor` is how an object nobody has shared behaves.",
				Validators: []validator.String{oneOfValidator("editor", "viewer", "none")},
			},
		},
		Blocks: map[string]schema.Block{
			"grant": schema.SetNestedBlock{
				MarkdownDescription: "Access for one member or role, on top of `org_access`. A set: order carries no meaning.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"principal_kind": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "`member` or `role`.",
							Validators:          []validator.String{oneOfValidator("member", "role")},
						},
						"principal_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "The member's user id or the role id (`infrawrench_role.x.id`).",
						},
						"level": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "`owner` (edit and share), `editor` or `viewer`.",
							Validators:          []validator.String{oneOfValidator("owner", "editor", "viewer")},
						},
					},
				},
			},
		},
	}
}

func (r *objectSharingResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *objectSharingResource) put(ctx context.Context, plan objectSharingModel) (*iw.ObjectSharing, diag.Diagnostics) {
	var diags diag.Diagnostics
	var grants []objectSharingGrantModel
	if !plan.Grant.IsNull() && !plan.Grant.IsUnknown() {
		diags.Append(plan.Grant.ElementsAs(ctx, &grants, false)...)
		if diags.HasError() {
			return nil, diags
		}
	}
	input := iw.ObjectSharingInput{OrgAccess: plan.OrgAccess.ValueString(), Grants: []iw.ObjectSharingGrantInput{}}
	for _, g := range grants {
		input.Grants = append(input.Grants, iw.ObjectSharingGrantInput{
			PrincipalKind: g.PrincipalKind.ValueString(),
			PrincipalID:   g.PrincipalID.ValueString(),
			Level:         g.Level.ValueString(),
		})
	}
	out, err := r.client.PutObjectSharing(ctx, plan.ObjectType.ValueString(), plan.ObjectID.ValueString(), input)
	if err != nil {
		diags.AddError("Unable to save sharing", err.Error())
		return nil, diags
	}
	return out, diags
}

func (r *objectSharingResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan objectSharingModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	out, diags := r.put(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	state, diags := objectSharingStateFrom(ctx, out)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *objectSharingResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state objectSharingModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetObjectSharing(ctx, state.ObjectType.ValueString(), state.ObjectID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read sharing", err.Error())
		return
	}
	next, diags := objectSharingStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *objectSharingResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan objectSharingModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	out, diags := r.put(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	next, diags := objectSharingStateFrom(ctx, out)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete resets the object to the default sharing rather than deleting the
// object: the resource manages who can reach the report, not the report.
func (r *objectSharingResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state objectSharingModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.ResetObjectSharing(ctx, state.ObjectType.ValueString(), state.ObjectID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to reset sharing", err.Error())
	}
}

// ImportState takes `<object_type>/<object_id>`.
func (r *objectSharingResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, err := splitImportID(req.ID, 2, "<object_type>/<object_id>")
	if err != nil {
		resp.Diagnostics.AddError("Invalid import ID", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("object_type"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("object_id"), parts[1])...)
}

func objectSharingStateFrom(ctx context.Context, remote *iw.ObjectSharing) (objectSharingModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	grants := []objectSharingGrantModel{}
	for _, g := range remote.Grants {
		// A report creator's ownership is implied, never configured.
		if g.Implicit {
			continue
		}
		grants = append(grants, objectSharingGrantModel{
			PrincipalKind: types.StringValue(g.PrincipalKind),
			PrincipalID:   types.StringValue(g.PrincipalID),
			Level:         types.StringValue(g.Level),
		})
	}
	set, d := types.SetValueFrom(ctx, types.ObjectType{AttrTypes: objectSharingGrantAttrTypes}, grants)
	diags.Append(d...)
	return objectSharingModel{
		ID:         types.StringValue(remote.ObjectType + "/" + remote.ObjectID),
		ObjectType: types.StringValue(remote.ObjectType),
		ObjectID:   types.StringValue(remote.ObjectID),
		OrgAccess:  types.StringValue(remote.OrgAccess),
		Grant:      set,
	}, diags
}
