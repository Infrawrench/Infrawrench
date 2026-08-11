package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*changeFreezeResource)(nil)
	_ resource.ResourceWithConfigure   = (*changeFreezeResource)(nil)
	_ resource.ResourceWithImportState = (*changeFreezeResource)(nil)
)

// NewChangeFreezeResource constructs the infrawrench_change_freeze resource.
func NewChangeFreezeResource() resource.Resource { return &changeFreezeResource{} }

type changeFreezeResource struct{ client *iw.Client }

type changeFreezeResourceModel struct {
	ID       types.String `tfsdk:"id"`
	Name     types.String `tfsdk:"name"`
	Reason   types.String `tfsdk:"reason"`
	StartsAt types.String `tfsdk:"starts_at"`
	EndsAt   types.String `tfsdk:"ends_at"`
	Active   types.Bool   `tfsdk:"active"`
}

func (r *changeFreezeResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_change_freeze"
}

func (r *changeFreezeResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A window during which writes to cloud resources are refused — the Black Friday " +
			"freeze, the week of the audit — and scheduled power transitions are skipped rather than " +
			"queued.\n\n" +
			"The natural way to use this from Terraform is a planned freeze committed ahead of time: the " +
			"window is in the repository, with a reason and a reviewer, before the week it covers.\n\n" +
			"Ending a freeze **early** is an action on the API rather than an edit here — see `active`.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned freeze id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters. Shown to whoever is refused a write.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"reason": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Why the freeze exists, up to 2000 characters. Also shown on refusal.",
			},
			"starts_at": schema.StringAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "RFC 3339 timestamp the freeze begins. Omit it to start immediately on " +
					"creation — the server stamps `now`, which is why this is Computed.\n\n" +
					"Note the asymmetry in the API: on an update an omitted start leaves the stored one alone, " +
					"while an omitted `reason` or `ends_at` clears it. That is the server's behaviour, and it " +
					"is what makes a freeze that started an hour ago safe to edit.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"ends_at": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "RFC 3339 timestamp the freeze ends. Omit it for an open-ended freeze that " +
					"runs until somebody ends it. Must be after `starts_at`.",
			},

			"active": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether the freeze is in effect. Operational state rather than " +
					"configuration: ending a freeze early is a `POST …/end` on the API, and this attribute " +
					"reports the outcome rather than driving it. A freeze ended early keeps its row, so it " +
					"stays under Terraform's management and reads back as `false`.",
			},
		},
	}
}

func (r *changeFreezeResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *changeFreezeResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan changeFreezeResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateChangeFreeze(ctx, changeFreezeInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to create change freeze", err.Error())
		return
	}

	state := changeFreezeStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *changeFreezeResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state changeFreezeResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetChangeFreeze(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read change freeze", err.Error())
		return
	}

	refreshed := changeFreezeStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *changeFreezeResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan changeFreezeResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state changeFreezeResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateChangeFreeze(ctx, state.ID.ValueString(), changeFreezeInputFrom(plan))
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Change freeze no longer exists",
				"The freeze was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update change freeze", err.Error())
		return
	}

	next := changeFreezeStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the freeze window outright, which lifts it if it was in
// effect. Ending one you want to keep a record of is the `/end` action instead.
func (r *changeFreezeResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state changeFreezeResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteChangeFreeze(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete change freeze", err.Error())
	}
}

func (r *changeFreezeResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func changeFreezeInputFrom(model changeFreezeResourceModel) iw.ChangeFreezeInput {
	return iw.ChangeFreezeInput{
		Name:     model.Name.ValueString(),
		Reason:   stringPtr(model.Reason),
		StartsAt: stringPtr(model.StartsAt),
		EndsAt:   stringPtr(model.EndsAt),
	}
}

func changeFreezeStateFrom(remote *iw.ChangeFreeze) changeFreezeResourceModel {
	return changeFreezeResourceModel{
		ID:       types.StringValue(remote.ID),
		Name:     types.StringValue(remote.Name),
		Reason:   stringValue(remote.Reason),
		StartsAt: types.StringValue(remote.StartsAt),
		EndsAt:   stringValue(remote.EndsAt),
		Active:   types.BoolValue(remote.Active),
	}
}
