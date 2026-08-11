package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*apiKeyResource)(nil)
	_ resource.ResourceWithConfigure   = (*apiKeyResource)(nil)
	_ resource.ResourceWithImportState = (*apiKeyResource)(nil)
)

// NewAPIKeyResource constructs the infrawrench_api_key resource.
func NewAPIKeyResource() resource.Resource { return &apiKeyResource{} }

type apiKeyResource struct{ client *iw.Client }

type apiKeyResourceModel struct {
	ID        types.String `tfsdk:"id"`
	Name      types.String `tfsdk:"name"`
	Scopes    types.Set    `tfsdk:"scopes"`
	ExpiresAt types.String `tfsdk:"expires_at"`
	Prefix    types.String `tfsdk:"prefix"`
	Key       types.String `tfsdk:"key"`
}

func (r *apiKeyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_api_key"
}

func (r *apiKeyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An Infrawrench API key (`iwk_…`).\n\n" +
			"**The key lands in your Terraform state in plaintext.** That is unavoidable: the API returns " +
			"it exactly once, at creation, and never again. Use this resource only with a state backend " +
			"you would put any other secret in — encrypted, access-controlled, not a local file in a repo — " +
			"and prefer piping `key` straight into the secret store that consumes it rather than into an " +
			"output.\n\n" +
			"Every attribute forces replacement, because the API has no update: changing a key's name or " +
			"its scopes means minting a new key and revoking the old one, and Terraform doing that visibly " +
			"in a plan is better than a diff the API would refuse.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned key id. `terraform import` works, but see `key` — an " +
				"imported key's secret is not recoverable."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "What the key is for. Shown in the key list and in the audit log.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"scopes": schema.SetAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Permissions the key carries, e.g. `costs:read`. A set, since order means " +
					"nothing. Read the catalogue with `data.infrawrench_permissions`.\n\n" +
					"Scope a key to what its job needs: an unattended key with `*` is the credential an " +
					"attacker most wants.",
				PlanModifiers: []planmodifier.Set{setplanmodifier.RequiresReplace()},
			},
			"expires_at": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "RFC 3339 timestamp the key stops working. Omit it for a key that never " +
					"expires, which is rarely what you want for something a pipeline holds.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},

			"prefix": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The key's non-secret leading segment, which is what the UI and audit log show.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"key": schema.StringAttribute{
				Computed:  true,
				Sensitive: true,
				MarkdownDescription: "The plaintext key, in the form `iwk_…`. Returned by the API **once**, at " +
					"creation.\n\n" +
					"It is therefore null on an imported or refreshed resource: nothing can recover it, and a " +
					"provider that quietly produced an empty string here would be inviting somebody to write " +
					"it into a secret store. If you need the value, replace the key.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *apiKeyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *apiKeyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan apiKeyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	scopes := []string{}
	if !plan.Scopes.IsNull() && !plan.Scopes.IsUnknown() {
		resp.Diagnostics.Append(plan.Scopes.ElementsAs(ctx, &scopes, false)...)
		if resp.Diagnostics.HasError() {
			return
		}
	}

	created, err := r.client.CreateAPIKey(ctx, iw.CreateAPIKeyRequest{
		Name:      plan.Name.ValueString(),
		Scopes:    scopes,
		ExpiresAt: stringPtr(plan.ExpiresAt),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to create API key", err.Error())
		return
	}

	// The create response carries only the id and the secret, so the rest of the
	// row — notably the prefix — comes from a read. A failure here is not fatal:
	// the key exists and its secret is in hand, and losing that to a tidy error
	// message would mean an orphaned credential nobody knows about.
	state := plan
	state.ID = types.StringValue(created.ID)
	state.Key = types.StringValue(created.Key)
	state.Prefix = types.StringNull()

	if row, err := r.client.GetAPIKey(ctx, created.ID); err == nil {
		merged, diags := apiKeyStateFrom(ctx, row, plan)
		resp.Diagnostics.Append(diags...)
		if !resp.Diagnostics.HasError() {
			merged.Key = types.StringValue(created.Key)
			state = merged
		}
	} else {
		resp.Diagnostics.AddWarning(
			"The new API key could not be read back",
			"The key was created and its secret is in state, but reading the row failed: "+err.Error()+
				"\n\nThe `prefix` attribute is empty until the next refresh.")
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes the row. A revoked key is treated as gone — see
// iw.Client.GetAPIKey, which synthesises the 404 the listing does not.
func (r *apiKeyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state apiKeyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAPIKey(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read API key", err.Error())
		return
	}

	refreshed, diags := apiKeyStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update cannot happen: every attribute forces replacement. It exists because
// the interface demands it, and says so rather than failing silently.
func (r *apiKeyResource) Update(_ context.Context, _ resource.UpdateRequest, resp *resource.UpdateResponse) {
	resp.Diagnostics.AddError(
		"API keys cannot be updated",
		"Every attribute of infrawrench_api_key forces replacement, so this should be unreachable. "+
			"Please report it to the provider developers.")
}

// Delete revokes the key. There is no DELETE route: revocation is the delete,
// and the row survives so the audit trail keeps its name and prefix.
func (r *apiKeyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state apiKeyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.RevokeAPIKey(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to revoke API key", err.Error())
	}
}

func (r *apiKeyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// apiKeyStateFrom maps a key row into state, carrying the secret forward from
// the prior state rather than inventing one — the API never returns it again.
func apiKeyStateFrom(ctx context.Context, remote *iw.APIKey, prior apiKeyResourceModel) (apiKeyResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	scopes := remote.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	set, d := types.SetValueFrom(ctx, types.StringType, scopes)
	diags.Append(d...)

	return apiKeyResourceModel{
		ID:        types.StringValue(remote.ID),
		Name:      types.StringValue(remote.Name),
		Scopes:    set,
		ExpiresAt: stringValue(remote.ExpiresAt),
		Prefix:    types.StringValue(remote.Prefix),
		Key:       prior.Key,
	}, diags
}
