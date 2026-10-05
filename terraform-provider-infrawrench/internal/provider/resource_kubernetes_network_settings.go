package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
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
	_ resource.Resource                = (*kubernetesNetworkSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*kubernetesNetworkSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*kubernetesNetworkSettingsResource)(nil)
)

// NewKubernetesNetworkSettingsResource constructs the
// infrawrench_kubernetes_network_settings resource.
func NewKubernetesNetworkSettingsResource() resource.Resource {
	return &kubernetesNetworkSettingsResource{}
}

type kubernetesNetworkSettingsResource struct{ client *iw.Client }

type kubernetesNetworkSettingsModel struct {
	ID          types.String `tfsdk:"id"`
	AccountID   types.String `tfsdk:"account_id"`
	BilledQuery types.String `tfsdk:"billed_query"`
}

func (r *kubernetesNetworkSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_kubernetes_network_settings"
}

func (r *kubernetesNetworkSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Which billed cost rows are one Kubernetes cluster's data transfer, so Kubernetes " +
			"network costs can split that real money across the cluster's namespaces and workloads instead of " +
			"showing list-price estimates.\n\n" +
			"A cluster's pod traffic is billed to the cloud account that owns its nodes, on a line whose shape " +
			"differs by provider, so the source is a cost query you write rather than a service name Infrawrench " +
			"guesses. The money is apportioned day by day in proportion to each workload's list-priced traffic " +
			"and never adds up to more than was billed; the rest is reported as unallocated.\n\n" +
			"One per Kubernetes account. Destroying the resource clears the billed source, and the report goes " +
			"back to list-price estimates.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The Kubernetes account id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"account_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The Kubernetes account these settings belong to, e.g. " +
					"`infrawrench_account.cluster.id`. Changing it replaces the resource.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"billed_query": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Cost query language text selecting the cluster's billed data transfer, " +
					"for example `account = 'acc_123' AND service = 'AWS Data Transfer'`. 1–4000 characters, and " +
					"it must narrow the spend: a query that matches the whole bill is refused rather than " +
					"apportioning every dollar across one cluster.",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 4000)},
			},
		},
	}
}

func (r *kubernetesNetworkSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *kubernetesNetworkSettingsResource) write(ctx context.Context, plan kubernetesNetworkSettingsModel, diags *diagnostics, state *tfState) {
	query := plan.BilledQuery.ValueString()
	saved, err := r.client.PutKubernetesNetworkSettings(ctx, plan.AccountID.ValueString(), iw.KubernetesNetworkSettingsInput{
		BilledQuery: &query,
	})
	if err != nil {
		diags.AddError("Unable to write Kubernetes network settings", err.Error())
		return
	}
	next := kubernetesNetworkSettingsStateFrom(saved)
	diags.Append(state.Set(ctx, &next)...)
}

func (r *kubernetesNetworkSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan kubernetesNetworkSettingsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *kubernetesNetworkSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state kubernetesNetworkSettingsModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetKubernetesNetworkSettings(ctx, state.AccountID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read Kubernetes network settings", err.Error())
		return
	}
	// Cleared out of band: the settings Terraform manages no longer exist.
	if remote.BilledQuery == nil {
		resp.State.RemoveResource(ctx)
		return
	}
	next := kubernetesNetworkSettingsStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *kubernetesNetworkSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan kubernetesNetworkSettingsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete clears the billed source. The account itself is not this resource's
// to remove, and a missing account means there is nothing left to clear.
func (r *kubernetesNetworkSettingsResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state kubernetesNetworkSettingsModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if _, err := r.client.PutKubernetesNetworkSettings(ctx, state.AccountID.ValueString(), iw.KubernetesNetworkSettingsInput{}); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to clear Kubernetes network settings", err.Error())
	}
}

// ImportState takes the Kubernetes account id.
func (r *kubernetesNetworkSettingsResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("account_id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}

func kubernetesNetworkSettingsStateFrom(remote *iw.KubernetesNetworkSettings) kubernetesNetworkSettingsModel {
	query := types.StringNull()
	if remote.BilledQuery != nil {
		query = types.StringValue(*remote.BilledQuery)
	}
	return kubernetesNetworkSettingsModel{
		ID:          types.StringValue(remote.AccountID),
		AccountID:   types.StringValue(remote.AccountID),
		BilledQuery: query,
	}
}
