package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*ssoSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*ssoSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*ssoSettingsResource)(nil)
)

// NewSSOSettingsResource constructs the infrawrench_sso_settings resource.
func NewSSOSettingsResource() resource.Resource { return &ssoSettingsResource{} }

type ssoSettingsResource struct{ client *iw.Client }

type ssoSettingsResourceModel struct {
	ID                  types.String `tfsdk:"id"`
	EnforceSSO          types.Bool   `tfsdk:"enforce_sso"`
	BreakGlassUserIDs   types.List   `tfsdk:"break_glass_user_ids"`
	ProvisioningEnabled types.Bool   `tfsdk:"provisioning_enabled"`
	DefaultRoleID       types.String `tfsdk:"default_role_id"`
	AutoAddSeats        types.Bool   `tfsdk:"auto_add_seats"`
}

func (r *ssoSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_sso_settings"
}

func (r *ssoSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "How members sign in to the organization through enterprise single sign-on " +
			"(SAML or OIDC through WorkOS), and how SCIM Directory Sync provisions them.\n\n" +
			"The identity provider connection, the directory and domain verification are configured by " +
			"your IT admin in the WorkOS Admin Portal, opened from **Settings → Single Sign-On**; a " +
			"provider cannot drive that flow. This resource owns what Infrawrench decides: whether SSO is " +
			"enforced, who the break-glass owners are, and whether the directory may change membership. " +
			"Creating it sets SSO up for the organization if it was not already.\n\n" +
			"Turning `enforce_sso` on is refused by the server unless a domain is verified, a connection " +
			"is active, at least one break-glass owner is listed, and the credential applying it would " +
			"still be let in. With an API key that means its owner must be a break-glass owner (or sit " +
			"outside the enforced domains). The key needs the `org:settings:write` scope, and the " +
			"organization must be on the paid plan.\n\n" +
			"An organization **singleton** with no DELETE on the route: `terraform destroy` leaves the " +
			"settings exactly as configured. Removing this resource does not quietly switch enforcement " +
			"off, which is the safer default for a sign-in control.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("Single sign-on"),
			"enforce_sso": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Require members whose email is in a verified domain to sign in through the " +
					"organization's identity provider. Existing non-SSO sessions stop working for them in this " +
					"organization. API keys are not affected.",
			},
			"break_glass_user_ids": schema.ListAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "User ids of owners who may still sign in without SSO when the identity " +
					"provider is down. Each must be a current owner; at most 5. At least one is required " +
					"while `enforce_sso` is true. Every bypass is audit-logged.",
				Validators: []validatorList{sizeAtMost(5)},
			},
			"provisioning_enabled": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Let Directory Sync add and remove members. Off, the directory is only " +
					"observed, so mappings can be previewed before it changes anything.",
			},
			"default_role_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Role for provisioned members none of whose groups is mapped. Omit for the " +
					"system member role. Never the owner role.",
			},
			"auto_add_seats": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Buy a seat when provisioning needs one. Off, members past the seat count " +
					"wait instead of growing the bill. Turning it on also needs `billing:write`.",
			},
		},
	}
}

func (r *ssoSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *ssoSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan ssoSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.SetUpSSO(ctx); err != nil {
		resp.Diagnostics.AddError("Unable to set up single sign-on", err.Error())
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *ssoSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state ssoSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	status, err := r.client.GetSSOStatus(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read single sign-on settings", err.Error())
		return
	}
	if !status.Configured || status.Settings == nil {
		resp.State.RemoveResource(ctx)
		return
	}
	refreshed, diags := ssoSettingsStateFrom(ctx, r.client.OrgID(), status.Settings)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *ssoSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan ssoSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op. See the schema description.
func (r *ssoSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *ssoSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *ssoSettingsResource) write(ctx context.Context, plan ssoSettingsResourceModel, diags *diagnostics, state *tfState) {
	breakGlass, d := stringSlice(ctx, plan.BreakGlassUserIDs)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	saved, err := r.client.PutSSOSettings(ctx, iw.SSOSettingsInput{
		EnforceSSO:          boolPtr(plan.EnforceSSO),
		BreakGlassUserIDs:   breakGlass,
		ProvisioningEnabled: boolPtr(plan.ProvisioningEnabled),
		DefaultRoleID:       stringPtr(plan.DefaultRoleID),
		AutoAddSeats:        boolPtr(plan.AutoAddSeats),
	})
	if err != nil {
		diags.AddError("Unable to write single sign-on settings", err.Error())
		return
	}
	next, d := ssoSettingsStateFrom(ctx, r.client.OrgID(), saved)
	diags.Append(d...)
	diags.Append(state.Set(ctx, &next)...)
}

func ssoSettingsStateFrom(ctx context.Context, orgID string, remote *iw.SSOSettings) (ssoSettingsResourceModel, diagnostics) {
	ids := remote.BreakGlassUserIDs
	if ids == nil {
		ids = []string{}
	}
	list, d := stringList(ctx, ids)
	return ssoSettingsResourceModel{
		ID:                  types.StringValue(orgID),
		EnforceSSO:          types.BoolValue(remote.EnforceSSO),
		BreakGlassUserIDs:   list,
		ProvisioningEnabled: types.BoolValue(remote.ProvisioningEnabled),
		DefaultRoleID:       stringValue(remote.DefaultRoleID),
		AutoAddSeats:        types.BoolValue(remote.AutoAddSeats),
	}, d
}
