package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*eventSubscriptionResource)(nil)
	_ resource.ResourceWithConfigure      = (*eventSubscriptionResource)(nil)
	_ resource.ResourceWithImportState    = (*eventSubscriptionResource)(nil)
	_ resource.ResourceWithValidateConfig = (*eventSubscriptionResource)(nil)
	_ resource.ResourceWithModifyPlan     = (*eventSubscriptionResource)(nil)
)

// NewEventSubscriptionResource constructs the infrawrench_event_subscription resource.
func NewEventSubscriptionResource() resource.Resource { return &eventSubscriptionResource{} }

type eventSubscriptionResource struct{ client *iw.Client }

type eventSubscriptionResourceModel struct {
	ID                    types.String `tfsdk:"id"`
	Name                  types.String `tfsdk:"name"`
	Enabled               types.Bool   `tfsdk:"enabled"`
	WebhookURL            types.String `tfsdk:"webhook_url"`
	PublishAccountID      types.String `tfsdk:"publish_account_id"`
	PublishResourceTypeID types.String `tfsdk:"publish_resource_type_id"`
	PublishResourceID     types.String `tfsdk:"publish_resource_id"`
	EventTypes            types.Set    `tfsdk:"event_types"`
	MinSeverity           types.String `tfsdk:"min_severity"`
	AccountIDs            types.Set    `tfsdk:"account_ids"`
	Environments          types.Set    `tfsdk:"environments"`
	SecretVersion         types.Int64  `tfsdk:"secret_version"`
	SigningSecret         types.String `tfsdk:"signing_secret"`
	SecretHint            types.String `tfsdk:"secret_hint"`
	DestinationLabel      types.String `tfsdk:"destination_label"`
	DisabledReason        types.String `tfsdk:"disabled_reason"`
}

func (r *eventSubscriptionResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_event_subscription"
}

// requiresReplaceOnKindFlip replaces the subscription when an attribute that
// only one destination kind uses appears or disappears: the API refuses to
// switch a subscription between webhook and publish, because the signing
// secret's lifecycle belongs to the kind.
var requiresReplaceOnKindFlip = stringplanmodifier.RequiresReplaceIf(
	func(_ context.Context, req planmodifier.StringRequest, resp *stringplanmodifier.RequiresReplaceIfFuncResponse) {
		resp.RequiresReplace = req.StateValue.IsNull() != req.PlanValue.IsNull()
	},
	"Switching between a webhook and a publish destination replaces the subscription.",
	"Switching between a webhook and a publish destination replaces the subscription.",
)

