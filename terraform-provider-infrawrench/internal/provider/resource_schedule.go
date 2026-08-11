package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*scheduleResource)(nil)
	_ resource.ResourceWithConfigure   = (*scheduleResource)(nil)
	_ resource.ResourceWithImportState = (*scheduleResource)(nil)
)

// NewScheduleResource constructs the infrawrench_schedule resource.
func NewScheduleResource() resource.Resource { return &scheduleResource{} }

type scheduleResource struct{ client *iw.Client }

type scheduleResourceModel struct {
	ID         types.String `tfsdk:"id"`
	ResourceID types.String `tfsdk:"resource_id"`
	AccountID  types.String `tfsdk:"account_id"`
	DaysOfWeek types.List   `tfsdk:"days_of_week"`
	StopTime   types.String `tfsdk:"stop_time"`
	StartTime  types.String `tfsdk:"start_time"`
	Timezone   types.String `tfsdk:"timezone"`
	Paused     types.Bool   `tfsdk:"paused"`

	NextTransitionAt types.String `tfsdk:"next_transition_at"`
}

func (r *scheduleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_schedule"
}

func (r *scheduleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Powers one resource off outside working hours and back on inside them — the " +
			"cheapest saving available on a development environment, and one nobody remembers to apply by " +
			"hand.\n\n" +
			"`days_of_week` names the days the resource is **worked on**: it is stopped at `stop_time` on " +
			"those days and started at `start_time`. A transition due while an `infrawrench_change_freeze` " +
			"is in effect is skipped rather than queued.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned schedule id. Use it with `terraform import`."),
			"resource_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Infrawrench resource id to power on and off. Resolve one with " +
					"`data.infrawrench_resources`. Fixed at creation — the update route does not carry it — so " +
					"changing it replaces the schedule.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"account_id": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Account the resource belongs to. Create-only, like `resource_id`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"days_of_week": schema.ListAttribute{
				Required:    true,
				ElementType: types.Int64Type,
				MarkdownDescription: "ISO weekdays the resource is worked on: 1 = Monday … 7 = Sunday. One to " +
					"seven entries, e.g. `[1, 2, 3, 4, 5]` for a weekday workload.",
			},
			"stop_time": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Wall-clock time the resource is powered **off**, 24-hour `\"HH:MM\"`, e.g. " +
					"`\"19:00\"`.",
			},
			"start_time": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Wall-clock time the resource is powered **on**, 24-hour `\"HH:MM\"`.",
			},
			"timezone": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "IANA timezone the wall-clock times are computed in, e.g. `Europe/London`. " +
					"Computed per transition rather than converted once, so the schedule keeps local office " +
					"hours across a daylight-saving change instead of drifting by an hour.",
			},
			"paused": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(false),
				MarkdownDescription: "A paused schedule keeps its timing and never fires.",
			},

			"next_transition_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "When the next transition is due. Null while paused.",
			},
		},
	}
}

func (r *scheduleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *scheduleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan scheduleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	days, diags := int64Slice(ctx, plan.DaysOfWeek)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateSleepSchedule(ctx, iw.SleepScheduleCreate{
		ResourceID: plan.ResourceID.ValueString(),
		AccountID:  plan.AccountID.ValueString(),
		DaysOfWeek: days,
		StopTime:   plan.StopTime.ValueString(),
		StartTime:  plan.StartTime.ValueString(),
		Timezone:   plan.Timezone.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to create schedule", err.Error())
		return
	}

	// The create route has no `paused` field — a new schedule is always active.
	// Honouring `paused = true` therefore takes a second call, which is done
	// here rather than left as a surprise diff on the next plan.
	if plan.Paused.ValueBool() {
		paused := true
		created, err = r.client.UpdateSleepSchedule(ctx, created.ID, iw.SleepScheduleUpdate{Paused: &paused})
		if err != nil {
			resp.Diagnostics.AddError("Unable to pause the new schedule", err.Error())
			return
		}
	}

	state, diags := scheduleStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *scheduleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state scheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetSleepSchedule(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read schedule", err.Error())
		return
	}

	refreshed, diags := scheduleStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *scheduleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan scheduleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state scheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	days, diags := int64Slice(ctx, plan.DaysOfWeek)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateSleepSchedule(ctx, state.ID.ValueString(), iw.SleepScheduleUpdate{
		DaysOfWeek: days,
		StopTime:   stringPtr(plan.StopTime),
		StartTime:  stringPtr(plan.StartTime),
		Timezone:   stringPtr(plan.Timezone),
		Paused:     boolPtr(plan.Paused),
	})
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Schedule no longer exists",
				"The schedule was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update schedule", err.Error())
		return
	}

	next, diags := scheduleStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the schedule. It does not power the resource back on: a
// resource that happens to be stopped when the schedule is removed stays
// stopped, because starting somebody's machine as a side effect of deleting a
// timetable is not a thing a plan should do.
func (r *scheduleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state scheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteSleepSchedule(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete schedule", err.Error())
	}
}

func (r *scheduleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// scheduleStateFrom maps a schedule into state.
//
// The read shape also carries the resource's and account's display names and a
// projected monthly saving. None of them is written into state: the names are
// facts about other objects and the projection is recomputed from trailing
// spend, so all three change without the schedule changing and would show as
// drift on a plan that alters nothing.
func scheduleStateFrom(ctx context.Context, remote *iw.SleepSchedule) (scheduleResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	days, d := int64List(ctx, remote.DaysOfWeek)
	diags.Append(d...)

	return scheduleResourceModel{
		ID:               types.StringValue(remote.ID),
		ResourceID:       types.StringValue(remote.ResourceID),
		AccountID:        types.StringValue(remote.AccountID),
		DaysOfWeek:       days,
		StopTime:         types.StringValue(remote.StopTime),
		StartTime:        types.StringValue(remote.StartTime),
		Timezone:         types.StringValue(remote.Timezone),
		Paused:           types.BoolValue(remote.Paused),
		NextTransitionAt: stringValue(remote.NextTransitionAt),
	}, diags
}
