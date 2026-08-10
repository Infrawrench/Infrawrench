package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*tagPolicyResource)(nil)
	_ resource.ResourceWithConfigure   = (*tagPolicyResource)(nil)
	_ resource.ResourceWithImportState = (*tagPolicyResource)(nil)
)

// NewTagPolicyResource constructs the infrawrench_tag_policy resource.
func NewTagPolicyResource() resource.Resource { return &tagPolicyResource{} }

type tagPolicyResource struct{ client *iw.Client }

type tagPolicyRequiredTagModel struct {
	Key           types.String `tfsdk:"key"`
	AllowedValues types.List   `tfsdk:"allowed_values"`
}

var tagPolicyRequiredTagAttrTypes = map[string]attr.Type{
	"key":            types.StringType,
	"allowed_values": types.ListType{ElemType: types.StringType},
}

var tagPolicyRequiredTagObjectType = types.ObjectType{AttrTypes: tagPolicyRequiredTagAttrTypes}

type tagPolicyResourceModel struct {
	ID              types.String `tfsdk:"id"`
	EnforceOnCreate types.Bool   `tfsdk:"enforce_on_create"`
	RequiredTag     types.List   `tfsdk:"required_tag"`
}

func (r *tagPolicyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_tag_policy"
}

func (r *tagPolicyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The organization's tag policy: the tag keys every resource is expected to carry.\n\n" +
			"This is a singleton. The organization always has exactly one policy — there is no " +
			"route to create a second one and none to delete the one that exists — so declaring " +
			"this resource adopts the existing policy and overwrites it, and only one instance " +
			"should exist in a configuration. Two instances would fight, each apply clobbering " +
			"the other.\n\n" +
			"Because the policy cannot be deleted, `terraform destroy` cannot remove it either. " +
			"Destroying this resource resets the policy to empty and unenforced instead; see the " +
			"note on `enforce_on_create`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. The policy is a singleton with no id of its own, so " +
					"the organization it belongs to is the only sensible identity — and it is also the " +
					"id to hand `terraform import`.",
			},
			"enforce_on_create": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Reject resource creation that would violate the policy. When false the " +
					"policy is still evaluated and still reported as compliance, it simply does not block.",
			},
		},
		Blocks: map[string]schema.Block{
			"required_tag": schema.ListNestedBlock{
				MarkdownDescription: "Tag keys every resource must carry, at most 32 of them.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"key": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Tag key, 1–128 characters.",
						},
						"allowed_values": schema.ListAttribute{
							Optional:    true,
							ElementType: types.StringType,
							MarkdownDescription: "Restrict the key to this set of values, at most 64 of them and each " +
								"1–256 characters. Omit it to accept any non-empty value.",
						},
					},
				},
				Validators: []validator.List{listvalidator.SizeAtMost(32)},
			},
		},
	}
}