func (r *eventSubscriptionResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An event subscription: Infrawrench's own events (cost anomalies, budget " +
			"thresholds, critical and high posture findings, drift, declared incidents, just-in-time access, " +
			"SLO burn, metric alerts, account sync failures) delivered as JSON to a signed HTTPS webhook, or " +
			"published to an AWS EventBridge rule's bus or a GCP Pub/Sub topic in a connected account.\n\n" +
			"Set exactly one destination: `webhook_url`, or all three `publish_*` attributes. Switching " +
			"between the two replaces the subscription.\n\n" +
			"**The webhook signing secret lands in your Terraform state.** The API returns it once, at " +
			"creation and on a reroll, and `signing_secret` keeps it so your receiver's configuration can " +
			"reference it. Treat state accordingly. Bump `secret_version` to reroll: the previous secret keeps " +
			"signing for 24 hours.\n\n" +
			"A subscription that keeps failing for three days is turned off by the server (see " +
			"`disabled_reason`); the next apply with `enabled = true` turns it back on and clears its failure " +
			"history.\n\n" +
			"Receiving cost events (or every event, when `event_types` is empty) needs `costs:read` as well " +
			"as `org:settings:write`.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Infrawrench's id for this subscription. `terraform import` works, " +
				"but the signing secret is not recoverable; bump `secret_version` after importing to get one."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1 to 120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Whether events are delivered. Defaults to `true`.",
			},
			"webhook_url": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "An `https` URL that receives each event as a signed POST. Redirects are " +
					"not followed, and hosts in private or internal address space are refused.",
				PlanModifiers: []planmodifier.String{requiresReplaceOnKindFlip},
			},
			"publish_account_id": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "The connected account to publish through (see the `infrawrench_accounts` data source).",
				PlanModifiers:       []planmodifier.String{requiresReplaceOnKindFlip},
			},
			"publish_resource_type_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The destination's resource type: `eventbridge-rule` (AWS; events go to the " +
					"rule's bus with source `infrawrench` and the event type as `detail-type`) or `pubsub-topic` (GCP; " +
					"messages carry `eventType`, `eventVersion` and `eventId` attributes).",
				Validators:    []validator.String{oneOfValidator("eventbridge-rule", "pubsub-topic")},
				PlanModifiers: []planmodifier.String{requiresReplaceOnKindFlip},
			},
			"publish_resource_id": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "The destination resource's Infrawrench id (see the `infrawrench_resources` data source).",
				PlanModifiers:       []planmodifier.String{requiresReplaceOnKindFlip},
			},
			"event_types": schema.SetAttribute{
				ElementType: types.StringType,
				Optional:    true,
				MarkdownDescription: "Event types to receive, e.g. `cost.anomaly.detected`, `incident.declared`. " +
					"Omit or leave empty for every event, including types added later. At most 100.",
				Validators: []validator.Set{setSizeAtMost(100)},
			},
			"min_severity": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Lowest severity delivered: `info`, `warning` or `critical`. Omit for all.",
				Validators:          []validator.String{oneOfValidator("info", "warning", "critical")},
			},
			"account_ids": schema.SetAttribute{
				ElementType: types.StringType,
				Optional:    true,
				MarkdownDescription: "Only events about these accounts. An event about no single account (a " +
					"drift window spanning several, a declared incident) never matches a non-empty set. At most 100.",
				Validators: []validator.Set{setSizeAtMost(100)},
			},
			"environments": schema.SetAttribute{
				ElementType: types.StringType,
				Optional:    true,
				MarkdownDescription: "Only events whose resource carries one of these values in an `env`, " +
					"`environment` or `stage` tag (case-insensitive). An event with no environment never matches a " +
					"non-empty set. At most 100.",
				Validators: []validator.Set{setSizeAtMost(100)},
			},
			"secret_version": schema.Int64Attribute{
				Optional: true,
				MarkdownDescription: "Change this to any other number to reroll the webhook signing secret. " +
					"Has no other meaning.",
			},
			"signing_secret": schema.StringAttribute{
				Computed:  true,
				Sensitive: true,
				MarkdownDescription: "The webhook signing secret (`iwhsec_…`), for verifying the `Infrawrench-Signature` " +
					"header. Null for publish destinations and after an import.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"secret_hint": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Last four characters of the current signing secret.",
			},
			"destination_label": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Human label for the destination, as the settings page shows it.",
			},
			"disabled_reason": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Why the server turned the subscription off, when it did.",
			},
		},
	}
}

func (r *eventSubscriptionResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *eventSubscriptionResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var cfg eventSubscriptionResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	publish := []types.String{cfg.PublishAccountID, cfg.PublishResourceTypeID, cfg.PublishResourceID}
	set := 0
	for _, v := range publish {
		if !v.IsNull() {
			set++
		}
	}
	if set != 0 && set != 3 && !anyUnknown(publish) {
		resp.Diagnostics.AddError("Incomplete publish destination",
			"Set all three of publish_account_id, publish_resource_type_id and publish_resource_id.")
		return
	}
	if cfg.WebhookURL.IsNull() == (set == 0) && !cfg.WebhookURL.IsUnknown() && !anyUnknown(publish) {
		resp.Diagnostics.AddError("Exactly one destination",
			"Set either webhook_url or the three publish_* attributes, not both and not neither.")
	}
}

func anyUnknown(values []types.String) bool {
	for _, v := range values {
		if v.IsUnknown() {
			return true
		}
	}
	return false
}

// ModifyPlan marks the secret unknown when a reroll is planned, so the new
// value is not reported as an inconsistent result.
func (r *eventSubscriptionResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() {
		return
	}
	var plan, state eventSubscriptionResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if !plan.WebhookURL.IsNull() && !plan.SecretVersion.Equal(state.SecretVersion) {
		resp.Diagnostics.Append(resp.Plan.SetAttribute(ctx, path.Root("signing_secret"), types.StringUnknown())...)
	}
}

func setStrings(ctx context.Context, set types.Set) ([]string, diag.Diagnostics) {
	out := []string{}
	if set.IsNull() || set.IsUnknown() {
		return out, nil
	}
	diags := set.ElementsAs(ctx, &out, false)
	return out, diags
}

