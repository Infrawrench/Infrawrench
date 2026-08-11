package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*slackChannelResource)(nil)
	_ resource.ResourceWithConfigure   = (*slackChannelResource)(nil)
	_ resource.ResourceWithImportState = (*slackChannelResource)(nil)
)

// NewSlackChannelResource constructs the infrawrench_slack_channel resource.
func NewSlackChannelResource() resource.Resource { return &slackChannelResource{} }

type slackChannelResource struct{ client *iw.Client }

type slackChannelResourceModel struct {
	ID             types.String `tfsdk:"id"`
	InstallationID types.String `tfsdk:"installation_id"`
	ChannelID      types.String `tfsdk:"channel_id"`
	ChannelName    types.String `tfsdk:"channel_name"`
	IsPrivate      types.Bool   `tfsdk:"is_private"`
}

func (r *slackChannelResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_slack_channel"
}

func (r *slackChannelResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A Slack channel registered as an alert destination.\n\n" +
			"The **workspace connection** is not managed here: installing the Slack app is an OAuth flow " +
			"a Terraform provider cannot perform. Connect the workspace once in the app, then read its " +
			"`installation_id` with `data.infrawrench_slack_installations`.\n\n" +
			"Registering a channel makes it available as a destination; it does not route anything to it. " +
			"What arrives here is decided by `infrawrench_alert_routing`.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Infrawrench's id for this channel registration — this is the id " +
				"`infrawrench_alert_routing` and `infrawrench_cost_report_notification` reference, not the " +
				"Slack `C…` id."),
			"installation_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The connected Slack workspace, from " +
					"`data.infrawrench_slack_installations`. Fixed at creation: a channel belongs to the " +
					"workspace it lives in.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"channel_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Slack's own channel id, `C…` for a public channel or `G…` for a private " +
					"one. Fixed at creation — pointing the registration at a different channel is a different " +
					"destination, not an edit.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"channel_name": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Channel name without the leading `#`. The only mutable field: it is a " +
					"label, and renaming the channel in Slack does not update it here.",
			},
			"is_private": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "Whether the channel is private. Fixed at creation; the update route does " +
					"not carry it.\n\n" +
					"The bot must already be a member of a private channel — Slack does not let an app join " +
					"one — so invite it before applying, or deliveries fail with `not_in_channel`.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.RequiresReplace()},
			},
		},
	}
}

func (r *slackChannelResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *slackChannelResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan slackChannelResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateSlackChannel(ctx, iw.SlackChannelCreate{
		InstallationID: plan.InstallationID.ValueString(),
		ChannelID:      plan.ChannelID.ValueString(),
		ChannelName:    plan.ChannelName.ValueString(),
		IsPrivate:      boolPtr(plan.IsPrivate),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to register Slack channel", err.Error())
		return
	}

	state := slackChannelStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *slackChannelResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state slackChannelResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetSlackChannel(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read Slack channel", err.Error())
		return
	}

	refreshed := slackChannelStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *slackChannelResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan slackChannelResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state slackChannelResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateSlackChannel(ctx, state.ID.ValueString(), iw.SlackChannelUpdate{
		ChannelName: plan.ChannelName.ValueString(),
	})
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Slack channel registration no longer exists",
				"It was removed outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update Slack channel", err.Error())
		return
	}

	next := slackChannelStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the registration. Any alert rule still naming this channel
// stops delivering there — the rule keeps the id, and the id no longer resolves.
func (r *slackChannelResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state slackChannelResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteSlackChannel(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete Slack channel", err.Error())
	}
}

func (r *slackChannelResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func slackChannelStateFrom(remote *iw.SlackChannel) slackChannelResourceModel {
	return slackChannelResourceModel{
		ID:             types.StringValue(remote.ID),
		InstallationID: types.StringValue(remote.InstallationID),
		ChannelID:      types.StringValue(remote.ChannelID),
		ChannelName:    types.StringValue(remote.ChannelName),
		IsPrivate:      types.BoolValue(remote.IsPrivate),
	}
}