func (r *tagPolicyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// Create adopts the organization's existing policy.
//
// There is no POST route, because the policy already exists for every
// organization from the moment it is created. So "creating" this resource is a
// PUT that overwrites whatever the policy currently says — the same call Update
// makes. Anything configured in the UI beforehand is replaced, which is the
// usual Terraform bargain and worth knowing before the first apply.
func (r *tagPolicyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan tagPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := tagPolicyInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.PutTagPolicy(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to write tag policy", err.Error())
		return
	}

	state, diags := tagPolicyStateFrom(ctx, created, plan, r.client.OrgID())
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes the singleton.
//
// This is the one resource in the provider that does not treat a 404 as "gone,
// recreate it". A singleton cannot be deleted, so there is no state of the world
// in which the policy legitimately disappears; a 404 here means the token lost
// access to the organization, the org itself is gone, or the route moved. Any of
// those is a real problem, and silently removing the resource from state would
// hide it behind a plan that cheerfully offers to "create" the policy again.
func (r *tagPolicyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state tagPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetTagPolicy(ctx)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.Diagnostics.AddError(
				"Tag policy not found",
				"The tag policy is an organization singleton and cannot be deleted, so a 404 from "+
					"this route means the organization is unreachable rather than that the policy is "+
					"gone. Check that the configured organization still exists and that the API token "+
					"still has access to it.\n\n"+err.Error())
			return
		}
		resp.Diagnostics.AddError("Unable to read tag policy", err.Error())
		return
	}

	refreshed, diags := tagPolicyStateFrom(ctx, remote, state, r.client.OrgID())
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *tagPolicyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan tagPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := tagPolicyInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.PutTagPolicy(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to update tag policy", err.Error())
		return
	}

	next, diags := tagPolicyStateFrom(ctx, updated, plan, r.client.OrgID())
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete resets the policy rather than deleting it.
//
// The API has no DELETE for the singleton, so the honest choices are to do
// nothing or to neutralise the policy. Doing nothing would leave an enforcing
// policy behind after `terraform destroy` removed the resource that documents
// it — a rule nobody owns, still rejecting resource creation, with no config
// left to explain why. So this writes the empty, unenforced policy back: no
// required tags and enforcement off. The row still exists, as it must, but it
// no longer does anything.
func (r *tagPolicyResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutTagPolicy(ctx, iw.TagPolicy{
		RequiredTags:    []iw.RequiredTag{},
		EnforceOnCreate: false,
	}); err != nil {
		resp.Diagnostics.AddError("Unable to reset tag policy", err.Error())
	}
}

// ImportState accepts any id.
//
// The singleton is addressed by nothing but the credentials the provider is
// already configured with, so there is no id to look anything up by. Whatever
// the practitioner types is stored and then immediately corrected to the
// organization id by the Read that follows the import.
func (r *tagPolicyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func tagPolicyInputFrom(ctx context.Context, model tagPolicyResourceModel) (iw.TagPolicy, diag.Diagnostics) {
	var diags diag.Diagnostics

	required := []iw.RequiredTag{}
	if !model.RequiredTag.IsNull() && !model.RequiredTag.IsUnknown() {
		var rows []tagPolicyRequiredTagModel
		diags.Append(model.RequiredTag.ElementsAs(ctx, &rows, false)...)
		if diags.HasError() {
			return iw.TagPolicy{}, diags
		}
		for _, row := range rows {
			values, d := stringSlice(ctx, row.AllowedValues)
			diags.Append(d...)
			if diags.HasError() {
				return iw.TagPolicy{}, diags
			}
			required = append(required, iw.RequiredTag{
				Key:           row.Key.ValueString(),
				AllowedValues: values,
			})
		}
	}

	return iw.TagPolicy{
		RequiredTags:    required,
		EnforceOnCreate: model.EnforceOnCreate.ValueBool(),
	}, diags
}

// tagPolicyStateFrom maps the server policy into Terraform state.
//
// It takes the organization id as an argument rather than reading it off the
// prior model, because on the first apply the prior model is the plan and the
// plan's id is still unknown. AllowedValues goes back through optionalStringList
// so that a key with no value restriction stays null: the wire field is
// omitempty, so an unrestricted key comes back with the key absent, and mapping
// that to `[]` would show as drift against a config that simply omitted it.
func tagPolicyStateFrom(ctx context.Context, remote *iw.TagPolicy, _ tagPolicyResourceModel, orgID string) (tagPolicyResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	rows := make([]tagPolicyRequiredTagModel, 0, len(remote.RequiredTags))
	for _, t := range remote.RequiredTags {
		values, d := optionalStringList(ctx, t.AllowedValues)
		diags.Append(d...)
		if diags.HasError() {
			return tagPolicyResourceModel{}, diags
		}
		rows = append(rows, tagPolicyRequiredTagModel{
			Key:           types.StringValue(t.Key),
			AllowedValues: values,
		})
	}
	required, d := types.ListValueFrom(ctx, tagPolicyRequiredTagObjectType, rows)
	diags.Append(d...)

	return tagPolicyResourceModel{
		ID:              types.StringValue(orgID),
		EnforceOnCreate: types.BoolValue(remote.EnforceOnCreate),
		RequiredTag:     required,
	}, diags
}
