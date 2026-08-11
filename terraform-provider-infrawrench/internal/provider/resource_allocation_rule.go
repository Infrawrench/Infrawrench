package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*allocationRuleResource)(nil)
	_ resource.ResourceWithConfigure   = (*allocationRuleResource)(nil)
	_ resource.ResourceWithImportState = (*allocationRuleResource)(nil)
)

// NewAllocationRuleResource constructs the infrawrench_allocation_rule resource.
func NewAllocationRuleResource() resource.Resource { return &allocationRuleResource{} }

type allocationRuleResource struct{ client *iw.Client }

type allocationRuleMatchModel struct {
	TagKey    types.String `tfsdk:"tag_key"`
	TagValue  types.String `tfsdk:"tag_value"`
	AccountID types.String `tfsdk:"account_id"`
	PluginID  types.String `tfsdk:"plugin_id"`
	Service   types.String `tfsdk:"service"`
}

var allocationRuleMatchAttrTypes = map[string]attr.Type{
	"tag_key":    types.StringType,
	"tag_value":  types.StringType,
	"account_id": types.StringType,
	"plugin_id":  types.StringType,
	"service":    types.StringType,
}

type allocationRuleResourceModel struct {
	ID           types.String `tfsdk:"id"`
	CostCentreID types.String `tfsdk:"cost_centre_id"`
	Priority     types.Int64  `tfsdk:"priority"`
	Match        types.Object `tfsdk:"match"`
}

func (r *allocationRuleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_allocation_rule"
}

func (r *allocationRuleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A rule that routes matching spend to an `infrawrench_cost_centre`.\n\n" +
			"Allocation is computed at query time from the whole rule set, so adding, reordering " +
			"or deleting a rule restates every historical report immediately — nothing is written " +
			"back onto the stored cost rows.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned rule id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"cost_centre_id": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Cost centre this rule allocates matched spend to.",
			},
			"priority": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Evaluation order, 0–100000. The lower priority evaluates first and the " +
					"first match wins, so a row allocated by a rule is never reconsidered by a later one. " +
					"Priorities are not unique-constrained: two rules may share one, and which of them " +
					"wins is then unspecified, so give rules you care about distinct priorities.",
				Validators: []validatorInt64{between(0, 100000)},
			},
		},
		Blocks: map[string]schema.Block{
			"match": schema.SingleNestedBlock{
				MarkdownDescription: "Conditions a cost row must meet. Whichever fields are set are ANDed " +
					"together, and an empty block matches everything — which is a legitimate catch-all " +
					"when paired with the lowest priority in the set.",
				Attributes: map[string]schema.Attribute{
					"tag_key": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Match rows carrying this tag key. On its own it matches any value; " +
							"pair it with `tag_value` to pin the value.",
					},
					"tag_value": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Value the `tag_key` tag must hold. Requires `tag_key`.",
						Validators: []validator.String{
							stringvalidator.AlsoRequires(path.MatchRelative().AtParent().AtName("tag_key")),
						},
					},
					"account_id": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Match spend from one connected account. See the `infrawrench_accounts` data source.",
					},
					"plugin_id": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Match spend from one provider plugin. See the `infrawrench_plugins` data source.",
					},
					"service": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Match one provider service name, as it appears in the cost data.",
					},
				},
			},
		},
	}
}

func (r *allocationRuleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *allocationRuleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan allocationRuleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := allocationRuleInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateAllocationRule(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create allocation rule", err.Error())
		return
	}

	state, diags := allocationRuleStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes one rule out of the org's flat listing.
//
// There is no single-GET route for a rule, so iw.GetAllocationRule fetches the
// list and filters client-side, synthesising the 404 when the id is absent. The
// synthesised error satisfies iw.IsNotFound like any other, which is what lets a
// rule deleted outside Terraform land as "needs recreating" instead of as an
// opaque refresh failure.
func (r *allocationRuleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state allocationRuleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAllocationRule(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read allocation rule", err.Error())
		return
	}

	refreshed, diags := allocationRuleStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *allocationRuleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan allocationRuleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state allocationRuleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := allocationRuleInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateAllocationRule(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Allocation rule no longer exists",
				"The allocation rule was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update allocation rule", err.Error())
		return
	}

	next, diags := allocationRuleStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *allocationRuleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state allocationRuleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteAllocationRule(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete allocation rule", err.Error())
	}
}

func (r *allocationRuleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// allocationRuleInputFrom maps Terraform configuration onto the POST/PUT body.
//
// A missing `match` block reaches us as a null object and an unresolved one as
// unknown; both become the zero iw.AllocationRuleMatch, whose fields are all
// omitempty and therefore marshal to `{}`. That is the catch-all the server
// documents, so the omitted block and the empty block mean the same thing.
func allocationRuleInputFrom(ctx context.Context, model allocationRuleResourceModel) (iw.AllocationRuleInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	match := iw.AllocationRuleMatch{}
	if !model.Match.IsNull() && !model.Match.IsUnknown() {
		var block allocationRuleMatchModel
		diags.Append(model.Match.As(ctx, &block, basetypes.ObjectAsOptions{
			UnhandledNullAsEmpty:    true,
			UnhandledUnknownAsEmpty: true,
		})...)
		if diags.HasError() {
			return iw.AllocationRuleInput{}, diags
		}
		match = iw.AllocationRuleMatch{
			TagKey:    stringPtr(block.TagKey),
			TagValue:  stringPtr(block.TagValue),
			AccountID: stringPtr(block.AccountID),
			PluginID:  stringPtr(block.PluginID),
			Service:   stringPtr(block.Service),
		}
	}

	return iw.AllocationRuleInput{
		CostCentreID: model.CostCentreID.ValueString(),
		Priority:     model.Priority.ValueInt64(),
		Match:        match,
	}, diags
}

// allocationRuleStateFrom maps a server rule into Terraform state.
//
// The `match` block is a SingleNestedBlock, so an omitted block plans as a null
// object rather than as an object full of nulls — and the two are different
// values as far as Terraform's "inconsistent result after apply" check is
// concerned, even though they mean the same thing to the API. When the server
// echoes an entirely empty match we therefore keep whichever shape `prior` had,
// and only build a fresh object when there is something in the match to show.
func allocationRuleStateFrom(ctx context.Context, remote *iw.AllocationRule, prior allocationRuleResourceModel) (allocationRuleResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	match := prior.Match
	if remote.Match != (iw.AllocationRuleMatch{}) || prior.Match.IsUnknown() {
		obj, d := types.ObjectValueFrom(ctx, allocationRuleMatchAttrTypes, allocationRuleMatchModel{
			TagKey:    stringValue(remote.Match.TagKey),
			TagValue:  stringValue(remote.Match.TagValue),
			AccountID: stringValue(remote.Match.AccountID),
			PluginID:  stringValue(remote.Match.PluginID),
			Service:   stringValue(remote.Match.Service),
		})
		diags.Append(d...)
		if diags.HasError() {
			return allocationRuleResourceModel{}, diags
		}
		match = obj
	}

	return allocationRuleResourceModel{
		ID:           types.StringValue(remote.ID),
		CostCentreID: types.StringValue(remote.CostCentreID),
		Priority:     types.Int64Value(remote.Priority),
		Match:        match,
	}, diags
}
