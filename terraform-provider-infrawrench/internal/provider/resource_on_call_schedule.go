package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*onCallScheduleResource)(nil)
	_ resource.ResourceWithConfigure   = (*onCallScheduleResource)(nil)
	_ resource.ResourceWithImportState = (*onCallScheduleResource)(nil)
)

// NewOnCallScheduleResource constructs the infrawrench_on_call_schedule resource.
func NewOnCallScheduleResource() resource.Resource { return &onCallScheduleResource{} }

type onCallScheduleResource struct{ client *iw.Client }

type onCallScheduleResourceModel struct {
	ID                 types.String `tfsdk:"id"`
	Name               types.String `tfsdk:"name"`
	Timezone           types.String `tfsdk:"timezone"`
	RotationDays       types.Int64  `tfsdk:"rotation_days"`
	HandoffTime        types.String `tfsdk:"handoff_time"`
	StartDate          types.String `tfsdk:"start_date"`
	ParticipantUserIDs types.List   `tfsdk:"participant_user_ids"`
	Enabled            types.Bool   `tfsdk:"enabled"`
}

func (r *onCallScheduleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_on_call_schedule"
}

func (r *onCallScheduleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A rotation: an ordered list of people, a shift length, and the date the first " +
			"shift began. Every later handover is derived from those three rather than stored, so the " +
			"rotation keeps running without anybody maintaining a calendar.\n\n" +
			"What it is **for** is the `on-call` destination on `infrawrench_alert_routing`: a rule that " +
			"names a rotation reaches whoever is holding it when the alert fires, which is a fact no rule " +
			"written in advance can encode.\n\n" +
			"Covers — one person standing in for one shift — are deliberately not managed here. They are " +
			"decided the morning somebody wakes up ill, and a plan that reverted one would be actively " +
			"harmful; create them in the app.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned rotation id. Use it with `terraform import`, and in an " +
				"`infrawrench_alert_routing` destination's `schedule_id`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "What the rotation is called, 1–80 characters, e.g. `Platform primary`.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 80)},
			},
			"timezone": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "IANA zone `handoff_time` and `start_date` are read in, e.g. " +
					"`Europe/London`. Handovers are computed per shift rather than converted once, so the " +
					"rotation keeps changing hands at the local hour across a daylight-saving change.",
			},
			"rotation_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Days per shift, 1–31. `7` is the common case; `1` gives a daily " +
					"rotation.",
				Validators: []validatorInt64{between(1, 31)},
			},
			"handoff_time": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Wall-clock time in `timezone` at which the shift changes hands, " +
					"24-hour `\"HH:MM\"`, e.g. `\"09:00\"`.",
			},
			"start_date": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Calendar date in `timezone` the first shift begins on, `\"YYYY-MM-DD\"`. " +
					"Every later boundary is derived from it, so **moving this re-anchors the whole " +
					"rotation** rather than shifting only the next handover.",
			},
			"participant_user_ids": schema.ListAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Organization member ids, in rotation order — 1 to 60 of them. The " +
					"order is the rotation, so reordering the list re-plans every future shift, deliberately.",
				Validators: []validatorList{sizeBetween(1, 60)},
			},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "A disabled rotation resolves to nobody. A routing rule pointing at one " +
					"contributes nobody and the rule's other destinations still deliver — which is how a " +
					"rotation is stood down without editing every rule that names it.",
			},
		},
	}
}

func (r *onCallScheduleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *onCallScheduleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan onCallScheduleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	participants, diags := stringSlice(ctx, plan.ParticipantUserIDs)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateOnCallSchedule(ctx, iw.OnCallScheduleCreate{
		Name:               plan.Name.ValueString(),
		Timezone:           plan.Timezone.ValueString(),
		RotationDays:       plan.RotationDays.ValueInt64(),
		HandoffTime:        plan.HandoffTime.ValueString(),
		StartDate:          plan.StartDate.ValueString(),
		ParticipantUserIDs: participants,
		Enabled:            boolPtr(plan.Enabled),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to create on-call rotation", err.Error())
		return
	}

	state, diags := onCallScheduleStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *onCallScheduleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state onCallScheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetOnCallSchedule(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read on-call rotation", err.Error())
		return
	}

	refreshed, diags := onCallScheduleStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *onCallScheduleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan onCallScheduleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state onCallScheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	participants, diags := stringSlice(ctx, plan.ParticipantUserIDs)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateOnCallSchedule(ctx, state.ID.ValueString(), iw.OnCallScheduleUpdate{
		Name:               stringPtr(plan.Name),
		Timezone:           stringPtr(plan.Timezone),
		RotationDays:       int64Ptr(plan.RotationDays),
		HandoffTime:        stringPtr(plan.HandoffTime),
		StartDate:          stringPtr(plan.StartDate),
		ParticipantUserIDs: participants,
		Enabled:            boolPtr(plan.Enabled),
	})
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"On-call rotation no longer exists",
				"The rotation was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update on-call rotation", err.Error())
		return
	}

	next, diags := onCallScheduleStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the rotation. Rules that named it are left alone: a routing
// rule whose rotation has gone contributes nobody, which is visible on the next
// plan of the routing resource, where rewriting somebody's escalation path as a
// side effect of deleting a rota would not be.
func (r *onCallScheduleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state onCallScheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteOnCallSchedule(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete on-call rotation", err.Error())
	}
}

func (r *onCallScheduleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// onCallScheduleStateFrom maps a rotation into state.
//
// The read shape carries each participant's name and email alongside their id.
// Neither is written into state: both are facts about a member, not about the
// rotation, and a rename would otherwise show as drift on a plan that changes
// nothing. The ids are, and in order — that order *is* the rotation.
func onCallScheduleStateFrom(ctx context.Context, remote *iw.OnCallSchedule) (onCallScheduleResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	ids := make([]string, 0, len(remote.Participants))
	for _, participant := range remote.Participants {
		ids = append(ids, participant.UserID)
	}
	participants, d := stringList(ctx, ids)
	diags.Append(d...)

	return onCallScheduleResourceModel{
		ID:                 types.StringValue(remote.ID),
		Name:               types.StringValue(remote.Name),
		Timezone:           types.StringValue(remote.Timezone),
		RotationDays:       types.Int64Value(remote.RotationDays),
		HandoffTime:        types.StringValue(remote.HandoffTime),
		StartDate:          types.StringValue(remote.StartDate),
		ParticipantUserIDs: participants,
		Enabled:            types.BoolValue(remote.Enabled),
	}, diags
}
