package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*pagingProviderSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*pagingProviderSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*pagingProviderSettingsResource)(nil)
)

// NewPagingProviderSettingsResource constructs the
// infrawrench_paging_provider_settings resource.
func NewPagingProviderSettingsResource() resource.Resource {
	return &pagingProviderSettingsResource{}
}

type pagingProviderSettingsResource struct{ client *iw.Client }

type pagingProviderSettingsResourceModel struct {
	ID                types.String `tfsdk:"id"`
	AccountID         types.String `tfsdk:"account_id"`
	InboundEnabled    types.Bool   `tfsdk:"inbound_enabled"`
	WebhookSecret     types.String `tfsdk:"webhook_secret"`
	WebhookMode       types.String `tfsdk:"webhook_mode"`
	WebhookConfigured types.Bool   `tfsdk:"webhook_configured"`
	WebhookURL        types.String `tfsdk:"webhook_url"`
}

func (r *pagingProviderSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_paging_provider_settings"
}

func (r *pagingProviderSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Inbound settings for one paging provider account (PagerDuty, incident.io): " +
			"whether the provider's incidents are mirrored into Infrawrench, where they can be " +
			"acknowledged and resolved, and the webhook that keeps the mirror current.\n\n" +
			"Sending alerts **to** a provider needs no settings: it is an `infrawrench_alert_routing` " +
			"destination with `kind = \"paging-provider\"`. This resource is only the inbound half.\n\n" +
			"For a provider with a `managed` webhook (PagerDuty), turning `inbound_enabled` on " +
			"subscribes one through the provider's API. For a `manual` one (incident.io), add " +
			"`webhook_url` as an endpoint in the provider's dashboard and set `webhook_secret` to its " +
			"signing secret. Without a webhook, incidents are reconciled every couple of minutes.\n\n" +
			"Destroying the resource turns mirroring off, which removes a managed subscription and " +
			"forgets the mirrored incidents.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("The account id, repeated: the settings belong to the account."),
			"account_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The `id` of a connected account whose provider can page. The " +
					"settings belong to the account, so this is also the import id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"inbound_enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Mirror this account's incidents into Infrawrench.",
			},
			"webhook_secret": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "For a `manual` webhook only: the signing secret copied from the " +
					"provider's webhook endpoint. Write-only: the server never returns it, so a secret " +
					"changed outside Terraform is not detected. Removing the attribute leaves the stored " +
					"secret in place.",
			},
			"webhook_mode": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "`managed` when Infrawrench subscribes the webhook itself, `manual` " +
					"when the provider has no API for it, or null when the provider has no webhooks.",
			},
			"webhook_configured": schema.BoolAttribute{
				Computed:            true,
				MarkdownDescription: "Whether a webhook (subscribed, or a pasted secret) is in place.",
			},
			"webhook_url": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The URL a `manual` webhook must point at. Null until " +
					"`inbound_enabled` is on.",
			},
		},
	}
}

func (r *pagingProviderSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *pagingProviderSettingsResource) apply(ctx context.Context, plan pagingProviderSettingsResourceModel) (pagingProviderSettingsResourceModel, string, error) {
	in := iw.PagingProviderSettingsInput{InboundEnabled: plan.InboundEnabled.ValueBool()}
	if !plan.WebhookSecret.IsNull() && !plan.WebhookSecret.IsUnknown() {
		secret := plan.WebhookSecret.ValueString()
		in.WebhookSecret = &secret
	}
	account, warning, err := r.client.PutPagingProviderSettings(ctx, plan.AccountID.ValueString(), in)
	if err != nil {
		return plan, "", err
	}
	state := pagingProviderSettingsStateFrom(account, plan.WebhookSecret)
	if warning != nil {
		return state, *warning, nil
	}
	return state, "", nil
}

func pagingProviderSettingsStateFrom(account *iw.PagingProviderAccount, secret types.String) pagingProviderSettingsResourceModel {
	return pagingProviderSettingsResourceModel{
		ID:                types.StringValue(account.AccountID),
		AccountID:         types.StringValue(account.AccountID),
		InboundEnabled:    types.BoolValue(account.Settings.InboundEnabled),
		WebhookSecret:     secret,
		WebhookMode:       stringValue(account.WebhookMode),
		WebhookConfigured: types.BoolValue(account.Settings.WebhookConfigured),
		WebhookURL:        stringValue(account.Settings.WebhookURL),
	}
}

func (r *pagingProviderSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan pagingProviderSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	state, warning, err := r.apply(ctx, plan)
	if err != nil {
		resp.Diagnostics.AddError("Unable to configure paging provider", err.Error())
		return
	}
	if warning != "" {
		resp.Diagnostics.AddWarning("Paging provider webhook", warning)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *pagingProviderSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state pagingProviderSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	account, err := r.client.GetPagingProvider(ctx, state.AccountID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read paging provider settings", err.Error())
		return
	}
	refreshed := pagingProviderSettingsStateFrom(account, state.WebhookSecret)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *pagingProviderSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan pagingProviderSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	state, warning, err := r.apply(ctx, plan)
	if err != nil {
		resp.Diagnostics.AddError("Unable to update paging provider settings", err.Error())
		return
	}
	if warning != "" {
		resp.Diagnostics.AddWarning("Paging provider webhook", warning)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Delete turns mirroring off: the settings row itself is the account's, and
// disappears with it.
func (r *pagingProviderSettingsResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state pagingProviderSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	_, _, err := r.client.PutPagingProviderSettings(ctx, state.AccountID.ValueString(), iw.PagingProviderSettingsInput{InboundEnabled: false})
	if err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to turn off paging provider mirroring", err.Error())
	}
}

func (r *pagingProviderSettingsResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("account_id"), req.ID)...)
}