func eventSubscriptionInputFrom(ctx context.Context, m eventSubscriptionResourceModel) (iw.EventSubscriptionInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	in := iw.EventSubscriptionInput{
		Name:        m.Name.ValueString(),
		Enabled:     m.Enabled.ValueBool(),
		MinSeverity: stringPtr(m.MinSeverity),
	}
	if !m.WebhookURL.IsNull() {
		in.Destination = iw.EventDestination{Kind: "webhook", URL: m.WebhookURL.ValueString()}
	} else {
		in.Destination = iw.EventDestination{
			Kind:           "publish",
			AccountID:      m.PublishAccountID.ValueString(),
			ResourceTypeID: m.PublishResourceTypeID.ValueString(),
			ResourceID:     m.PublishResourceID.ValueString(),
		}
	}
	var d diag.Diagnostics
	in.EventTypes, d = setStrings(ctx, m.EventTypes)
	diags.Append(d...)
	in.AccountIDs, d = setStrings(ctx, m.AccountIDs)
	diags.Append(d...)
	in.Environments, d = setStrings(ctx, m.Environments)
	diags.Append(d...)
	return in, diags
}

// optionalSet keeps an omitted set null when the server echoes it as empty,
// so leaving an attribute out never plans a change.
func optionalSet(ctx context.Context, remote []string, prior types.Set) (types.Set, diag.Diagnostics) {
	if len(remote) == 0 && prior.IsNull() {
		return types.SetNull(types.StringType), nil
	}
	if remote == nil {
		remote = []string{}
	}
	return types.SetValueFrom(ctx, types.StringType, remote)
}

func eventSubscriptionStateFrom(ctx context.Context, remote *iw.EventSubscription, prior eventSubscriptionResourceModel) (eventSubscriptionResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	next := eventSubscriptionResourceModel{
		ID:                    types.StringValue(remote.ID),
		Name:                  types.StringValue(remote.Name),
		Enabled:               types.BoolValue(remote.Enabled),
		WebhookURL:            types.StringNull(),
		PublishAccountID:      types.StringNull(),
		PublishResourceTypeID: types.StringNull(),
		PublishResourceID:     types.StringNull(),
		MinSeverity:           stringValue(remote.MinSeverity),
		SecretVersion:         prior.SecretVersion,
		SigningSecret:         prior.SigningSecret,
		SecretHint:            stringValue(remote.SecretHint),
		DestinationLabel:      types.StringValue(remote.DestinationLabel),
		DisabledReason:        stringValue(remote.DisabledReason),
	}
	if next.SigningSecret.IsUnknown() {
		next.SigningSecret = types.StringNull()
	}
	if remote.Destination.Kind == "webhook" {
		next.WebhookURL = types.StringValue(remote.Destination.URL)
	} else {
		next.PublishAccountID = types.StringValue(remote.Destination.AccountID)
		next.PublishResourceTypeID = types.StringValue(remote.Destination.ResourceTypeID)
		next.PublishResourceID = types.StringValue(remote.Destination.ResourceID)
	}
	var d diag.Diagnostics
	next.EventTypes, d = optionalSet(ctx, remote.EventTypes, prior.EventTypes)
	diags.Append(d...)
	next.AccountIDs, d = optionalSet(ctx, remote.AccountIDs, prior.AccountIDs)
	diags.Append(d...)
	next.Environments, d = optionalSet(ctx, remote.Environments, prior.Environments)
	diags.Append(d...)
	return next, diags
}

func (r *eventSubscriptionResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan eventSubscriptionResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	in, diags := eventSubscriptionInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateEventSubscription(ctx, in)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create event subscription", err.Error())
		return
	}
	plan.SigningSecret = stringValue(created.Secret)
	state, diags := eventSubscriptionStateFrom(ctx, &created.Subscription, plan)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *eventSubscriptionResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state eventSubscriptionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetEventSubscription(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read event subscription", err.Error())
		return
	}
	next, diags := eventSubscriptionStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *eventSubscriptionResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state eventSubscriptionResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	in, diags := eventSubscriptionInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateEventSubscription(ctx, state.ID.ValueString(), in)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning("Event subscription no longer exists",
				"It was removed outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update event subscription", err.Error())
		return
	}
	plan.SigningSecret = state.SigningSecret
	if !plan.WebhookURL.IsNull() && !plan.SecretVersion.Equal(state.SecretVersion) {
		rerolled, err := r.client.RerollEventSubscriptionSecret(ctx, state.ID.ValueString())
		if err != nil {
			resp.Diagnostics.AddError("Unable to reroll the signing secret", err.Error())
			return
		}
		updated = &rerolled.Subscription
		plan.SigningSecret = stringValue(rerolled.Secret)
	}
	next, diags := eventSubscriptionStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *eventSubscriptionResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state eventSubscriptionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteEventSubscription(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete event subscription", err.Error())
	}
}

func (r *eventSubscriptionResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
