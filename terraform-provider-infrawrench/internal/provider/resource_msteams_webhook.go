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
	_ resource.Resource                = (*msTeamsWebhookResource)(nil)
	_ resource.ResourceWithConfigure   = (*msTeamsWebhookResource)(nil)
	_ resource.ResourceWithImportState = (*msTeamsWebhookResource)(nil)
)

// NewMSTeamsWebhookResource constructs the infrawrench_msteams_webhook resource.
func NewMSTeamsWebhookResource() resource.Resource { return &msTeamsWebhookResource{} }

type msTeamsWebhookResource struct{ client *iw.Client }

type msTeamsWebhookResourceModel struct {
	ID      types.String `tfsdk:"id"`
	Label   types.String `tfsdk:"label"`
	URL     types.String `tfsdk:"url"`
	URLHint types.String `tfsdk:"url_hint"`
}

func (r *msTeamsWebhookResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_msteams_webhook"
}

func (r *msTeamsWebhookResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A Microsoft Teams webhook registered as an alert destination.\n\n" +
			"Registering it makes it available; what arrives there is decided by " +
			"`infrawrench_alert_routing`.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Infrawrench's id for this webhook. `terraform import` works, but the " +
				"stored URL is not recoverable — supply it in configuration afterwards."),
			"label": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Display name for the destination, e.g. `#alerts`. The only mutable " +
					"attribute.",
			},
			"url": schema.StringAttribute{
				Required:  true,
				Sensitive: true,
				MarkdownDescription: "The webhook URL from a Teams **Workflows** automation.\n\n" +
					"Must be https and on a Microsoft-operated host — `*.api.powerautomate.com`, " +
					"`*.api.powerplatform.com`, `*.logic.azure.com`, `*.flow.microsoft.com`, or a legacy " +
					"`*.webhook.office.com` connector. Anything else is refused, since a webhook URL is a " +
					"bearer credential and posting alerts to an arbitrary host is not a thing to allow by " +
					"accident.\n\n" +
					"Write-only: no route returns it, so the provider cannot detect drift on it and changing " +
					"it replaces the registration.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},

			"url_hint": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "Non-secret hint at the stored URL — its host and last four characters. " +
					"The only readable signal that the stored credential is the one you think it is.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *msTeamsWebhookResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *msTeamsWebhookResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan msTeamsWebhookResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateMSTeamsWebhook(ctx, iw.MSTeamsWebhookCreate{
		Label: plan.Label.ValueString(),
		URL:   plan.URL.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to register Teams webhook", err.Error())
		return
	}

	state := msTeamsWebhookStateFrom(created, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *msTeamsWebhookResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state msTeamsWebhookResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetMSTeamsWebhook(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read Teams webhook", err.Error())
		return
	}

	refreshed := msTeamsWebhookStateFrom(remote, state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *msTeamsWebhookResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan msTeamsWebhookResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state msTeamsWebhookResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateMSTeamsWebhook(ctx, state.ID.ValueString(), iw.MSTeamsWebhookUpdate{
		Label: plan.Label.ValueString(),
	})
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Teams webhook no longer exists",
				"It was removed outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update Teams webhook", err.Error())
		return
	}

	next := msTeamsWebhookStateFrom(updated, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *msTeamsWebhookResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state msTeamsWebhookResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteMSTeamsWebhook(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete Teams webhook", err.Error())
	}
}

func (r *msTeamsWebhookResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// msTeamsWebhookStateFrom carries the URL forward from the prior model: it is
// write-only, and refreshing must not drop it out of state.
func msTeamsWebhookStateFrom(remote *iw.MSTeamsWebhook, prior msTeamsWebhookResourceModel) msTeamsWebhookResourceModel {
	return msTeamsWebhookResourceModel{
		ID:      types.StringValue(remote.ID),
		Label:   types.StringValue(remote.Label),
		URL:     prior.URL,
		URLHint: types.StringValue(remote.URLHint),
	}
}
